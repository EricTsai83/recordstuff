import { defineConfig } from "astro/config";

// Public origin chosen by the maintainer (custom domain on Vercel). SITE_URL
// overrides it for previews so canonical/OpenGraph URLs stay well-formed.
const site = process.env.SITE_URL ?? "https://record.ericts.com";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "ignore",
  build: {
    format: "directory",
    inlineStylesheets: "auto",
  },
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  devToolbar: { enabled: false },
});
