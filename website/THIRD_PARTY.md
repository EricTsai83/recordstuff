# Third-party notices for the website

## T3 Code marketing site (layout and CSS structure)

The page layout, design tokens, download-card and motion CSS in `src/` are adapted
from the `apps/marketing` package of [T3 Code](https://github.com/pingdotgg/t3code).
No T3 Code icons, screenshots, copy, statistics or brand assets are included.

MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Fonts

Geist (Vercel), JetBrains Mono and Kalam (the hand-drawn callout in the hero scene) are
self-hosted through the `@fontsource-variable/geist`, `@fontsource/jetbrains-mono` and
`@fontsource/kalam` packages under the SIL Open Font License 1.1. The
licence texts ship in `node_modules/@fontsource*/*/LICENSE`; the woff2 files are
bundled into `dist/_astro/` by the build, so no third-party font request is made at
runtime.
