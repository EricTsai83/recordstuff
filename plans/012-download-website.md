# 012 Official Website and DMG Downloads

[English](012-download-website.md) | [繁體中文](012-download-website.zh-TW.md)

Status: Phases 1–3 done and Phases 4–5 codebase/documentation parts done on 2026-09-20 (uncommitted). The maintainer chose variant A; B and C were deleted. Remaining: the maintainer's Vercel project and secrets, the first deployment, live-site verification (Phase 4.5), adding the live URL to the READMEs, repository About and release-notes help link, then closure. This revision replaces the 2026-09-19 plan after inspecting how [T3 Code](https://github.com/pingdotgg/t3code) builds and deploys t3.codes (`apps/marketing`, MIT licensed).

Implementation notes (deviations from the text below): during the comparison the variants lived at `src/pages/a|b|c/` with a comparison index at `/` (no `SITE_VARIANT` switch); variant A now occupies the site root and the others are gone. The `deploy-website` job uses `vercel pull`/`build`/`deploy --prebuilt --prod` so the CI-tested build is what goes live. `astro check` needs TypeScript 6.x (TS 7's native compiler lacks the language-server API), so the website package pins `typescript ~6.0.3` like T3 Code; the app stays on TS 7. Screenshots use `puppeteer-core` driving the installed Chrome because headless Chrome's CLI enforces a ~500 px minimum window. The product visual is an inline animated SVG scene (`src/components/DesktopScene.astro`) rather than a screenshot; the maintainer accepted it as the hero and the social image is rendered from it by `pnpm site:screenshots`. Design round 2 (2026-09-20) compared Ember/Paper/Aurora; Ember was chosen and the others deleted. Rounds 3–4 (same day) compared three landscape styles under `/preview/` and moved to a neutral graphite palette; the maintainer chose Facet, `/preview/` and the other landscapes were deleted, and the camera push-in was re-anchored and slowed.

## Outcome

An English RecordStuff website, designed after T3 Code's marketing site, explains the product, offers a prominent direct DMG download for the current verified release, and hosts installation, use, update and removal guidance. Public download claims must match the published release metadata exactly. The site needs no app updater, no backend and no custom domain; it later hosts the version feed that [018](018-app-update.md) reads.

## Decisions taken in this revision

| Topic | Decision | Reason |
| --- | --- | --- |
| Repository layout | Add one new top-level directory `website/` with its own `package.json`. No monorepo, no `apps/` move, no workspace file; the Electron app, scripts, docs and plans stay where they are. Root `package.json` gains `site:*` scripts that delegate with `pnpm --dir website`. | T3 Code's `apps/marketing` sits in a monorepo because it ships five apps. RecordStuff ships one app plus a site; a sibling directory is enough and keeps root `pnpm check` unchanged. |
| Framework | Astro static site, no UI framework, TypeScript. | Same as T3 Code; static HTML output and built-in image optimisation. |
| Design | Reproduce T3 Code's marketing design language: dark zinc palette (`#09090b` background, `#fafafa` foreground, muted greys), `oklch` accent, self-hosted DM Sans and JetBrains Mono (both SIL OFL), fractal-noise body overlay, slim sticky nav that gains a border on scroll, eyebrow/display type scale, rounded download cards with hover lift, staggered rise-in motion disabled under `prefers-reduced-motion`. CSS structure follows its `Layout.astro` and `download.astro`. T3 Code's icons, screenshots, copy, stats, Discord/App Store links and brand name are not reused. | Requested by the maintainer; MIT licence permits adapting the code with attribution kept in a `website/THIRD_PARTY.md`. |
| Language | English only. No `/zh-TW/` routes, no language switch. `<html lang="en">`. | Maintainer decision. Repository docs and app UI stay bilingual as before; this plan file keeps its translation per repository convention. |
| Hosting | Vercel. The maintainer creates and configures the Vercel project (root directory `website/`, Git deployments disabled, secrets) on the Vercel platform. The codebase supplies `website/vercel.ts`, the build output in `website/dist`, and an opt-in CI deploy job that is skipped when secrets are absent. | Maintainer will do platform setup personally; GitHub Pages was declined. |
| Release metadata | Build-time manifest committed as `website/release-manifest.json`, generated from the public `release.json` and `SHA256SUMS` of the release and cross-checked against GitHub's asset list. See "Why not the browser-side GitHub API" below. | Plan requires size, SHA-256 and date, and forbids labelling unverified data as latest. |
| Fallback | Every download control defaults to the GitHub Releases page and is upgraded to the direct asset URL only when the manifest validates at build time. | T3 Code pattern; guarantees no broken download button. |
| Binary source | GitHub Releases only; the site mirrors nothing. | Unchanged. |
| Selection process | Three variants built on one shared content/data/style layer; the maintainer compares them locally and picks one before any deployment. | Requested by the maintainer. |

### Why not the browser-side GitHub API

T3 Code's download page ships with links to its Releases page and, when a visitor opens it, runs JavaScript in the visitor's browser that calls `https://api.github.com/repos/pingdotgg/t3code/releases/latest`, then rewrites each card's `href` to the matching asset. Benefits: the site never needs a redeploy for a new release, and nightly builds appear within minutes. Costs: unauthenticated GitHub API calls are limited to 60 per hour per visitor IP, so shared networks see the fallback; the page can show only what the API returns (tag name and asset URLs), not a verified size, SHA-256 or date; and whatever GitHub currently marks "latest" is displayed even if the maintainers never checked it on the site.

RecordStuff's release workflow already commits release facts to `main` after every stable tag and can redeploy the site in the same run, so the redeploy cost is zero. The build-time manifest lets the page state size, hash and date that were verified against the published assets, works offline and under rate limits, and never advertises a release the workflow did not verify. If the maintainer prefers T3 Code's behaviour, the switch is confined to `src/lib/release.ts` plus a small client script; the manifest remains as the build-time fallback. The default is build-time only.

## Phase 0. Inputs the maintainer provides

1. Product visuals: menu-bar screenshots (idle and recording states, light and dark menu bar) and one saved-file/Finder shot, free of private content. The agent may capture them from the running app after confirming no recording is in progress; otherwise the maintainer supplies them. Stored under `website/src/assets/`.
2. Vercel project, whenever convenient before Phase 4: create it on the Vercel platform with root directory `website/`, framework Astro, Git deployments disabled, and add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as repository secrets if CI deployment is wanted. Nothing in Phases 1–3 depends on this.

## Phase 1. Shared foundation

```
website/
  package.json            astro, @astrojs/check, sharp, typescript; scripts dev/build/preview/check
  astro.config.mjs        site URL https://record.ericts.com (maintainer's domain), overridable with SITE_URL for previews
  vercel.ts               @vercel/config: git.deploymentEnabled false, outputDirectory "dist"
  THIRD_PARTY.md          T3 Code MIT notice for adapted layout/CSS; DM Sans and JetBrains Mono OFL notices
  release-manifest.json   generated; see below
  scripts/manifest.mts    generate | verify [--offline]
  src/content/site.ts     product copy, feature list, help steps, support facts, repository URLs
  src/lib/release.ts      reads the manifest at build time; exposes typed data and fallback URLs
  src/styles/fonts.css    @font-face for self-hosted DM Sans and JetBrains Mono subsets
  src/styles/global.css   tokens and base rules adapted from T3 Code Layout.astro
  src/layouts/Layout.astro  meta, OpenGraph image, canonical, skip link, nav, footer, scroll script
  src/components/         BrandMark, DesktopScene (animated hero scene), DownloadCard, ChecksumBlock, StepList, Section, HelpContent, SupportContent, heroes/EmberHero, pages/{HomeBody,DownloadBody,TextPage}
  src/pages/              index.astro, download.astro, help.astro, support.astro
  src/assets/             og.png (rendered from the hero scene by site:screenshots)
  public/                 favicon set from build/icon.png, robots.txt, font licence texts
```

`scripts/manifest.mts`:

- `generate vX.Y.Z` downloads `release.json` and `SHA256SUMS` from the public release, confirms the release is non-draft and non-prerelease, confirms exactly the three expected assets exist with matching names and sizes, and writes `release-manifest.json` with: version, tag, source commit, published date, architecture (`arm64`), DMG filename, byte size, SHA-256, direct DMG URL, SHA256SUMS URL, release-page URL, release-notes URL and `verifiedAt`.
- `verify` re-fetches the release metadata and fails if any field drifted, the tag no longer exists, or the DMG URL does not answer `200`/`302` to a HEAD request. The Astro build runs `verify` first and stops on failure rather than publishing stale data. `--offline` skips the network for local design work and marks the footer "manifest not re-verified".

Content rules for `src/content/site.ts`: only facts already recorded in README, [INSTALL.md](../resources/INSTALL.md), [desktop design](../docs/system-design/desktop.md) and [verification](../docs/verification/README.md). No claims of notarization, warning-free install, automatic updates, Intel/Windows/Linux support or unverified behaviour. Limitations that still apply, such as the self-signed identity prompt, are stated plainly where they help; the standalone "Known limitations" list was removed on 2026-09-20 at the maintainer's request after its Finder entry was fixed and the update entry became plan 018. Only macOS Apple silicon is offered; no greyed-out platform cards.

Accessibility baseline shared by all variants: semantic landmarks, visible focus rings, keyboard-reachable download controls and disclosure sections, `prefers-reduced-motion` honoured for every transition, readable at 320 px width, fonts loaded with `font-display: swap` and preloaded like T3 Code.

## Phase 2. Three variants and the comparison

All three variants use the Phase 1 tokens, fonts, nav, footer, components and content; they differ in page structure and how far they follow T3 Code's page set. Each lives in `website/variants/<a|b|c>/pages` plus a variant stylesheet and is selected with `SITE_VARIANT=a pnpm site:dev`. `variants/` is not committed to main until the choice is made.

| Variant | Direction | Structure | Trade-off to evaluate |
| --- | --- | --- | --- |
| A | Closest to T3 Code | `/` home with hero, screenshot and feature grid; `/download` with card list and version line; `/help` and `/support` as text pages using the legal-page layout | Familiar to anyone who saw t3.codes; four pages to maintain |
| B | Single page in T3 Code styling | Hero with the download card inline, features, help as `<details>` sections, support and checksum in the footer area | One page, fastest to the button, long scroll |
| C | Download-first | `/` is the download page (T3 Code's download layout with the version/size/hash block under the card and a short "what it does" strip); `/help` combines help and support | Product story is secondary; smallest surface |

Comparison deliverable, produced before anything is chosen:

1. A local index at `http://localhost:4173/compare/` linking every variant and page.
2. A screenshot matrix per variant: desktop 1440 px and mobile 390 px for every page (dark theme only, as T3 Code), captured from the local server.
3. A short written comparison: pages to maintain per release, CSS size, keyboard tab order, Lighthouse accessibility score, and any content that did not fit.
4. The maintainer picks one variant, optionally with adjustments. This is the only blocking decision.

## Phase 3. Finalise the chosen variant

1. Move the chosen variant's pages/styles into `website/src/`, delete `website/variants/`, and record the choice and reasons in [desktop design](../docs/system-design/desktop.md) under a new "Official website" section (with translation).
2. Complete the content: home; download (version, arch, filename, size, date, direct DMG, SHA256SUMS, release notes, older versions → Releases page); help (drag to Applications, Open Anyway, screen/system-audio permissions and relaunch, shortcut and language settings, manual update by replacement, quit-and-Trash removal, what data remains); support (verified platform boundary, source, issues, privacy/storage facts).
3. Run `pnpm site:check` (astro check, manifest verify, built-output link check for internal anchors and external URLs) and a keyboard walkthrough. Run root `pnpm check` to prove the app is unaffected.

## Phase 4. Deployment hooks in the codebase

1. `website/vercel.ts` disables Git deployments and sets the output directory, mirroring T3 Code. The first production deployment is the maintainer's, from the Vercel dashboard or `vercel deploy --prod` on their machine. The agent records the resulting URL in `SITE_URL` and docs once told.
2. Add a `deploy-website` job to [release.yml](../.github/workflows/release.yml): `needs: record`, stable tags only, `contents: read`, and `if` guarded so it is skipped with a notice when `VERCEL_TOKEN` is not configured. It checks out `main` after the record commit, runs `manifest.mts generate` for the tag, fails on any mismatch with `verify`, builds, deploys with `vercel deploy --prod --yes` and prints the deployment URL to the job summary. It never edits the release.
3. Add a `workflow_dispatch` input `deploy-website=true` so content-only changes can be redeployed without a release. Ordinary pushes to main never deploy.
4. Extend the `record` job to run `manifest.mts generate` and include `website/release-manifest.json` in its existing release-facts commit, so `main` always names the latest verified release.
5. Live-site verification, recorded in [verification](../docs/verification/README.md) with translation: HTTPS and public access in a private window; desktop and mobile layout; keyboard-only navigation; every internal and external link; download the DMG through the site's button and compare `shasum -a 256` with the published SHA256SUMS; note the quarantine/Gatekeeper prompt and Open Anyway result on a clean install. A rendered button is not download validation.

## Phase 5. Documentation and closure

1. Tooling: project URL, `site:*` scripts, manifest maintenance, the Vercel settings the maintainer chose, and the CI deploy job in [tooling](../docs/system-design/tooling.md); release-time website step in [releases](../docs/system-design/releases.md); both with translations.
2. Add the live URL to both READMEs near the download block, to the GitHub repository About/homepage field, and to the release-notes help link in `scripts/release.mts`. GitHub download links stay in the READMEs so downloads work if the site is down.
3. Update [plans/README.md](README.md) and translation, then remove this plan and its translation per the completion rule.

## Acceptance

- The public URL loads over HTTPS with no placeholder text, no broken link and no fake platform buttons.
- The primary button downloads the DMG named in the manifest; its SHA-256 equals the published SHA256SUMS; size and date on the page match GitHub.
- A stable tag push produces, in one workflow run, the release, the record commit including the manifest, and (when secrets exist) the redeployed site.
- If manifest verification fails, the build fails and the previous deployment stays live; nothing ever renders an unverified "latest".
- Keyboard-only use reaches every download control and every help section.

## Exclusions

No account system, backend, payment, analytics, artifact mirror, domain purchase, app updater, nightly channel, Intel/Windows/Linux builds, Apple notarization or second language. Browser-side GitHub API polling is not the default (see above). Variants that are not chosen are deleted, not kept. Vercel platform configuration is the maintainer's task, not part of the codebase work.

## Commands (reference for execution)

```bash
# Phase 1
pnpm --dir website install
pnpm site:manifest generate v0.1.2      # writes website/release-manifest.json
pnpm site:check

# Phase 2
SITE_VARIANT=a pnpm site:dev            # b, c likewise; /compare/ lists all

# Phase 4 (maintainer, optional local deploy after the Vercel project exists)
npx vercel@59.23.2 pull --yes --environment=production
npx vercel@59.23.2 build --prod
node website/scripts/check-links.mts --dir .vercel/output/static --offline
npx vercel@59.23.2 deploy --prebuilt --prod --yes
```
