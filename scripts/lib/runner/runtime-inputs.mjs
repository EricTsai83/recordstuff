// What a development bundle is built from, so `open:app` can tell a fresh bundle from a stale one (plan 061).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Inputs of `electron-vite build` and `electron-builder`: sources, packaging resources and the
 * configuration and lockfile that choose the toolchain. Tests, scripts, docs, plans and the
 * website never reach the normal bundle, so editing only those leaves a built bundle reusable.
 */
export const RUNTIME_INPUT_DIRECTORIES = ["src", "build", "resources"];
export const RUNTIME_INPUT_FILES = [
  "package.json", "pnpm-lock.yaml", "electron-builder.yml", "electron-builder.local.yml", "electron.vite.config.ts",
  "tsconfig.json", "tsconfig.base.json", "tsconfig.node.json", "tsconfig.web.json",
];
/** Installed toolchain, which the lockfile alone does not prove when node_modules was not reinstalled. */
export const RUNTIME_TOOL_PACKAGES = ["electron", "electron-builder", "electron-vite", "vite"];

// Packaging copies only PNG/ICO from resources/, so its Markdown guide is documentation too.
const ignoredName = (name) => name === ".DS_Store" || /\.test\.ts$/.test(name) || /\.md$/.test(name);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * One entry per input file (`path → sha256` of its contents, following symlinks), sorted by path.
 * A copied acceptance workspace whose sources import from `scripts/` (update and controlled
 * acceptance inject their fixtures) also counts `scripts/`, since those files then reach its bundle.
 */
export function runtimeInputFiles(root) {
  const files = {};
  const visited = new Set();
  let importsScripts = false;
  const add = (relative) => {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = statSync(absolute); } catch {
      files[relative] = `dangling:${lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : ""}`;
      return;
    }
    if (stat.isDirectory()) {
      const real = realpathSync(absolute);
      if (visited.has(real)) { files[relative] = `cycle:${real}`; return; }
      visited.add(real);
      for (const name of readdirSync(absolute).sort()) if (!ignoredName(name)) add(path.posix.join(relative, name));
      visited.delete(real);
    } else if (stat.isFile()) {
      const content = readFileSync(absolute);
      files[relative] = sha256(content);
      if (relative.startsWith("src/") && /["'](?:\.\.\/)+scripts\//.test(content.toString("utf8"))) importsScripts = true;
    }
  };
  for (const entry of [...RUNTIME_INPUT_DIRECTORIES, ...RUNTIME_INPUT_FILES]) if (existsSync(path.join(root, entry))) add(entry);
  if (importsScripts && existsSync(path.join(root, "scripts"))) add("scripts");
  for (const name of RUNTIME_TOOL_PACKAGES) {
    const manifest = path.join(root, "node_modules", name, "package.json");
    files[`node_modules/${name}@version`] = existsSync(manifest) ? String(JSON.parse(readFileSync(manifest, "utf8")).version) : "missing";
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A single digest of `runtimeInputFiles`. */
export function runtimeInputDigest(files) {
  return sha256(Object.entries(files).map(([name, hash]) => `${name}\0${hash}\n`).join(""));
}

/** The packaged app code; null when the bundle has none. */
export function appArchiveDigest(appPath) {
  const archive = path.join(appPath, "Contents/Resources/app.asar");
  return existsSync(archive) ? sha256(readFileSync(archive)) : null;
}

/** Beside the bundle, not inside it, so the signature and the DMG are untouched. */
export const buildStampPath = (appPath) => `${appPath}.inputs.json`;

export function removeBuildStamp(appPath) {
  rmSync(buildStampPath(appPath), { force: true });
}

/**
 * Written only after the bundle passed signature verification. `files` are the inputs read
 * before the build; when they changed during it, no record is written and the bundle cannot be reopened.
 */
export function writeBuildStamp(root, appPath, identityHash, files) {
  if (runtimeInputDigest(runtimeInputFiles(root)) !== runtimeInputDigest(files)) return undefined;
  const stamp = {
    version: 1, builtAt: new Date().toISOString(), identity: identityHash,
    inputs: runtimeInputDigest(files), app: appArchiveDigest(appPath), files,
  };
  writeFileSync(buildStampPath(appPath), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/** Why `appPath` is not the bundle the current inputs would build, or undefined when it is. */
export function staleBundleReason(root, appPath) {
  const file = buildStampPath(appPath);
  let stamp;
  try { stamp = JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    return error?.code === "ENOENT"
      ? "it has no build record, so it may predate the current sources"
      : `its build record ${file} is unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
  if (stamp?.version !== 1 || typeof stamp.inputs !== "string" || !stamp.files || typeof stamp.files !== "object") {
    return `its build record ${file} has an unknown format`;
  }
  if (appArchiveDigest(appPath) !== stamp.app) return "its app.asar changed after it was built and verified";
  const files = runtimeInputFiles(root);
  if (runtimeInputDigest(files) === stamp.inputs) return undefined;
  const changed = [...new Set([...Object.keys(files), ...Object.keys(stamp.files)])]
    .filter((name) => files[name] !== stamp.files[name]).sort();
  const shown = changed.slice(0, 5).join(", ");
  return `runtime inputs changed since it was built: ${shown}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""}`;
}
