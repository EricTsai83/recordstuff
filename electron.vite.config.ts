import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Three entries, no framework: main (Tray, state machine, file writer), preload
// (MessagePort hand-off only) and renderer (the hidden capture host).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
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
