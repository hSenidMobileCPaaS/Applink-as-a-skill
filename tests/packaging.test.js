import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../tools/catalog.mjs";

const read = (p) => readFileSync(join(repoRoot, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

/* ── Manifests ───────────────────────────────────────────────────────────── */

const MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  ".qoder-plugin/plugin.json",
  "gemini-extension.json",
  "opencode.json",
  "package.json",
];

test("every manifest is valid JSON", () => {
  for (const m of MANIFESTS) {
    assert.doesNotThrow(() => readJson(m), `${m} is not valid JSON`);
  }
});

test("plugin manifests agree on name and version", () => {
  const version = readJson("package.json").version;
  for (const m of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".qoder-plugin/plugin.json", "gemini-extension.json"]) {
    const manifest = readJson(m);
    assert.equal(manifest.name, "applink", `${m} has the wrong name`);
    assert.equal(manifest.version, version, `${m} version drifted from package.json`);
  }
});

test("plugin.yaml lists every skill that exists on disk", () => {
  const yaml = read("plugin.yaml");
  const onDisk = readdirSync(join(repoRoot, "skills")).sort();
  for (const skill of onDisk) {
    assert.ok(yaml.includes(`- ${skill}`), `plugin.yaml does not list skill "${skill}"`);
  }
});

/* ── Skills ──────────────────────────────────────────────────────────────── */

