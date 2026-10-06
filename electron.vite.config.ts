import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Main, one preload per renderer, and four renderer entries (hidden capture
// host, settings panel, countdown overlay, fullscreen video).
export default defineConfig({
  // electron-vite externalizes dependencies by default (`build.externalizeDeps`).
  main: {},
  preload: {
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
