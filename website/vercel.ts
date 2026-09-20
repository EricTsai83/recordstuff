import type { VercelConfig } from "@vercel/config/v1";

// GitHub Actions deploys verified output through website.yml on website changes
// and after stable releases. Disable Vercel Git deployments to avoid duplicates.
export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "pnpm build",
  outputDirectory: "dist",
  headers: [
    { source: "/release.json", headers: [{ key: "Cache-Control", value: "public, max-age=300, s-maxage=300" }] },
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    },
  ],
};