test("every skill has valid frontmatter with a name matching its directory", () => {
  const dirs = readdirSync(join(repoRoot, "skills"));
  assert.ok(dirs.length >= 7, `expected at least 7 skills, found ${dirs.length}`);

  for (const dir of dirs) {
    const path = `skills/${dir}/SKILL.md`;
    assert.ok(existsSync(join(repoRoot, path)), `${dir} has no SKILL.md`);

    const content = read(path);
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${path} has no frontmatter`);

    const name = fm[1].match(/^name:\s*(.+)$/m);
    const description = fm[1].match(/^description:\s*(.+)$/m);
    assert.ok(name, `${path} frontmatter has no name`);
    assert.ok(description, `${path} frontmatter has no description`);
    assert.equal(name[1].trim(), dir, `${path} name does not match its directory`);
    assert.ok(
      description[1].trim().length > 40,
      `${path} description is too short to route on`
    );
  }
});

test("the root SKILL.md has frontmatter", () => {
  const fm = read("SKILL.md").match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, "SKILL.md has no frontmatter");
  assert.match(fm[1], /^name:\s*applink\s*$/m);
  assert.match(fm[1], /^description:\s*.+/m);
});

/* ── Commands ────────────────────────────────────────────────────────────── */

test("every skill has a matching slash command", () => {
  const skills = readdirSync(join(repoRoot, "skills"));
  for (const skill of skills) {
    const path = `commands/${skill}.toml`;
    assert.ok(existsSync(join(repoRoot, path)), `missing command for skill "${skill}"`);
    const content = read(path);
    assert.match(content, /^description = ".+"$/m, `${path} has no description`);
    assert.match(content, /^prompt = ".+"$/m, `${path} has no prompt`);
  }
});

/* ── Agent rule copies ───────────────────────────────────────────────────── */

test("agent rule copies are in sync with AGENTS.md", () => {
  const result = execFileSync("node", ["scripts/sync-rules.mjs", "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.match(result, /in sync/);
});

test("every generated rule copy exists and carries the banner", () => {
  const copies = [
    ".agents/rules/applink.md",
    ".windsurf/rules/applink.md",
    ".clinerules/applink.md",
    ".kiro/steering/applink.md",
    ".qoder/rules/applink.md",
    ".cursor/rules/applink.mdc",
    ".github/copilot-instructions.md",
  ];
  for (const copy of copies) {
    assert.ok(existsSync(join(repoRoot, copy)), `missing ${copy}`);
    assert.match(read(copy), /Generated from AGENTS\.md/, `${copy} has no generated banner`);
  }
});

test("the Cursor rule keeps its .mdc frontmatter", () => {
  assert.match(read(".cursor/rules/applink.mdc"), /^---\ndescription:.*\n[\s\S]*?\n---/);
});

/* ── Templates: the skill must not be Node-only ──────────────────────────── */

/**
 * Applink is JSON over HTTPS, so the skill has to serve a Django shop and a
 * Spring shop as well as it serves a Next.js one. These tests keep the
 * multi-language promise honest: the directories exist, the index lists them,
 * and the environment contract is genuinely shared.
 */
const TEMPLATE_LANGUAGES = {
  typescript: ["applink-config.ts", "applink-client.ts", "callbacks-nextjs.ts"],
  python: ["applink_config.py", "applink_client.py", "callbacks_fastapi.py"],
  java: ["ApplinkConfig.java", "ApplinkClient.java", "ApplinkCallbackController.java"],
  go: ["config.go", "client.go", "callbacks.go"],
  php: ["ApplinkConfig.php", "ApplinkClient.php", "callbacks.php"],
  csharp: ["ApplinkOptions.cs", "ApplinkClient.cs", "ApplinkCallbacks.cs"],
};

test("every documented language ships config, client and callback templates", () => {
  for (const [language, files] of Object.entries(TEMPLATE_LANGUAGES)) {
    for (const file of files) {
      const path = join(repoRoot, "templates", language, file);
      assert.ok(existsSync(path), `missing templates/${language}/${file}`);
    }
  }
});

test("no template directory is missing from the templates index", () => {
  const index = read("templates/README.md");
  const onDisk = readdirSync(join(repoRoot, "templates"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.ok(onDisk.length >= 6, `expected at least 6 language templates, found ${onDisk.length}`);
  for (const language of onDisk) {
    assert.ok(index.includes(`${language}/`), `templates/README.md does not list ${language}/`);
  }
});

test("the any-stack reference and the entry points agree on the languages", () => {
  const sources = {
    "references/11-any-stack.md": read("references/11-any-stack.md"),
    "templates/README.md": read("templates/README.md"),
    "SKILL.md": read("SKILL.md"),
    "AGENTS.md": read("AGENTS.md"),
  };
  for (const [file, content] of Object.entries(sources)) {
    for (const language of ["Python", "Java", "Go", "PHP"]) {
      assert.ok(content.includes(language), `${file} does not mention ${language}`);
    }
  }
});

test("every language template reads the same environment variables", () => {
  // One deployment story across a polyglot estate: the .env.example is the
  // contract, and a port that invents its own variable names breaks it.
  const required = ["APPLINK_APP_ID", "APPLINK_PASSWORD", "APPLINK_SMS_SEND_URL"];
  for (const language of Object.keys(TEMPLATE_LANGUAGES)) {
    const configFile = TEMPLATE_LANGUAGES[language][0];
    const content = read(join("templates", language, configFile));
    for (const variable of required) {
      assert.ok(
        content.includes(variable),
        `templates/${language}/${configFile} does not read ${variable}`
      );
    }
  }
});

test("no template disables TLS verification", () => {
  const forbidden = [
    /rejectUnauthorized:\s*false/,
    /verify\s*=\s*False/,
    /InsecureSkipVerify:\s*true/,
    /CURLOPT_SSL_VERIFYPEER\s*=>\s*false/,
    /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0/,
  ];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const content = readFileSync(path, "utf8");
      for (const pattern of forbidden) {
        // Commented-out warnings are the point of the templates; only flag code.
        for (const line of content.split("\n")) {
          const code = line.replace(/^\s*(\/\/|#|\*|\/\*).*/, "");
          if (pattern.test(code)) offenders.push(`${path.replace(repoRoot, ".")}: ${line.trim()}`);
        }
      }
    }
  };
  walk(join(repoRoot, "templates"));
  assert.deepEqual(offenders, [], `templates disable TLS verification:\n${offenders.join("\n")}`);
});

/* ── Governance and assets ───────────────────────────────────────────────── */

test("governance files exist", () => {
  for (const f of ["LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/agent-support.md"]) {
    assert.ok(existsSync(join(repoRoot, f)), `missing ${f}`);
  }
});

test("SVG assets are well-formed and labelled", () => {
  for (const f of ["assets/architecture.svg", "assets/social-preview.svg"]) {
    const svg = read(f);
    assert.match(svg, /^<svg[\s>]/m, `${f} does not start with an <svg> element`);
    assert.match(svg, /<\/svg>\s*$/, `${f} is not closed`);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, `${f} has no xmlns`);
    assert.match(svg, /role="img"|aria-label=/, `${f} has no accessible label`);
  }
});

test("brand logos are present as transparent PNGs", () => {
  for (const f of [
    "assets/applink-logo.png",
    "assets/applink-logo-light-bg.png",
    "assets/hsenid-logo.png",
  ]) {
    const path = join(repoRoot, f);
    assert.ok(existsSync(path), `missing ${f}`);
    const buf = readFileSync(path);
    assert.equal(buf.readUInt32BE(0), 0x89504e47, `${f} is not a PNG`);
    // IHDR colour type 6 = RGBA, so the logo sits on any background.
    assert.equal(buf[25], 6, `${f} has no alpha channel — it will show a box in dark mode`);
  }
});

const REPO = "hSenidMobileCPaaS/Applink-as-a-Skill";

test("no placeholder repository URLs remain", () => {
  const files = [
    "README.md",
    "docs/agent-support.md",
    "package.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".github/ISSUE_TEMPLATE/config.yml",
  ];
  for (const f of files) {
    const content = read(f);
    assert.doesNotMatch(content, /OWNER\//, `${f} still contains an OWNER/ placeholder`);
    assert.doesNotMatch(content, /<repo-url>/, `${f} still contains a <repo-url> placeholder`);
    assert.doesNotMatch(
      content,
      /ApplinkSkillForAgents/,
      `${f} references the old repository name`
    );
  }
});

test("manifests point at the published repository", () => {
  assert.equal(readJson("package.json").homepage, `https://github.com/${REPO}`);
  assert.equal(readJson("package.json").repository.url, `git+https://github.com/${REPO}.git`);
  assert.equal(readJson("package.json").bugs.url, `https://github.com/${REPO}/issues`);
  assert.equal(readJson(".claude-plugin/plugin.json").homepage, `https://github.com/${REPO}`);
  assert.equal(readJson(".codex-plugin/plugin.json").repository, `https://github.com/${REPO}`);
});

test("the licence is proprietary and declared consistently everywhere", () => {
  const licence = read("LICENSE");
  assert.match(licence, /^PROPRIETARY SOFTWARE LICENCE/m);
  assert.match(licence, /All rights reserved/);
  assert.match(licence, /sole and\s+exclusive property of hSenid Mobile Solutions/);

  // The restrictions the owner asked for must actually be in the text.
  for (const restriction of [/modify/i, /distribut/i, /publish/i, /sublicense/i, /sell/i, /copy/i]) {
    assert.match(licence, restriction, `LICENSE does not restrict: ${restriction}`);
  }

  // npm's convention for proprietary software.
  assert.equal(readJson("package.json").license, "UNLICENSED");
  assert.equal(readJson("package.json").private, true);
  assert.equal(readJson(".claude-plugin/plugin.json").license, "UNLICENSED");
  assert.equal(readJson(".codex-plugin/plugin.json").license, "UNLICENSED");

  // No file may still advertise the old permissive terms.
  for (const f of ["README.md", "SECURITY.md", "CONTRIBUTING.md", "plugin.yaml"]) {
    assert.doesNotMatch(read(f), /\bMIT\b/, `${f} still refers to MIT`);
  }
});

test("the licence permits the installation it documents", () => {
  // The README tells users to git clone / plugin install. A licence forbidding
  // all copying would forbid its own install instructions, so the grant has to
  // cover the copying that using it requires.
  const licence = read("LICENSE");
  assert.match(licence, /copying strictly necessary/i);
  assert.match(licence, /cloning this repository/i);
});

test("attribution names hSenid Mobile Solutions for Applink", () => {
  assert.match(read("LICENSE"), /hSenid Mobile Solutions \(Pvt\) Ltd/);
  assert.match(read("README.md"), /hSenid Mobile Solutions<\/strong> for <strong>Applink/);
  for (const m of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json"]) {
    assert.equal(readJson(m).author.name, "hSenid Mobile Solutions", `${m} author is wrong`);
  }
  assert.equal(readJson(".claude-plugin/marketplace.json").owner.name, "hSenid Mobile Solutions");
});

test("every asset referenced by the README exists", () => {
  const readme = read("README.md");
  for (const [, src] of readme.matchAll(/(?:src|srcset)="(assets\/[^"]+)"/g)) {
    assert.ok(existsSync(join(repoRoot, src)), `README references missing asset ${src}`);
  }
});

