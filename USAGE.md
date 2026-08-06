# PocketShell interaction cheat sheet

**English** · [中文](./USAGE-CN.md) · [Back to README](./README.md)

A few mobile gestures and key combos aren't self-evident; they're collected here. In the "Icon / button" column, icon buttons show their glyph and text buttons show their label.

---

## ⌨ Full keyboard (⌨ tab)

<p align="center">
  <img src="assets/screenshots/07-keyboard-full.jpg" width="30%" alt="Full keyboard — Classic layout">
  <img src="assets/screenshots/08-keyboard-hints.jpg" width="30%" alt="Full keyboard — smart command-hint bar">
</p>

<p align="center"><em>Left: the Classic layout (the default), with sticky modifiers on the bottom row · Right: the smart command-hint bar on the function row — tap to complete</em></p>

### Key layouts

Settings offers three layouts, switchable at the very top. **Classic is the default and is unchanged** — if you never open that setting, nothing about your keyboard changes.

| Layout | Letter key | How you reach digits and symbols |
|---|---|---|
| **Classic** | 24×34 px | A full laptop layout — they all have their own key |
| **Layered** | 36×46 px | Tap `123` on the bottom row to switch layers, `abc` to come back |
| **Flick** | 36×46 px | Flick **up** on a key for the character in its top-right corner, **down** for the bottom-left one |

Layered and Flick double the letter-key touch area. To pay for it they put 10 keys on a row, give the arrow keys their own row, and keep `esc` / `tab` at a fixed width on the left of the function row.

In Flick, a key's two symbols are always a shifted pair (`[` and `{`, `-` and `_`, `1` and `!`), so there is one rule to remember rather than 26 positions. Ten keys have no downward character — their shifted partner already lives on another key — and flicking down on those simply types the letter.

> **Layered and Flick have no `Fn`, `Cmd` or `Caps` key.** Their bottom row is `ctrl` `alt` (`123`) `space` `⏎`, so every `Fn` and `Cmd` combination in the table below — the function row's `F1`–`F12`, tab switching, scrollback, fullscreen, rename — is reachable **only in Classic**. Switch back to Classic if you need them.

Switching to Layered or Flick shows a one-time animated tutorial. Replay it any time from **Settings → Replay keyboard tutorial**.

### Keys and combinations

| Location | Icon / button | What it does |
|---|---|---|
| Bottom-row modifiers | `Shift` `Ctrl` `Alt` `Cmd` `Fn` `Caps` | Tap cycles three states: **1 tap = one-shot** (releases after the next key) → **tap again = locked** (stays lit, keeps applying) → **3rd tap = off** (`Cmd` / `Fn` / `Caps` exist in Classic only) |
| Any character key | Long-press | Auto-repeat while held. **Exception:** in Flick, letter keys commit on release, so they never auto-repeat — backspace, arrows and space still do |
| Combo | `Ctrl` + letter | Send a control char: `Ctrl+C` interrupt, `Ctrl+D` EOF, `Ctrl+Z` suspend, `Ctrl+L` clear, etc. |
| Combo | `Alt` + key | Send Meta (ESC prefix, i.e. `\x1b` + char) |
| Combo | `Shift` / `Caps` + letter | Uppercase (XOR: either one uppercases; both together cancel out) |
| Function row | after lighting `Fn` | *(Classic only)* The function row switches from the command-hint bar to `F1`–`F12` |
| Combo | `Fn` + `F1`–`F12` | *(Classic only)* Send a function key |
| Combo | `Fn` + `←` / `→` | *(Classic only)* Previous / next tab |
| Combo | `Fn` + `↑` / `↓` | *(Classic only)* Scroll the terminal up / down |
| Combo | `Fn` + `1`–`9` | *(Classic only)* Jump to the Nth tab |
| Combo | `Fn` + `N` / `D` / `F` / `C` / `R` | *(Classic only)* New session / background / toggle fullscreen / copy visible output / rename session |
| Combo | `Cmd` + `←` / `→` | *(Classic only)* Previous / next tab |
| Combo | `Cmd` + `A` / `C` / `V` | *(Classic only)* Select-all-copy / smart copy (selection if any, else visible output) / paste |
| Combo | `Cmd` + `F` / `N` / `R` / `K` | *(Classic only)* Page fullscreen / new session / rename session / clear screen |
| Function row (`Fn` off) | command-hint chip | Smart command suggestions; tap to complete / insert into the input line |
| Bottom row | `123` / `abc` | *(Layered only)* Switch between the letter layer and the digit/symbol layer |
| Keycap top-right | small superscript | In Classic and Layered, the character this key produces with `Shift` (holding `Shift` swaps it with the main character). In Flick, the character this key sends when you **flick up** — it never changes |
| Keycap bottom-left | small subscript | *(Flick only)* The character this key sends when you **flick down** |

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
