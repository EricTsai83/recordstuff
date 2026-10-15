import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { removeOutStamp, runtimeInputFiles, writeOutStamp } from "./scripts/lib/runner/runtime-inputs.mjs";

/**
 * The inputs `out/` is built from, recorded beside it (scripts/lib/runner/runtime-inputs.mjs), so the UI suite and the
 * runners that load `out/` refuse a build older than the sources. Main builds first and drops the old record; the
 * renderer, built last, writes the new one once its files are out. A dev run serves the renderer, so it leaves none,
 * and a build into another folder (`--outDir`) never certifies the `out/` it did not write.
 */
let buildInputs: Record<string, string> | undefined;
const builtInto = new Map<"main" | "preload" | "renderer", string>();
const buildRecord = (target: "main" | "preload" | "renderer"): Plugin => ({
  name: `recordstuff-build-inputs-${target}`, apply: "build",
  configResolved(config) { builtInto.set(target, resolve(config.root, config.build.outDir)); },
  buildStart() {
    if (target !== "main") return;
    buildInputs = runtimeInputFiles(__dirname);
    removeOutStamp(__dirname);
  },
  writeBundle() {
    if (target !== "renderer" || !buildInputs) return;
    const canonical = (["main", "preload", "renderer"] as const).every(name => builtInto.get(name) === resolve(__dirname, "out", name));
    if (canonical) writeOutStamp(__dirname, buildInputs);
  },
});

/**
 * Plan 076's native capture engine (native/capture), built with Cargo before main and copied to
 * `out/native/recordstuff-capture.node`, which packaging unpacks from the asar archive. It is built on macOS, where it
 * records (capture-engine.ts), and on Windows only with `RECORDSTUFF_BUILD_NATIVE=1` (plan 076, step 3: CI's native
 * job builds and tests it; the Windows check and release builds take it up in step 6). A machine without Rust skips it
 * with a warning, and a native recording then fails at start with the load error. `RECORDSTUFF_SKIP_NATIVE=1` skips it
 * on purpose.
 */
const nativeEngine = (): Plugin => {
  const manifest = resolve(__dirname, "native/capture/Cargo.toml");
  const library = resolve(__dirname, "native/capture/target/release",
    process.platform === "win32" ? "recordstuff_capture.dll" : "librecordstuff_capture.dylib");
  let built = false;
  return {
    name: "recordstuff-native-engine", apply: "build",
    buildStart() {
      built = false;
      const wanted = process.platform === "darwin" || (process.platform === "win32" && process.env["RECORDSTUFF_BUILD_NATIVE"] === "1");
      if (!wanted || process.env["RECORDSTUFF_SKIP_NATIVE"] === "1") return;
      const cargo = [process.env["CARGO"], resolve(homedir(), process.platform === "win32" ? ".cargo/bin/cargo.exe" : ".cargo/bin/cargo"), "cargo"].find(c => c && (c === "cargo" || existsSync(c)))!;
      try {
        execFileSync(cargo, ["build", "--release", "--manifest-path", manifest], { stdio: "inherit" });
        built = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        this.warn("cargo was not found: the native capture engine was not built, so recording on macOS fails until Rust is installed");
      }
    },
    writeBundle(options) {
      if (!built || !options.dir) return;
      const target = resolve(options.dir, "../native/recordstuff-capture.node");
      mkdirSync(resolve(target, ".."), { recursive: true });
      copyFileSync(library, target);
    },
  };
};

// Main, one preload per renderer, and four renderer entries (hidden capture
// host, settings panel, countdown overlay, fullscreen video).
export default defineConfig({
  // electron-vite externalizes dependencies by default (`build.externalizeDeps`).
  main: {
    plugins: [buildRecord("main"), nativeEngine()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // The native engine's capture host, run in a utilityProcess (plan 076).
          "native-host-process": resolve(__dirname, "src/main/recording/native-host-process.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [buildRecord("preload")],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          settings: resolve(__dirname, "src/preload/settings.ts"),
          countdown: resolve(__dirname, "src/preload/countdown.ts"),
          video: resolve(__dirname, "src/preload/video.ts"),
        },
      },
    },
  },
  renderer: {
    resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          settings: resolve(__dirname, "src/renderer/settings.html"),
          countdown: resolve(__dirname, "src/renderer/countdown.html"),
          video: resolve(__dirname, "src/renderer/video.html"),
        },
      },
    },
    plugins: [
      buildRecord("renderer"),
      react(),
      tailwindcss(),
      {
        // Sonner embeds a copy of its CSS in a style tag. Ship the external
        // stylesheet through Vite instead, preserving the renderer's self-only CSP.
        name: "recordstuff-sonner-csp",
        transform(code, id) {
          if (!id.includes("/sonner/dist/")) return;
          return code.replace(/^__insertCSS\(.*\);?$/gm, "");
        },
      },
      {
        // Base UI's Select renders a style tag that hides its popup's scroll bar. The self-only CSP refuses it, so
        // ui.css carries the same rule for the class and the tag is not rendered (2026-10-07).
        name: "recordstuff-base-ui-csp",
        transform(code, id) {
          if (!/[\\/]@base-ui[\\/]react[\\/]utils[\\/]styles\.m?js$/.test(id)) return;
          const replaced = code.replace(/getElement\(nonce\) \{[\s\S]*?\n  \}/, "getElement() {\n    return null;\n  }");
          if (replaced === code) throw new Error("recordstuff-base-ui-csp: Base UI's style helper changed shape");
          return replaced;
        },
      },
      {
        // The shipped CSP allows no network at all; only the dev server's HMR
        // websocket needs an exception, and only while serving.
        name: "recordstuff-dev-csp",
        transformIndexHtml: {
          order: "pre",
          handler(html, ctx) {
            return ctx.server
              ? html.replace(
                  "script-src 'self'",
                  "script-src 'self'; connect-src 'self' ws: wss:",
                )
              : html;
          },
        },
      },
    ],
  },
});