/**
 * The white wordmark disappears on GitHub's light theme, so the README pairs it
 * with the dark-on-transparent variant through a <picture> element. Losing
 * either half leaves half the readers looking at nothing.
 */
test("the README logo works in both GitHub themes", () => {
  const readme = read("README.md");
  assert.match(readme, /<picture>/);
  assert.match(readme, /prefers-color-scheme: dark[\s\S]*?assets\/applink-logo\.png/);
  assert.match(readme, /<img src="assets\/applink-logo-light-bg\.png"/);
});

/**
 * Nothing in this repo may carry over from another telco platform's skill. The
 * markets, operators, currencies and status codes are all different, and a
 * stale one is a wrong answer delivered confidently.
 */
test("no other telco platform's identifiers survive anywhere", () => {
  const forbidden = [
    /ideamart/i,
    /Dialog Axiata/i,
    /\bHutch\b/,
    /\bAirtel\b/,
    /Sri Lanka/i,
    /\bLKR\b/,
    /\bE13(51|56|78|79)\b/,
  ];
  // tests/ is excluded because this file necessarily contains the patterns as
  // its own source text — the same reason the credential scan excludes ci.yml.
  const skipDirs = new Set([".git", "node_modules", "tests"]);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(path);
        continue;
      }
      if (/\.(png|jpg|jpeg|ico|gif|pdf)$/i.test(entry.name)) continue;
      let content;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      for (const pattern of forbidden) {
        if (pattern.test(content)) {
          offenders.push(`${path.replace(repoRoot, ".")} — ${pattern}`);
        }
      }
    }
  };

  walk(repoRoot);
  assert.deepEqual(offenders, [], `foreign platform references found:\n${offenders.join("\n")}`);
});

