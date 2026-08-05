# Third-Party Fonts

PocketShell 内置以下等宽字体，均为允许再分发的开源字体。二进制与源码分发均包含本文件。

PocketShell bundles the following monospace fonts. All are open-source fonts that
permit redistribution. This file ships with both source and binary distributions.

每套字体的授权原文全文见 `app/public/fonts/<id>-LICENSE.txt`。
Full license texts: `app/public/fonts/<id>-LICENSE.txt`.

---

## Maple Mono NF

- Copyright 2022 The Maple Mono Project Authors (https://github.com/subframe7536/maple-font)
- License: SIL Open Font License 1.1
- Source: https://github.com/subframe7536/maple-font/releases/tag/v7.7 (MapleMono-NF-unhinted.zip)
- Modifications: 子集化（保留 Latin-1、标点、箭头、制表符、块元素、几何图形、杂项符号、盲文、Powerline），转 woff2。Nerd Font 字形由上游提供。
  Subsetted (Latin-1, punctuation, arrows, box-drawing, blocks, geometric shapes,
  misc symbols, braille, Powerline) and converted to woff2. Nerd Font glyphs are upstream's.

## JetBrains Mono

- Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
- License: SIL Open Font License 1.1
- Source: https://github.com/JetBrains/JetBrainsMono
- Modifications: 子集化 + Nerd Font 补丁（Powerline U+E0A0–E0D7），转 woff2。
  Subsetted, Nerd Font patched (Powerline U+E0A0–E0D7), converted to woff2.

## Google Sans Code NFM

- Copyright 2025 The Google Sans Code Project Authors (https://github.com/googlefonts/googlesans-code)
- License: SIL Open Font License 1.1
- Source: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.0 (GoogleSansCode.tar.xz)
- Modifications: 子集化，转 woff2。Nerd Font 补丁与内部命名（`GoogleSansCode NFM`）由 Nerd Fonts 项目完成。
  Subsetted and converted to woff2. Nerd Font patching and internal naming by the Nerd Fonts project.

## Monaspace Neon (MonaspiceNe NFM)

- Copyright (c) 2023, GitHub (https://github.com/githubnext/monaspace)
- License: SIL Open Font License 1.1, **with Reserved Font Name "Monaspace"**
  (including subfamilies "Argon", "Neon", "Xenon", "Radon", "Krypton")
- Source: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.0 (Monaspace.tar.xz)
- Modifications: 子集化，转 woff2。**内部家族名为 `MonaspiceNe NFM`**——该改名由 Nerd Fonts 项目完成，正是为遵守 Reserved Font Name 条款。本项目沿用该名，未使用保留名。
  Subsetted and converted to woff2. The internal family name is `MonaspiceNe NFM`;
  that rename was done by the Nerd Fonts project to comply with the Reserved Font
  Name clause. We use their name and do not use the reserved name.

## Ubuntu Mono Nerd Font Mono

- Copyright 2010–2011 Canonical Ltd.
- License: **Ubuntu Font Licence 1.0** (not OFL)
- Source: https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.5.0 (UbuntuMono.tar.xz)
- Modifications: 子集化，转 woff2（未实质改变字形）。内部名 `UbuntuMono Nerd Font Mono` 在原名基础上追加了区分性命名元素，符合 UFL 1.0 第 (c) 条。
  Subsetted and converted to woff2 (not substantially changed). The internal name
  `UbuntuMono Nerd Font Mono` adds a distinguishing element to the original name,
  as required by UFL 1.0 clause (c).
