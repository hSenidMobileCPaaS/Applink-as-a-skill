#!/usr/bin/env node
/**
 * Conformance: run every language template against the validating mock and
 * prove, per language, that it puts exactly the documented bodies on the wire
 * and reads every kind of response correctly.
 *
 *   node tests/conformance/run.mjs [--only=python,go] [--require-all]
 *
 * For each language it builds the template exactly as written and runs its
 * driver three times:
 *
 *   sample    every wrapper, against each endpoint's published response — the
 *             driver asserts what it parsed (P1003 and the exact 31-digit
 *             requestCorrelator, subscriptionStatus by prefix, baseSize 0, …)
 *   variant   the same calls against responses carrying only the fields the
 *             next step needs, numeric strings as bare numbers, and an unknown
 *             field — the parser must survive all three
 *   fail      failure bodies (statusCode + statusDetail only) — each must raise
 *             the template's typed error with that statusCode
 *
 * Every request body from every run must pass the catalog's validation, and the
 * sample run must reach all eleven endpoints.
 *
 * Toolchains are found on PATH or through these variables; a language whose
 * toolchain is missing is skipped (a failure with --require-all):
 *
 *   APPLINK_CONFORMANCE_PYTHON      python executable
 *   APPLINK_CONFORMANCE_GO          go executable
 *   APPLINK_CONFORMANCE_JAVA_HOME   JDK directory
 *   APPLINK_CONFORMANCE_JAVA_CP     Jackson jars (jackson-databind, -core, -annotations), path-separated
 *   APPLINK_CONFORMANCE_PHP         php executable (needs the curl extension)
 *   APPLINK_CONFORMANCE_PHP_ARGS    extra php arguments, e.g. "-d extension=curl"
 *   APPLINK_CONFORMANCE_DOTNET      dotnet executable (an SDK, 8.0 or later)
 *
 * TypeScript runs on this Node, which must strip types natively (22.18+ / 23.6+).
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { catalog, repoRoot } from "../../tools/catalog.mjs";

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const requireAll = args.includes("--require-all");
const here = join(repoRoot, "tests", "conformance");
const exe = process.platform === "win32" ? ".exe" : "";
const PORT = Number(process.env.APPLINK_MOCK_PORT || 18089);
const MOCK = `http://127.0.0.1:${PORT}`;
const SCENARIOS = ["sample", "variant", "fail"];

const ENDPOINTS = Object.fromEntries(
  [...new Map(catalog.services.map((s) => [s.envVar, s.path]))].map(([v, p]) => [v, p])
);

function envFor(scenario) {
  const base = scenario === "sample" ? MOCK : `${MOCK}/${scenario}`;
  const env = { ...process.env, APPLINK_APP_ID: "APP_000001", APPLINK_PASSWORD: "conformance-only" };
  for (const [name, path] of Object.entries(ENDPOINTS)) env[name] = base + path;
  return { env, base };
}

const works = (cmd, versionArgs = ["--version"]) => {
  if (!cmd) return false;
  const r = spawnSync(cmd, versionArgs, { encoding: "utf8" });
  return r.status === 0;
};

const run = (cmd, argv, options = {}) =>
  spawnSync(cmd, argv, { encoding: "utf8", timeout: 180_000, ...options });

/* ── Languages ───────────────────────────────────────────────────────────── */

