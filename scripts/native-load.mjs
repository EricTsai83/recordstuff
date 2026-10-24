/**
 * `node scripts/native-load.mjs [module]`: loads the native capture engine as the capture host does (plan 076,
 * step 6) and checks that it offers what the host calls, without capturing anything, so it needs no screen permission
 * and no desktop. The module defaults to the build's `out/native/recordstuff-capture.node`; the Windows installer
 * smoke passes the installed copy. Exit 0 when it loads, 1 otherwise.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** What native-host-process.ts calls on an engine. */
export const ENGINE_METHODS = ["probe", "prepare", "record", "stop", "finish", "cancel", "microphones", "cameras", "onPreview", "setCameraLayout", "setCameraPreview", "setPreviewRate", "requestPreviewKey", "watchLevels", "setMuted", "setGains", "diagnostics"];

/** The methods `module` lacks; throws when it has no NativeCapture class. */
export function missingMethods(module) {
  if (typeof module?.NativeCapture !== "function") throw new Error("the module exports no NativeCapture class");
  return ENGINE_METHODS.filter((name) => typeof module.NativeCapture.prototype[name] !== "function");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/native/recordstuff-capture.node"));
  try {
    if (!existsSync(file)) throw new Error(`no module at ${file}: build it with \`pnpm build\` (needs Rust)`);
    const module = createRequire(import.meta.url)(file);
    const missing = missingMethods(module);
    if (missing.length) throw new Error(`NativeCapture lacks ${missing.join(", ")}`);
    // Constructing one registers its event callback with Node, which keeps the process alive: exit explicitly.
    new module.NativeCapture(() => {});
    console.log(`native engine loads: ${file}`);
    process.exit(0);
  } catch (error) {
    console.error(`native engine does not load: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
