/**
 * Once per `pnpm test:ui` run: refuses to start without the production build the hosts load (blocked, not failed),
 * compiles the Electron hosts under tests/ui/hosts once, and records which build the run tested. Workers read the
 * compiled hosts from RECORDSTUFF_UI_HOSTS. Nothing is built from the app's sources here: `out/` is `pnpm build`'s.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "vite";
import { createRequire } from "node:module";

export const REQUIRED_OUTPUTS = [
  "out/main/index.js", "out/preload/settings.js", "out/preload/video.js", "out/preload/countdown.js",
  "out/renderer/settings.html", "out/renderer/video.html", "out/renderer/countdown.html",
] as const;

/** A digest of every file under `out/`, so a report names the build it tested. */
export function outDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else { hash.update(path.relative(root, file)); hash.update(fs.readFileSync(file)); }
    }
  };
  walk(path.join(root, "out"));
  return hash.digest("hex").slice(0, 12);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = path.resolve(__dirname, "../..");
  const missing: string[] = [...REQUIRED_OUTPUTS, "tests/ui/media/landscape-8s.mp4", "tests/ui/media/portrait-4s.mp4"].filter(file => !fs.existsSync(path.join(root, file)));
  // Electron 44 installs its binary outside `pnpm install`'s postinstall: a checkout without it cannot launch a host.
  let electron = "";
  try { electron = createRequire(__filename)("electron") as string; } catch (error) { electron = `unresolvable (${String(error)})`; }
  if (!fs.existsSync(electron)) missing.push(`the Electron runtime (${electron}; run \`node node_modules/electron/install.js\`)`);
  if (missing.length) {
    // The run's summary says blocked, replacing an earlier run's, since the reporter never runs after this exit.
    fs.mkdirSync(path.join(root, "test-results"), { recursive: true });
    fs.writeFileSync(path.join(root, "test-results/ui-summary.json"), `${JSON.stringify({ status: "blocked", startedAt: new Date().toISOString(), missing,
      platform: `${process.platform} ${process.arch}`, counts: { pass: 0, fail: 0, skipped: 0 }, tests: [] }, null, 2)}\n`);
    // Exit 2 is this repository's "blocked": a missing prerequisite, not a failed case.
    console.error(`BLOCKED: ${missing.join(", ")} missing; run \`pnpm build\` first for out/.`);
    process.exit(2);
  }
  const hosts = fs.mkdtempSync(path.join(os.tmpdir(), "recordstuff-ui-hosts-"));
  await build({
    configFile: false, logLevel: "error", root,
    resolve: { alias: { "@": path.join(root, "src/renderer") } },
    build: {
      outDir: hosts, emptyOutDir: false, minify: false, sourcemap: "inline", target: "node24",
      lib: {
        entry: { "app-host": path.join(__dirname, "hosts/app-host.ts"), "view-host": path.join(__dirname, "hosts/view-host.ts"), "countdown-host": path.join(__dirname, "hosts/countdown-host.ts") },
        formats: ["cjs"], fileName: (_format, name) => `${name}.cjs`,
      },
      rollupOptions: { external: ["electron", /^node:/] },
    },
  });
  process.env.RECORDSTUFF_UI_HOSTS = hosts;
  process.env.RECORDSTUFF_UI_OUT_DIGEST = outDigest(root);
  console.log(`UI hosts compiled to ${hosts}; testing out/ ${process.env.RECORDSTUFF_UI_OUT_DIGEST}`);
  return async () => { fs.rmSync(hosts, { recursive: true, force: true }); };
}
