import type { VercelConfig } from "@vercel/config/v1";

// GitHub Actions submits source through website.yml; Vercel verifies and builds.
// Disable Vercel Git deployments to avoid duplicate production deployments.
export const config: VercelConfig = {
  git: {
    deploymentEnabled: false,
  },
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "pnpm test && pnpm check",
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
