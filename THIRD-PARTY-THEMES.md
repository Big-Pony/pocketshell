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

## Using upstream themes yourself

Any `.ghostty` file dropped into the agent's `~/.pocketshell/themes/` becomes a
theme, so the whole of [`mbadolato/iTerm2-Color-Schemes`](https://github.com/mbadolato/iTerm2-Color-Schemes)
(`ghostty/`) works as-is. **Name the file whatever upstream calls it** — spaces,
dots and non-Latin characters are all fine (`Tokyo Night.ghostty`,
`3024 Day.ghostty`). PocketShell derives an internal id from the file name
(`Tokyo Night` → `tokyo-night`) because the id ends up in a CSS custom property
name, and shows the original file name in Settings. Two files that derive the
same id, or one that derives a built-in's id, are reported in Settings with the
reason rather than silently replacing each other.

用法说明：把任意 `.ghostty` 丢进 agent 的 `~/.pocketshell/themes/` 即可，
上游那 600 多套主题都能直接用，**文件名照抄上游即可**（空格、点、中文都行）。
PocketShell 会从文件名派生一个内部 id（`Tokyo Night` → `tokyo-night`，因为 id 要进
CSS 自定义属性名），设置面板里显示的仍是原文件名。

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