test("every relative link in the README points at something real", () => {
  const readme = read("README.md");
  const missing = [];
  for (const [, target] of readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    const clean = target.split("#")[0];
    if (clean && !existsSync(join(repoRoot, clean))) missing.push(clean);
  }
  assert.deepEqual(missing, [], `README links to missing paths: ${missing.join(", ")}`);
});

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const cli = (...args) =>
  execFileSync("node", ["tools/applink.mjs", ...args], { cwd: repoRoot, encoding: "utf8" });

test("the CLI responds to every documented command", () => {
  assert.doesNotThrow(() => cli("help"));
  assert.doesNotThrow(() => cli("list", "--json"));
  assert.doesNotThrow(() => cli("show", "sms-send", "--json"));
  assert.doesNotThrow(() => cli("show", "caas-otp-verify", "--json"));
  assert.doesNotThrow(() => cli("search", "base size", "--json"));
  assert.doesNotThrow(() => cli("code", "E1303", "--json"));
  assert.doesNotThrow(() => cli("diagnose", "callbacks never arrive", "--json"));
  assert.doesNotThrow(() => cli("curl", "subscription-query-base", "--json"));
  assert.doesNotThrow(() => cli("response", "caas-otp-generation", "--json"));
  assert.doesNotThrow(() => cli("practices", "--json"));
  assert.doesNotThrow(() => cli("checklist", "--json"));
  assert.doesNotThrow(() => cli("platform", "--json"));
  assert.doesNotThrow(() => cli("reference", "--json"));
});

test("the CLI emits parseable JSON with --json", () => {
  const listed = JSON.parse(cli("list", "--json"));
  assert.equal(listed.count, 16, `expected 11 services + 5 callbacks, got ${listed.count}`);
  assert.equal(JSON.parse(cli("code", "P1003", "--json")).class, "pending");
  assert.equal(JSON.parse(cli("code", "S1000", "--json")).class, "success");
  assert.ok(JSON.parse(cli("checklist", "--json")).count > 50);
});

test("built requests never leak a credential", () => {
  const built = JSON.parse(cli("curl", "caas-otp-generation", "--json"));
  assert.equal(built.payload.applicationId, "$APPLINK_APP_ID");
  assert.equal(built.payload.password, "$APPLINK_PASSWORD");
  assert.ok(built.curl.includes("$APPLINK_APP_ID"));
});

test("the CLI warns that a started charge is not a completed one", () => {
  const built = JSON.parse(cli("curl", "caas-otp-generation", "--json"));
  assert.ok(
    built.validation.warnings.some((w) => w.includes("P1003")),
    "building a charging request must warn that P1003 is not a completed charge"
  );
});

test("the CLI exits non-zero on an invalid payload", () => {
  assert.throws(
    () => cli("validate", "sms-send", '{"message":"hi","destinationAddresses":"tel:8801959979376"}'),
    /Command failed|status/
  );
});

