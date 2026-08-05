# Third-party themes

PocketShell itself is licensed under [Apache-2.0](./LICENSE). The colour palettes
that ship as built-in themes are third-party work, redistributed here under the
MIT license. This file records their origin and reproduces the upstream license
texts, as MIT requires.

The palette files live in [`app/themes/`](./app/themes) in [Ghostty](https://ghostty.org)
theme format. Every file keeps its original colour values byte for byte; the only
edits are the header comment and a `# ps-accent = <hex>` directive that tells
PocketShell which palette colour to use as the UI accent.

## Built-in themes

| PocketShell id | Upstream name | Upstream project | License |
| --- | --- | --- | --- |
| `cream-dark` | Claude Cream Dark | [kakarrot-dev/claude-cream](https://github.com/kakarrot-dev/claude-cream) (`themes/ghostty/`) | MIT |
| `cream-light` | Claude Cream Light | [kakarrot-dev/claude-cream](https://github.com/kakarrot-dev/claude-cream) (`themes/ghostty/`) | MIT |
| `gruvbox-dark` | Gruvbox Dark | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (`ghostty/`) | MIT |
| `tokyonight` | TokyoNight | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (`ghostty/`) | MIT |
| `nord` | Nord | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (`ghostty/`) | MIT |
| `mocha` | Catppuccin Mocha | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (`ghostty/`) | MIT |
| `blackout` | Black Metal | [mbadolato/iTerm2-Color-Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes) (`ghostty/`) | MIT |

### Note on `blackout`

`blackout` is adapted from **Black Metal** in `mbadolato/iTerm2-Color-Schemes`.
The adaptation is a rename only — no colour value was changed. The upstream name
refers to black metal music (the upstream collection also carries band-named
variants such as Bathory, Burzum and Mayhem), which reads out of place inside a
developer tool; `blackout` continues the naming of PocketShell's existing
"纯黑银 / pure black-silver" theme. MIT permits modification and renaming as long
as the copyright notice is retained, which the file header and this document do.

说明：`blackout` 改编自 Black Metal（`mbadolato/iTerm2-Color-Schemes`），**仅改名，
未改任何色值**。改名理由是原名指黑金属音乐（上游还有 Bathory/Burzum/Mayhem 等乐队名变体），
装在开发工具里名字违和；`blackout` 沿用 PocketShell 现有「纯黑银」的名字延续感。

---

## License texts

### kakarrot-dev/claude-cream

```
MIT License

Copyright (c) 2026 段茱文 (kakarrot0109)

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
```

### mbadolato/iTerm2-Color-Schemes

```
MIT License

Copyright (c) 2011 to Present Mark Badolato

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

This license covers the iTerm-Color-Schemes repository collection of themes.

The copyright/license for each individual theme belongs to the author of that theme.
```
