import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Main, one preload per renderer, and two renderer entries (hidden capture
// host, settings panel); no framework.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          settings: resolve(__dirname, "src/preload/settings.ts"),
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          settings: resolve(__dirname, "src/renderer/settings.html"),
        },
      },
    },
    plugins: [
      {
        // The shipped CSP allows no network at all; only the dev server's HMR
        // websocket needs an exception, and only while serving.
        name: "recordstuff-dev-csp",
        transformIndexHtml: {
          order: "pre",
          handler(html, ctx) {
            return ctx.server
              ? html.replace("script-src 'self'", "script-src 'self'; connect-src 'self' ws: wss:")
              : html;
          },
        },
      },
    ],
  },
});
