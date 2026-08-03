# PocketShell interaction cheat sheet

**English** · [中文](./USAGE-CN.md) · [Back to README](./README.md)

A few mobile gestures and key combos aren't self-evident; they're collected here. In the "Icon / button" column, icon buttons show their glyph and text buttons show their label.

---

## ⌨ Full keyboard (⌨ tab)

<p align="center">
  <img src="assets/screenshots/07-keyboard-full.jpg" width="30%" alt="Full keyboard — laptop layout">
  <img src="assets/screenshots/08-keyboard-hints.jpg" width="30%" alt="Full keyboard — smart command-hint bar">
</p>

<p align="center"><em>Left: the full laptop layout, with sticky modifiers on the bottom row · Right: the smart command-hint bar on the function row — tap to complete</em></p>

| Location | Icon / button | What it does |
|---|---|---|
| Bottom-row modifiers | `Shift` `Ctrl` `Alt` `Cmd` `Fn` `Caps` | Tap cycles three states: **1 tap = one-shot** (releases after the next key) → **tap again = locked** (stays lit, keeps applying) → **3rd tap = off** |
| Any character key | Long-press | Auto-repeat while held |
| Combo | `Ctrl` + letter | Send a control char: `Ctrl+C` interrupt, `Ctrl+D` EOF, `Ctrl+Z` suspend, `Ctrl+L` clear, etc. |
| Combo | `Alt` + key | Send Meta (ESC prefix, i.e. `\x1b` + char) |
| Combo | `Shift` / `Caps` + letter | Uppercase (XOR: either one uppercases; both together cancel out) |
| Function row | after lighting `Fn` | The function row switches from the command-hint bar to `F1`–`F12` |
| Combo | `Fn` + `F1`–`F12` | Send a function key |
| Combo | `Fn` + `←` / `→` | Previous / next tab |
| Combo | `Fn` + `↑` / `↓` | Scroll the terminal up / down |
| Combo | `Fn` + `1`–`9` | Jump to the Nth tab |
| Combo | `Fn` + `N` / `D` / `F` / `C` / `R` | New session / background / toggle fullscreen / copy visible output / rename session |
| Combo | `Cmd` + `←` / `→` | Previous / next tab |
| Combo | `Cmd` + `A` / `C` / `V` | Select-all-copy / smart copy (selection if any, else visible output) / paste |
| Combo | `Cmd` + `F` / `N` / `R` / `K` | Page fullscreen / new session / rename session / clear screen |
| Function row (`Fn` off) | command-hint chip | Smart command suggestions; tap to complete / insert into the input line |
| Keycap top-right | small superscript | The character this key produces with `Shift` |

## ✎ IME buffer (✎ tab)

<p align="center">
  <img src="assets/screenshots/02-task-running.jpg" width="30%" alt="Task started right after the whole segment was injected">
</p>

<p align="center"><em>Compose the whole prompt with the system IME, then inject it in one shot — no typing it into the terminal character by character</em></p>

| Location | Icon / button | What it does |
|---|---|---|
| Input area | text box | Compose a whole segment with the system IME; before sending it lives only in the local buffer and survives disconnects |
| Bottom-left | `Clear` | Clear the buffer |
| Bottom-right | `Send to terminal ⏎` | Inject the whole segment plus Enter; **with an empty buffer, Send = a bare Enter** (no need to switch back to the full keyboard to press Return) |

## ✂ Quick actions (✂ tab)

<p align="center">
  <img src="assets/screenshots/09-keyboard-quick.jpg" width="30%" alt="Quick actions — arrows, copy and paste">
</p>

| Location | Icon / button | What it does |
|---|---|---|
| Top row | `Esc` `Tab` `Del` | Send the corresponding key |
| D-pad center | `⏎` | Enter (confirm) |
| Nav keys | `Home` `End` `PgUp` `PgDn` | The matching cursor / paging keys |
| Bottom button | `Select text` | Open the copy-mode overlay to long-press and select terminal text manually |
| Bottom button | `Copy all` | Select the whole terminal and copy it to the clipboard |
| Bottom button | `Copy output` | Copy the currently visible terminal output |
| Bottom button | `Paste` | Paste the clipboard into the terminal |

## 📁 File panel (directory tab)

<p align="center">
  <img src="assets/screenshots/11-source-view.jpg" width="30%" alt="Source view with highlighting">
  <img src="assets/screenshots/12-file-menu.jpg" width="30%" alt="File action menu">
  <img src="assets/screenshots/05-fullscreen-preview.jpg" width="30%" alt="Fullscreen preview of the 3D scene the agent wrote">
</p>

<p align="center"><em>Left: highlighted source with line numbers, switchable to the editor · Middle: the per-row <code>⋯</code> action menu · Right: static HTML running fullscreen, with JS and relative assets working</em></p>

| Location | Icon / button | What it does |
|---|---|---|
| Path bar, left | ◉ (ring anchor) | **Single tap**: set the project root to the focused terminal's working dir; **double tap**: toggle "follow focused terminal" (root tracks wherever the terminal `cd`s) |
| Path bar, middle | path text | Tap to copy the full path to the clipboard |
| Path bar, right | `⇄` | Switch project root (opens the root history list) |
| Path bar, right | `⟳` | Refresh the tree (keeps expanded levels) |
| Tree row, leading | `▸` / `▾` / `·` | Collapsed dir / expanded dir / file; tap a dir row to expand, a file row to open preview |
| Tree row, trailing | `⋯` | Open that item's action menu (copy path, cd, rename, new, upload, download, delete, …) |
| Tree row, inline | `M` `A` `D` `?` | git status markers: modified / added / deleted / untracked |
| Sub-tab bar | branch beside `Git` | The current git branch |

## 🗂 Top tab bar (terminals + files)

| Location | Gesture | What it does |
|---|---|---|
| Any top tab | Single tap | Select / switch to that tab (immediate, no latency) |
| The same top tab | Double tap | Open that tab's close-confirmation dialog |
| ↳ terminal tab | on confirm | Only closes the tab — the tmux session keeps running in the background and can be reopened from the task panel |
| ↳ shell tab | on confirm | The shell session is closed and destroyed permanently |
| ↳ file tab | on confirm | Closes the file preview tab (warns first if it has unsaved edits) |
| Tab bar, right | `+` | New tmux session (prompts for a name) |

## 🎨 Themes and snippets

<p align="center">
  <img src="assets/screenshots/13-snippets.jpg" width="23%" alt="Snippets panel">
  <img src="assets/screenshots/14-themes.jpg" width="23%" alt="Six theme palettes">
  <img src="assets/screenshots/15-light-theme.jpg" width="23%" alt="A light theme in actual use">
  <img src="assets/screenshots/16-notifications.jpg" width="23%" alt="Notification settings and outbound webhooks">
</p>

<p align="center"><em>Snippets panel (tap to insert, synced across devices) · Six themes, switchable in settings · A light theme in actual use · Notification settings and outbound webhooks</em></p>

- **Snippets** — every entry is one you added yourself; tap to insert it into the input line, add/edit/delete freely, broadcast-synced across devices.
- **Themes** — four dark (Graphite Orange / Oscilloscope Cyan / Blackout Silver / Prussian Blue) plus two light (Warm White / Vermilion); switch in settings, applied instantly, and it can follow the system light/dark setting. The terminal area stays dark under every theme.
- **Notifications** — per-tool switches, two delivery channels (Web Push / outbound webhooks) that can both be on, and a per-webhook test send. See [the README's "Notifications" section](./README.md#-notifications).