const languages = {
  typescript() {
    if (!process.features?.typescript) return { skip: `Node ${process.version} cannot strip types (needs 22.18+ / 23.6+)` };
    return {
      run: (scenario) =>
        run(process.execPath, ["--no-warnings", "--import", pathToFileURL(join(here, "typescript", "resolve-ts.mjs")).href, join(here, "typescript", "drive.ts"), envFor(scenario).base, scenario], { env: envFor(scenario).env }),
    };
  },

  python() {
    const python = [process.env.APPLINK_CONFORMANCE_PYTHON, "python3", "python"].find((p) => works(p));
    if (!python) return { skip: "no python on PATH (set APPLINK_CONFORMANCE_PYTHON)" };
    return {
      run: (scenario) =>
        run(python, ["-W", "error", join(here, "python", "drive.py"), envFor(scenario).base, scenario], {
          env: { ...envFor(scenario).env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
        }),
    };
  },

  go() {
    const go = [process.env.APPLINK_CONFORMANCE_GO, "go"].find((g) => works(g, ["version"]));
    if (!go) return { skip: "no go on PATH (set APPLINK_CONFORMANCE_GO)" };
    const dir = mkdtempSync(join(tmpdir(), "applink-go-"));
    mkdirSync(join(dir, "applink"));
    for (const f of readdirSync(join(repoRoot, "templates", "go"))) {
      copyFileSync(join(repoRoot, "templates", "go", f), join(dir, "applink", f));
    }
    copyFileSync(join(here, "go", "main.go"), join(dir, "main.go"));
    writeFileSync(join(dir, "go.mod"), "module conformance\n\ngo 1.21\n");
    const env = { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" };
    const vet = run(go, ["vet", "./..."], { cwd: dir, env });
    if (vet.status !== 0) return { build: vet };
    const build = run(go, ["build", "-o", `drive${exe}`, "."], { cwd: dir, env });
    if (build.status !== 0) return { build };
    return { run: (scenario) => run(join(dir, `drive${exe}`), [envFor(scenario).base, scenario], { env: envFor(scenario).env }), cleanup: dir };
  },

  java() {
    const home = process.env.APPLINK_CONFORMANCE_JAVA_HOME;
    const javac = home ? join(home, "bin", `javac${exe}`) : "javac";
    const java = home ? join(home, "bin", `java${exe}`) : "java";
    if (!works(javac, ["-version"])) return { skip: "no javac (set APPLINK_CONFORMANCE_JAVA_HOME)" };
    const cp = process.env.APPLINK_CONFORMANCE_JAVA_CP;
    if (!cp) return { skip: "no Jackson on the classpath (set APPLINK_CONFORMANCE_JAVA_CP)" };
    const out = mkdtempSync(join(tmpdir(), "applink-java-"));
    const build = run(javac, [
      "-Xlint:all", "-Werror", "-encoding", "UTF-8", "-d", out, "-cp", cp,
      join(repoRoot, "templates", "java", "ApplinkClient.java"),
      join(repoRoot, "templates", "java", "ApplinkConfig.java"),
      join(here, "java", "Drive.java"),
    ]);
    if (build.status !== 0) return { build };
    return {
      run: (scenario) => run(java, ["-Dfile.encoding=UTF-8", "-cp", `${out}${delimiter}${cp}`, "Drive", envFor(scenario).base, scenario], { env: envFor(scenario).env }),
      cleanup: out,
    };
  },

  php() {
    const php = [process.env.APPLINK_CONFORMANCE_PHP, "php"].find((p) => works(p, ["-v"]));
    if (!php) return { skip: "no php on PATH (set APPLINK_CONFORMANCE_PHP)" };
    const extra = (process.env.APPLINK_CONFORMANCE_PHP_ARGS || "").split(" ").filter(Boolean);
    const lint = ["ApplinkConfig.php", "ApplinkClient.php", "callbacks.php"]
      .map((f) => run(php, ["-l", join(repoRoot, "templates", "php", f)]))
      .find((r) => r.status !== 0);
    if (lint) return { build: lint };
    return { run: (scenario) => run(php, [...extra, join(here, "php", "drive.php"), envFor(scenario).base, scenario], { env: envFor(scenario).env }) };
  },

  csharp() {
    const dotnet = [process.env.APPLINK_CONFORMANCE_DOTNET, "dotnet"].find((d) => d && run(d, ["--list-sdks"]).stdout?.trim());
    if (!dotnet) return { skip: "no .NET SDK (set APPLINK_CONFORMANCE_DOTNET)" };
    const out = mkdtempSync(join(tmpdir(), "applink-cs-"));
    const build = run(dotnet, ["build", join(here, "csharp", "Drive.csproj"), "-o", out, "-nologo", "-v", "q", "-warnaserror"], {
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" },
    });
    if (build.status !== 0) return { build };
    return { run: (scenario) => run(dotnet, [join(out, "Drive.dll"), envFor(scenario).base, scenario], { env: envFor(scenario).env }), cleanup: out };
  },
};

/* ── Mock ────────────────────────────────────────────────────────────────── */

const mock = spawn(process.execPath, [join(repoRoot, "scripts", "mock-applink.mjs"), "--port", String(PORT), "--quiet"], { stdio: "inherit" });
const report = async () => (await fetch(`${MOCK}/__report`)).json();
for (let i = 0; ; i++) {
  try {
    await report();
    break;
  } catch {
    if (i > 50) throw new Error("the mock did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

const results = [];
const tail = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim().split("\n").slice(-15).join("\n");

for (const [name, setup] of Object.entries(languages)) {
  if (only && !only.includes(name)) continue;
  const lang = setup();
  if (lang.skip) {
    results.push({ name, status: "skipped", detail: lang.skip });
    continue;
  }
  if (lang.build) {
    results.push({ name, status: "failed", detail: `build failed:\n${tail(lang.build)}` });
    continue;
  }

  const problems = [];
  for (const scenario of SCENARIOS) {
    const before = (await report()).length;
    const r = lang.run(scenario);
    const seen = (await report()).slice(before);
    if (r.status !== 0) problems.push(`${scenario}: driver failed\n${tail(r)}`);
    for (const req of seen.filter((x) => x.verdict !== "OK")) {
      problems.push(`${scenario}: bad body for ${req.service ?? req.path}: ${req.problems.join("; ")}\n  ${req.body}`);
    }
    // The drivers broadcast on purpose; any other warning — an unrecognised or
    // empty field, a "+" that should have been normalised — is a finding.
    for (const req of seen) {
      const findings = req.warnings.filter((w) => !w.startsWith("tel:all broadcasts"));
      if (findings.length) problems.push(`${scenario}: ${req.service}: ${findings.join("; ")}`);
    }
    if (scenario === "sample") {
      const missing = catalog.services.map((s) => s.id).filter((id) => !seen.some((x) => x.service === id));
      if (missing.length) problems.push(`sample: never called ${missing.join(", ")}`);
    }
    if (!seen.length) problems.push(`${scenario}: no request reached the mock`);
  }
  if (lang.cleanup) rmSync(lang.cleanup, { recursive: true, force: true });
  results.push({ name, status: problems.length ? "failed" : "passed", detail: problems.join("\n") });
}

mock.kill();

console.log("\nApplink template conformance\n");
for (const r of results) {
  const mark = { passed: "✓", failed: "✗", skipped: "–" }[r.status];
  console.log(`  ${mark} ${r.name.padEnd(11)} ${r.status}${r.status === "skipped" ? `  (${r.detail})` : ""}`);
  if (r.status === "failed") console.log(r.detail.replace(/^/gm, "      "));
}
const failed = results.filter((r) => r.status === "failed" || (requireAll && r.status === "skipped"));
console.log(`\n  ${results.filter((r) => r.status === "passed").length} passed, ${results.filter((r) => r.status === "failed").length} failed, ${results.filter((r) => r.status === "skipped").length} skipped\n`);
process.exit(failed.length ? 1 : 0);