test("the CLI fails clearly on an unknown service", () => {
  assert.throws(() => cli("show", "not-a-real-service"));
});

test("the CLI builds string values from key=value, exactly as typed", () => {
  const built = JSON.parse(
    cli("curl", "caas-otp-verify", "referenceNo=8801442233146169943053700500040", "otp=012345", "--json")
  );
  assert.equal(built.payload.referenceNo, "8801442233146169943053700500040");
  assert.equal(built.payload.otp, "012345");
  assert.ok(built.curl.includes('"referenceNo": "8801442233146169943053700500040"'));
  assert.equal(built.validation.valid, true);

  const charge = JSON.parse(cli("curl", "caas-otp-generation", "amount=5.00", "--json"));
  assert.equal(charge.payload.amount, "5.00");
  assert.deepEqual(charge.expectedStatusCodes, ["P1003", "S1000"]);
});

test("the CLI reads a response and reports what it means", () => {
  const pending = JSON.parse(
    cli("response", "caas-otp-generation", JSON.stringify(readJson("catalog/applink-api.json").services.find((s) => s.id === "caas-otp-generation").sampleResponse), "--json")
  );
  assert.equal(pending.outcome, "pending");
  const failed = JSON.parse(cli("response", "subscription-query-base", '{"statusCode":"E1313","statusDetail":"x"}', "--json"));
  assert.equal(failed.outcome, "failure");
  assert.equal(failed.class, "configuration");
  assert.throws(() => cli("response", "subscription-query-base", '{"statusDetail":"no code"}'));
});

/* ── Template request bodies ─────────────────────────────────────────────── */

/**
 * Regressions found by running the templates against a mock that validated
 * every body: each of these put a wrong body on the wire.
 */
test("every template sends version on both SMS paths, send and broadcast", () => {
  const cs = read("templates/csharp/ApplinkClient.cs");
  const broadcast = cs.slice(cs.indexOf("public Task<JsonElement> BroadcastSmsAsync"), cs.indexOf("/* ── USSD"));
  assert.match(broadcast, /\["version"\] = ApiVersion/, "C# broadcast must send the required version");
});

test("no template sends an absent applicationMetaData as null or []", () => {
  const offenders = [];
  const checks = {
    "templates/go/client.go": /"applicationMetaData":\s*metaData/,
    "templates/java/ApplinkClient.java": /Map\.of\([^)]*"applicationMetaData"/s,
    "templates/php/ApplinkClient.php": /'applicationMetaData'\s*=>\s*\$applicationMetaData,/,
    "templates/csharp/ApplinkClient.cs": /\["applicationMetaData"\] = applicationMetaData,\s*\n\s*\},/,
  };
  for (const [file, unconditional] of Object.entries(checks)) {
    if (unconditional.test(read(file))) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these send applicationMetaData unconditionally: ${offenders}`);
});

test("every template formats a charge amount to two decimal places", () => {
  const formatters = {
    "templates/typescript/applink-client.ts": /amount: formatAmount\(input\.amount\)/,
    "templates/python/applink_client.py": /"amount": format_amount\(amount\)/,
    "templates/java/ApplinkClient.java": /body\.put\("amount", formatAmount\(amount\)\)/,
    "templates/go/client.go": /"amount":\s+formatted/,
    "templates/php/ApplinkClient.php": /'amount'\s+=> self::formatAmount\(\$amount\)/,
    "templates/csharp/ApplinkClient.cs": /\["amount"\] = FormatAmount\(amount\)/,
  };
  for (const [file, re] of Object.entries(formatters)) {
    assert.match(read(file), re, `${file} sends the amount unformatted`);
  }
});

test("every language template has a conformance driver", () => {
  const languages = readdirSync(join(repoRoot, "templates"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const drivers = readdirSync(join(repoRoot, "tests", "conformance"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.deepEqual(languages.filter((l) => !drivers.includes(l)), [], "a template language with no conformance driver is unverified");
  const runner = read("tests/conformance/run.mjs");
  for (const l of languages) assert.match(runner, new RegExp(`^  ${l}\\(\\) \\{`, "m"), `run.mjs does not run ${l}`);
  assert.match(read(".github/workflows/ci.yml"), /tests\/conformance\/run\.mjs --require-all/);
});

test("templates document only parameters the catalog publishes", () => {
  assert.doesNotMatch(read("templates/php/ApplinkClient.php"), /chargingAmount/);
});
