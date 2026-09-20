import type { VercelConfig } from "@vercel/config/v1";

// Deployments come from the maintainer or the release workflow, never from
// Vercel's Git integration, so a documentation commit on main cannot publish a
// site whose manifest was not re-verified.
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
