// Resolve the TypeScript template's extensionless relative imports to .ts
// files, the way a bundler or tsconfig would, so Node can run it directly.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        try {
          return await next(specifier, context);
        } catch (err) {
          if (specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier)) {
            return next(specifier + ".ts", context);
          }
          throw err;
        }
      }
    `)
);
