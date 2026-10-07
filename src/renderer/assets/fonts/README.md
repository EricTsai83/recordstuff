# Bundled UI fonts

Inter and JetBrains Mono are Latin variable WOFF2 fonts from Fontsource 5.3.0, bundled locally so the app does not need installed fonts or network access. System fonts render glyphs outside the Latin subset, including Traditional Chinese.

- [Inter](https://fontsource.org/fonts/inter/use): `@fontsource-variable/inter@5.3.0`, `files/inter-latin-wght-normal.woff2`.
- [JetBrains Mono](https://fontsource.org/fonts/jetbrains-mono/use): `@fontsource-variable/jetbrains-mono@5.3.0`, `files/jetbrains-mono-latin-wght-normal.woff2`.

Each font's original SIL Open Font License 1.1 is retained in [Inter's license](../../public/font-licenses/inter-LICENSE.txt) and [JetBrains Mono's license](../../public/font-licenses/jetbrains-mono-LICENSE.txt). Vite copies these public files into `out/renderer/font-licenses/`, so they ship with the app alongside the fonts. `ui.css` defines the `Inter` and `JetBrains Mono` families used by the theme tokens.
