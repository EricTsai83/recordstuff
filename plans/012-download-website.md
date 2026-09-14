# 012 Product and Download Website

[English](012-download-website.md) | [繁體中文](../docs/zh-TW/plans/012-download-website.md)

Status: Deferred; activate after 010 if a separate product entry point is desired. Updated: 2026-09-15.

## Outcome and dependencies

A public, English/Traditional Chinese product page explains RecordStuff and takes visitors to its verified GitHub release. Requires a completed 010 with a real downloadable release. Does not require 011: local release builds can serve a website equally well.

## Work

1. Select hosting and an available URL when implementation starts; GitHub Pages is a candidate, and a custom domain is optional. Check the chosen hosting workflow and cost before committing to it. No domain purchase is part of this plan.
2. Build a small static page with product purpose, an actual screenshot, macOS arm64 download, installation steps, self-signing guidance, verified-platform limitations, source repository, and issue reporting. Keep English and Traditional Chinese aligned and avoid suggesting unverified platforms are available.
3. Use GitHub Releases as the artifact source. Initially link the main button to `/EricTsai83/recordstuff/releases/latest` on github.com. A direct-file button must use a verified asset URL; do not guess versioned names or display a hardcoded “latest version” that can become stale. If version/checksum details are displayed, update them with each release or source them from verified release metadata. An API is not required for the initial page.
4. Deploy under the execution authorization, verify the public page on desktop/mobile, keyboard navigation, both languages, and download/source/report links. Follow the download path to the real DMG and validate its checksum. Record the deployed URL and add it to both READMEs.

## Completion criteria

- The public page explains the shipped product and reaches a real, verified GitHub download with no placeholder links.
- Bilingual content and installation limitations match the release; links and layout are checked.
- Hosting/update instructions, deployed URL, and download verification are recorded.

No accounts, backend, payment system, analytics, artifact mirror, or automatic updater is required. T3 Code’s [download page](https://t3.codes/download) is a reference for separating product navigation from GitHub-hosted downloads.
