# 012 Official Website and DMG Downloads

[English](012-download-website.md) | [繁體中文](012-download-website.zh-TW.md)

Status: Planned by user request; ready for implementation. Updated: 2026-09-19. This task records the plan only, not website implementation or deployment.

## Outcome and dependencies

An official English/Traditional Chinese RecordStuff website explains the product, offers a prominent direct DMG download, and hosts installation/use/update/removal guidance. The installer itself contains no help documents (shipped in 0.1.2; see [release automation](../docs/system-design/releases.md) and the [installation guide](../resources/INSTALL.md)). Public download claims must match the published release metadata. The site does not require an app updater (015) or a custom domain.

## Content and navigation

- Home: concise purpose (record the main display and system audio to MP4), an authentic screenshot or short demonstration, principal features, and a clear macOS download button. Explain the menu-bar interaction and local file storage without claiming unverified behavior.
- Downloads: verified version, architecture, filename, size, release date, direct DMG link, SHA256SUMS and release-notes link. Initially offer macOS Apple silicon/arm64 only. Link older versions through GitHub Releases. Do not display fake Windows/Linux/Intel buttons or download user-agent detection that hides supported choices.
- Help: drag to Applications, self-signing/Open Anyway guidance, screen/system-audio permission and relaunch steps, recording and language selection, manual app replacement for updates, quit-and-Trash removal, and separately explained retained settings/logs/recordings. No instruction file is bundled into the DMG.
- Support: known limitations (including Finder foreground behavior until fixed), verified-platform boundaries, source repository, issue reporting, and basic privacy/data-storage facts grounded in the implementation. Public GitHub release notes remain English-only; website/help content is bilingual.

## Work

1. Choose static hosting and an available official URL at implementation time; GitHub Pages is a candidate, not a committed provider. Confirm cost and deployment workflow. Custom domain purchase is not included. Plan mobile/desktop layout, readable typography, keyboard navigation, language switching and visible download status.
2. Use GitHub Releases as the sole binary source. The primary download button points directly to the verified DMG asset; provide a secondary release-page link. Keep a small validated release manifest (version, tag/source, architecture, URL, size, hash and release date) or fetch verified metadata at build time. Never guess an asset path or label stale metadata as latest. Runtime APIs are optional, not required.
3. Document release maintenance: after publishing and checking a new artifact, update the site's metadata and matching checksum/notes, validate links and deploy. Coordinate this step with the implemented [release automation](../docs/system-design/releases.md). Exclude drafts/prereleases unless explicitly offering them. On metadata failure, retain a clearly labeled last verified version or link to Releases without asserting latest; do not render a broken download button.
4. Build home/download/help pages or equivalent clear sections, with aligned English/Traditional Chinese content. Use real product visuals with private content removed. Keep installer instructions understandable for users without developer tools. Do not claim no security prompts, Apple notarization or automatic updates.
5. Deploy under the execution authorization. Verify HTTPS, public access, desktop/mobile layout, keyboard focus, language navigation, source/support/help links, and actual asset download through the site. Hash the downloaded bytes against published SHA256SUMS and record browser/quarantine/install results or applicable verified evidence. A button click alone is not download validation.
6. Record hosting/project URL, deployment/update steps and release metadata maintenance in design/tooling documents, verification results and paired translations. Add the live website URL to both READMEs, GitHub repository About and the release help links when authorized during execution. Keep GitHub download links available if the site is unavailable.

## Acceptance and exclusions

The official public URL loads, the direct DMG link downloads the advertised verified artifact, metadata/checksum agree, and guidance is usable in both languages. No placeholder claims or broken links remain. The website links the current release's DMG, SHA256SUMS and guides, and is updated whenever a new tag is published.

No account system, backend, payment, analytics, artifact mirror, domain purchase or app updater is required. T3 Code's [download page](https://t3.codes/download) is a design reference to inspect when implementing, not a requirement to copy its layout or infrastructure.
