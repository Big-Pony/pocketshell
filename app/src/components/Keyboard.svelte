<!-- app/src/components/Keyboard.svelte -->
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { t } from "svelte-i18n";
  import {
    LAYOUT, FKEYS, ESC_KEY, MOD_IDS, capFor,
    LAYOUT_LAYERED_ALPHA, LAYOUT_LAYERED_SYM, LAYOUT_FLICK,
    LAYOUT_BOTTOM_LAYERED, LAYOUT_BOTTOM_FLICK, LAYOUT_ARROWS, LAYER_KEY_ID,
    type KbLayoutId,
  } from "../lib/term/keymap";
  import { EMPTY_MODS, tapMod, activeMods, consumeAfterKey, resolveKey, type ModState, type ModName, type AppCommand } from "../lib/term/input-router";
  import { createKeyRepeater, type KeyRepeater } from "../lib/term/key-repeat";
  import { imeSendText } from "../lib/term/ime-send";
  import type { VibrateLevel } from "../lib/settings";
  import { keyboardHeight, isKeyboardOpen, type ViewportMetrics } from "../lib/term/keyboard-inset";

  let { onText, onCommand, vibrate = "medium" as VibrateLevel, layout = "mac", hints = [], onHint = (_c: string) => {}, kbLayout = "classic" as KbLayoutId }: {
    onText: (text: string) => void; onCommand: (c: AppCommand) => void;
    vibrate?: VibrateLevel; layout?: "mac" | "win";
    hints?: string[]; onHint?: (cmd: string) => void;
    kbLayout?: KbLayoutId;
  } = $props();

  let sub = $state<"keys" | "ime" | "ops">("keys");

  // layered 的当前层。切布局时重置回字母层——留在符号层切走再切回来会看到
  // 一屏符号，用户以为坏了。
  let symLayer = $state(false);
  $effect(() => { void kbLayout; symLayer = false; });

  // 当前要渲染的主键区（不含功能行、底行、方向键行）。
  const mainRows = $derived(
    kbLayout === "layered" ? (symLayer ? LAYOUT_LAYERED_SYM : LAYOUT_LAYERED_ALPHA)
    : kbLayout === "flick" ? LAYOUT_FLICK
    : LAYOUT);
  const bottomRow = $derived(
    kbLayout === "layered" ? LAYOUT_BOTTOM_LAYERED
    : kbLayout === "flick" ? LAYOUT_BOTTOM_FLICK
    : null);   // classic 的底行在 LAYOUT 里，不单独渲染
  const isBig = $derived(kbLayout !== "classic");
  let mods = $state<ModState>({ ...EMPTY_MODS });
  let imeBuf = $state("");

  let imeFocused = $state(false);
  let kbHeight = $state(0);   // visualViewport-fallback keyboard height (px)
  let kbOpen = $state(false);
  // Two mutually-exclusive strategies (they must NOT be mixed — that was the
  // bug: overlaysContent stops the viewport from resizing, so visualViewport
  // then reports height 0 and the composer sat behind the keyboard):
  //  - Chrome/Android VirtualKeyboard API: keyboard OVERLAYS content (viewport
  //    unchanged, terminal stays put), position via CSS env(keyboard-inset-*).
  //  - Everything else (iOS Safari): browser shrinks the visual viewport, so
  //    measure it and offset the composer's `bottom` by that delta.
  const hasVK = typeof navigator !== "undefined" && "virtualKeyboard" in navigator;

  function readViewport(): ViewportMetrics {
    const vv = (typeof window !== "undefined" ? window.visualViewport : null);
    return {
      innerHeight: typeof window !== "undefined" ? window.innerHeight : 0,
      vvHeight: vv?.height ?? (typeof window !== "undefined" ? window.innerHeight : 0),
      vvOffsetTop: vv?.offsetTop ?? 0,
    };
  }
  function syncViewport() {
    const m = readViewport();
    kbHeight = keyboardHeight(m);
    kbOpen = isKeyboardOpen(m);
  }
  onMount(() => {
    if (hasVK) {
      const vk = (navigator as any).virtualKeyboard;
      // Opt out of auto-resize: the keyboard overlays content and CSS
      // env(keyboard-inset-height) drives the composer's position. Only need
      // geometrychange here to know when the keyboard is actually up.
      try { vk.overlaysContent = true; } catch { /* unsupported */ }
      const onGeo = () => { kbOpen = (vk.boundingRect?.height ?? 0) > 0; };
      vk.addEventListener?.("geometrychange", onGeo);
      return () => vk.removeEventListener?.("geometrychange", onGeo);
    }
    const vv = window.visualViewport;
    vv?.addEventListener("resize", syncViewport);
    vv?.addEventListener("scroll", syncViewport);
    syncViewport();
    return () => {
      vv?.removeEventListener("resize", syncViewport);
      vv?.removeEventListener("scroll", syncViewport);
    };
  });

  const MODSET = new Set<string>(MOD_IDS);

  const VIBE_PATTERN: Record<VibrateLevel, number[]> = {
    off: [], light: [12], medium: [20], strong: [16, 8, 24],
  };
  function buzz() {
    const p = VIBE_PATTERN[vibrate];
    if (p.length) navigator.vibrate?.(p);
  }

  // Long-press repeaters keyed by keycap id (one per held key).
  const repeaters = new Map<string, KeyRepeater>();

  // ---- Defer the first byte-key shot by one frame so a horizontal swipe that
  // starts on a key switches the bottom panel instead of also sending a byte
  // (需求8 Phase 3). Self-contained: no cross-component state.
  let kbEl: HTMLElement;              // root, for the capture-phase start-X tracker
  let downX = 0;                      // pointer X at the current keydown
  let downY = 0;                      // pointer Y at the current keydown（flick 的上滑判定要它）
  let pendingKey: { id: string } | undefined; // byte key awaiting its deferred first shot
  let pendingRaf: number | undefined;
  const KEY_SWIPE_CANCEL_PX = 12;     // horizontal travel that reclassifies as a swipe
  // flick 的上滑阈值。比横向取消阈值（12px）大，因为竖向要区分于「手指按下时
  // 的自然抖动」；实际手势通常滑 30px 以上。
  const FLICK_UP_PX = 22;

  // 当前按住的字节键，**跨越 deferred rAF 存活**（`pendingKey` 在第一帧后就被清空，
  // 而真实手指滑完 22px 要 50ms 以上，那时 pendingKey 早没了）。少了它，
  // 上滑在真机上永远判不成立——只有 jsdom 里同步派发事件才碰巧成立。
  let heldKey: { id: string; up?: string } | undefined;
  let flickArmed = false;             // 本次按压已越过上滑阈值

  // 合成事件可能只带 clientX（jsdom 没有原生 PointerEvent，测试里的 helper 就是
  // 这样）。缺失的坐标当 0，而不是让 undefined 流进减法——NaN 参与的比较一律为
  // false，会把横滑取消整条路径静默废掉。
  const coord = (v: number | undefined) => (Number.isFinite(v as number) ? (v as number) : 0);

  onMount(() => {
    const onDownCap = (e: PointerEvent) => { downX = coord(e.clientX); downY = coord(e.clientY); };
    kbEl?.addEventListener("pointerdown", onDownCap, { capture: true });
    return () => kbEl?.removeEventListener("pointerdown", onDownCap, { capture: true });
  });

  // One shot of a key: resolve against the CURRENT modifier state and emit.
  // Repeat ticks re-resolve, so an armed one-shot modifier (e.g. Shift) only
  // affects the first shot — holding "a" with Shift armed types "Aaaa…".
  function fireKey(id: string) {
    const r = resolveKey(id, activeMods(mods));
    if (r.kind === "bytes") onText(r.text);
    else if (r.kind === "command") onCommand(r.command);
    mods = consumeAfterKey(mods);
  }

  // Key down: modifiers toggle (no repeat); byte-producing keys fire once now
  // and arm a long-press repeater; app commands (Fn layer / Cmd shortcuts /
  // selection-mode arrows) fire once, exactly like before.
  function keyDown(id: string) {
    buzz(); // vibrate on keydown only — repeating it would be a constant hum
    // 层切换键是哨兵，不在 SEQ 里，也不该走 resolveKey（那会把它当普通字符发出去）。
    if (id === LAYER_KEY_ID) { symLayer = !symLayer; return; }
    if (MODSET.has(id)) { mods = tapMod(mods, id as ModName); return; }
    const r = resolveKey(id, activeMods(mods));
    if (r.kind !== "bytes") {
      if (r.kind === "command") onCommand(r.command);
      mods = consumeAfterKey(mods);
      return;
    }
    // Rollover: a different byte key is still awaiting its deferred first shot.
    // A fresh keydown means it was a real tap, so emit its byte now (and keep
    // its repeat armed if still held) instead of dropping it when we reassign
    // pendingKey/pendingRaf below.
    if (pendingKey && pendingKey.id !== id) {
      if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = undefined; }
      repeaters.get(pendingKey.id)?.start(); // fires its first shot + arms repeat
      pendingKey = undefined;
    }
    keyUp(id); // safety: drop a stale repeater/pending for the same key
    const rep = createKeyRepeater(() => fireKey(id));
    repeaters.set(id, rep);
    flickArmed = false;
    heldKey = { id, up: capUpOf(id) };
    pendingKey = { id };
    if (pendingRaf) cancelAnimationFrame(pendingRaf);
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = undefined;
      if (pendingKey?.id === id) { pendingKey = undefined; rep.start(); } // first shot + arm repeat
    });
  }

  // 指针移动的三种归宿（取最先越阈的方向，不做两轴叠加）：
  //  1. 横向越 12px  → 这是面板滑动/误触，取消本次按键，什么都不发
  //     （只在 deferred 帧内有效，与既有行为逐字一致：pendingKey 已清就不再取消）
  //  2. 竖向上滑越 22px（仅 flick）→ 改发角标字符，并立刻停掉长按连发
  //     （否则「按住 400ms 再上滑」会一边连发字母一边出符号）
  //  3. 都没越 → 继续等，当普通轻点处理
  function keyMove(e: PointerEvent) {
    const dx = Math.abs(coord(e.clientX) - downX);
    const dy = downY - coord(e.clientY);      // 正数 = 向上

    // `dx >= dy` 这个「谁先越阈」的裁决只在 flick 下加进来：另两套布局没有上滑，
    // 加了它会让斜向上的拖动（dx=30/dy=40）从「取消」变成「照发」——那是 classic
    // 行为的改动，而 classic 必须一字不变。
    const cancelled = dx > KEY_SWIPE_CANCEL_PX && (kbLayout !== "flick" || dx >= dy);
    if (pendingKey && cancelled) {
      if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = undefined; }
      repeaters.get(pendingKey.id)?.stop();
      repeaters.delete(pendingKey.id);
      pendingKey = undefined;
      heldKey = undefined;
      return;
    }

    if (!flickArmed && dy > FLICK_UP_PX && heldKey?.up) {
      flickArmed = true;
      if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = undefined; }
      pendingKey = undefined;                 // 这一下不再走轻点路径
      repeaters.get(heldKey.id)?.stop();      // 上滑不连发
      repeaters.delete(heldKey.id);
    }
  }

  function keyUp(id: string) {
    // 上滑已判定：发角标字符，不发主字符，也不走 repeater。
    if (flickArmed && heldKey?.id === id) {
      const up = heldKey.up;
      if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = undefined; }
      pendingKey = undefined;
      heldKey = undefined;
      flickArmed = false;
      repeaters.get(id)?.stop();
      repeaters.delete(id);
      if (up) { onText(up); mods = consumeAfterKey(mods); }
      return;
    }
    if (heldKey?.id === id) heldKey = undefined;
    // Released before the deferred frame (a very fast tap, no swipe): fire the
    // single shot now so the key isn't dropped.
    if (pendingKey?.id === id) {
      if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = undefined; }
      pendingKey = undefined;
      const rep = repeaters.get(id);
      if (rep) { rep.start(); rep.stop(); repeaters.delete(id); } // one shot, no repeat
      return;
    }
    const rep = repeaters.get(id);
    if (rep) { rep.stop(); repeaters.delete(id); }
  }

  onDestroy(() => {
    if (pendingRaf) cancelAnimationFrame(pendingRaf);
    pendingKey = undefined;
    heldKey = undefined;
    flickArmed = false;
    for (const rep of repeaters.values()) rep.stop();
    repeaters.clear();
  });

  function tapHint(cmd: string) {
    buzz();
    onHint(cmd);
  }

  function sendIme() {
    onText(imeSendText(imeBuf));
    imeBuf = "";
  }

  const isModOn = (id: string) => MODSET.has(id) && mods[id as ModName] !== "off";
  const isModLocked = (id: string) => MODSET.has(id) && mods[id as ModName] === "locked";

  /** 该键在当前布局下的上滑字符；非 flick 或没有第二字符时返回 undefined。 */
  function capUpOf(id: string): string | undefined {
    if (kbLayout !== "flick") return undefined;
    for (const row of mainRows) {
      const k = row.find((c) => c.id === id);
      if (k) return k.up;
    }
    return undefined;
  }

  // 键帽文字。两件事：
  //  1) 大写跟随——大布局下 Shift/Caps 亮着时字母键帽直接显示大写，省去用户心算。
  //     classic 的字母键帽历来恒为大写（照抄笔记本键帽的印刷），这里**不动**：
  //     改成跟随就是改了 classic 的行为，`getByText("Q")` 那条既有断言是它的守门人。
  //     只改字母：符号的 shift 变体在 layered 的符号层里是独立键位，跟着变反而对不上。
  //  2) 第二字符——classic/layered 的 `up` 是「Shift 时的字符」（随 shift 上下互换），
  //     flick 的 `up` 是「上滑发出的字符」（恒定显示在右上角，不随 shift 动）。
  function keyLabel(k: import("../lib/term/keymap").KeyCap): { main: string; upper?: string } {
    const m = activeMods(mods);
    if (/^[a-z]$/.test(k.id)) {
      const main = kbLayout === "classic"
        ? capFor(k, layout)
        : (m.shift || m.caps ? k.id.toUpperCase() : k.id);
      return kbLayout === "flick" && k.up ? { main, upper: k.up } : { main };
    }
    const main = capFor(k, layout);
    if (k.up) {
      if (kbLayout === "flick") return { main, upper: k.up };
      return m.shift ? { main: k.up, upper: main } : { main, upper: k.up };
    }
    return { main };
  }
</script>

<div class="kb" bind:this={kbEl} onpointermove={keyMove}>
  <div class="subtabs">
    <button class:on={sub === "keys"} onclick={() => (sub = "keys")}>{$t('keyboard.tab.keys')}</button>
    <button class:on={sub === "ime"} onclick={() => (sub = "ime")}>{$t('keyboard.tab.ime')}</button>
    <button class:on={sub === "ops"} onclick={() => (sub = "ops")}>{$t('keyboard.tab.ops')}</button>
  </div>

  {#if sub === "keys"}
    <div class="funcrow">
      <button class="key esc" data-key-id="Esc"
        onpointerdown={(e) => { e.preventDefault(); keyDown("Esc"); }}
        onpointerup={() => keyUp("Esc")}
        onpointercancel={() => keyUp("Esc")}
        onpointerleave={() => keyUp("Esc")}>{ESC_KEY.cap}</button>
      {#if isBig}
        <button class="key fnk" data-key-id="Tab"
          onpointerdown={(e) => { e.preventDefault(); keyDown("Tab"); }}
          onpointerup={() => keyUp("Tab")}
          onpointercancel={() => keyUp("Tab")}
          onpointerleave={() => keyUp("Tab")}>Tab</button>
      {/if}
      {#if isModOn("Fn")}
        <div class="fkeys">
          {#each FKEYS as k (k.id)}
            <button class="key fkey" data-key-id={k.id}
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}>{k.cap}</button>
          {/each}
        </div>
      {:else}
        <div class="hints">
          {#each hints as h (h)}
            <button class="hint-chip" onpointerdown={(e) => { e.preventDefault(); tapHint(h); }}>{h}</button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="rows" class:big={isBig}>
      {#each mainRows as row}
        <div class="row" class:indent={isBig && row.length === 9 && !row.some((k) => MODSET.has(k.id))}>
          {#each row as k (k.id)}
            {@const label = keyLabel(k)}
            {@const isMod = MODSET.has(k.id)}
            {@const on = isModOn(k.id)}
            {@const locked = isModLocked(k.id)}
            <button
              class="key"
              class:mod={isMod}
              class:on
              class:locked
              class:has-up={label.upper}
              data-key-id={k.id}
              style="flex-grow: {k.wide ?? 1};"
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}
            >
              {#if label.upper}<span class="up">{label.upper}</span>{/if}
              <span class="main">{label.main}</span>
            </button>
          {/each}
        </div>
      {/each}
      {#if bottomRow}
        <div class="row">
          {#each bottomRow as k (k.id)}
            {@const isMod = MODSET.has(k.id)}
            <button
              class="key"
              class:mod={isMod}
              class:on={isModOn(k.id)}
              class:locked={isModLocked(k.id)}
              class:layerkey={k.id === LAYER_KEY_ID}
              data-key-id={k.id}
              style="flex-grow: {k.wide ?? 1};"
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}
            >
              <span class="main">{k.id === LAYER_KEY_ID ? (symLayer ? "abc" : "123") : capFor(k, layout)}</span>
            </button>
          {/each}
        </div>
        <div class="row arrows">
          {#each LAYOUT_ARROWS as k (k.id)}
            <button class="key" data-key-id={k.id}
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}
            ><span class="main">{k.cap}</span></button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if sub === "ime"}
    <div class="ime" class:floating={imeFocused && kbOpen} style={imeFocused && kbOpen && !hasVK ? `bottom:${kbHeight}px` : ""}>
      <div class="target">{$t('keyboard.ime.target')}</div>
      <textarea bind:value={imeBuf} placeholder={$t('keyboard.ime.ph')} rows="3"
        onfocus={() => { imeFocused = true; if (!hasVK) syncViewport(); }}
        onblur={() => { imeFocused = false; }}></textarea>
      <div class="ime-actions">
        <button class="clear" onclick={() => (imeBuf = "")}>{$t('keyboard.ime.clear')}</button>
        <button class="send" onclick={sendIme}>{$t('keyboard.ime.send')}</button>
      </div>
      <div class="hint">{$t('keyboard.ime.hint')}</div>
    </div>
  {:else}
    <div class="ops">
      <div class="ops-row">
        <button class="act" onclick={() => onCommand({ type: "copyMode" })}>{$t('keyboard.ops.selectText')}</button>
        <button class="act" onclick={() => onCommand({ type: "selectAllCopy" })}>{$t('keyboard.ops.copyAll')}</button>
        <button class="act" onclick={() => onCommand({ type: "copyVisible" })}>{$t('keyboard.ops.copyOutput')}</button>
        <button class="act" onclick={() => onCommand({ type: "paste" })}>{$t('keyboard.ops.paste')}</button>
      </div>
      <div class="ops-main">
        <div class="dpad">
          <div></div>
          <button class="key up" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowUp"); }}
            onpointerup={() => keyUp("ArrowUp")} onpointercancel={() => keyUp("ArrowUp")} onpointerleave={() => keyUp("ArrowUp")}>↑</button>
          <div></div>
          <button class="key left" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowLeft"); }}
            onpointerup={() => keyUp("ArrowLeft")} onpointercancel={() => keyUp("ArrowLeft")} onpointerleave={() => keyUp("ArrowLeft")}>←</button>
          <button class="key enter-center" data-key-id="Enter" aria-label={$t('keyboard.ops.enterAria')}
            onpointerdown={(e) => { e.preventDefault(); keyDown("Enter"); }}
            onpointerup={() => keyUp("Enter")} onpointercancel={() => keyUp("Enter")} onpointerleave={() => keyUp("Enter")}>⏎</button>
          <button class="key right" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowRight"); }}
            onpointerup={() => keyUp("ArrowRight")} onpointercancel={() => keyUp("ArrowRight")} onpointerleave={() => keyUp("ArrowRight")}>→</button>
          <div></div>
          <button class="key down" onpointerdown={(e) => { e.preventDefault(); keyDown("ArrowDown"); }}
            onpointerup={() => keyUp("ArrowDown")} onpointercancel={() => keyUp("ArrowDown")} onpointerleave={() => keyUp("ArrowDown")}>↓</button>
          <div></div>
        </div>
        <!-- 2×2 网格按行填充：DOM 顺序 Esc, Tab, Del, Space 渲染出的视觉排布是
             左上 Esc / 右上 Tab / 左下 Del / 右下 Space，即需求要的「从左上开始
             顺时针 esc, tab, space, del」。改动这四个的顺序前先看 Keyboard.test.ts
             里那条 DOM 顺序断言。 -->
        <div class="ops-nav2">
          <button class="key" data-key-id="Esc"
            onpointerdown={(e) => { e.preventDefault(); keyDown("Esc"); }}
            onpointerup={() => keyUp("Esc")} onpointercancel={() => keyUp("Esc")} onpointerleave={() => keyUp("Esc")}>Esc</button>
          <button class="key" data-key-id="Tab"
            onpointerdown={(e) => { e.preventDefault(); keyDown("Tab"); }}
            onpointerup={() => keyUp("Tab")} onpointercancel={() => keyUp("Tab")} onpointerleave={() => keyUp("Tab")}>Tab</button>
          <!-- 需求 1（12 期）：这里原本是 id "Del" → SEQ.Del → \x1b[3~（前向删除）。
               手机上「删掉刚打错的字」要的是退格，而前向删除在行尾什么也不做，
               表现就是「删除按钮失效」。键帽用 ⌫ 而非 Del：发的既然是退格，
               写 Del 会与笔记本上 Del 键的含义正好相反。 -->
          <button class="key" data-key-id="Backspace"
            onpointerdown={(e) => { e.preventDefault(); keyDown("Backspace"); }}
            onpointerup={() => keyUp("Backspace")} onpointercancel={() => keyUp("Backspace")} onpointerleave={() => keyUp("Backspace")}>⌫</button>
          <button class="key" data-key-id="Space"
            onpointerdown={(e) => { e.preventDefault(); keyDown("Space"); }}
            onpointerup={() => keyUp("Space")} onpointercancel={() => keyUp("Space")} onpointerleave={() => keyUp("Space")}>space</button>
        </div>
      </div>
      <div class="ops-bottom">
        <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("Home"); }}
          onpointerup={() => keyUp("Home")} onpointercancel={() => keyUp("Home")} onpointerleave={() => keyUp("Home")}>Home</button>
        <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("End"); }}
          onpointerup={() => keyUp("End")} onpointercancel={() => keyUp("End")} onpointerleave={() => keyUp("End")}>End</button>
        <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("PgUp"); }}
          onpointerup={() => keyUp("PgUp")} onpointercancel={() => keyUp("PgUp")} onpointerleave={() => keyUp("PgUp")}>PgUp</button>
        <button class="key" onpointerdown={(e) => { e.preventDefault(); keyDown("PgDn"); }}
          onpointerup={() => keyUp("PgDn")} onpointercancel={() => keyUp("PgDn")} onpointerleave={() => keyUp("PgDn")}>PgDn</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .kb {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
    padding-bottom: var(--safe-bottom);
  }
  .subtabs {
    display: flex;
    gap: 3px;
    margin: 4px 8px 7px;
    padding: 3px;
    flex: 0 0 auto;
    background: var(--seg-bg);
    border: 1px solid var(--seg-line);
    border-radius: 7px;
  }
  .subtabs button {
    flex: 1;
    background: transparent;
    color: var(--dim);
    border: 0;
    border-radius: var(--radius-sm);
    padding: 7px 0;
    font-size: 0.68rem;
    transition: background 0.15s, color 0.15s;
  }
  .subtabs button.on {
    background: var(--seg-active-bg);
    color: var(--seg-active-text);
    font-weight: 600;
    box-shadow: var(--seg-active-ring), var(--seg-shadow);
  }

  .funcrow {
    display: flex;
    gap: 3px;
    padding: 4px 4px 0;
    flex: 0 0 auto;
    align-items: stretch;
  }
  .funcrow .key.esc {
    flex: 0 0 auto;
    min-width: 3em;
    min-height: 2.3em;
    font-size: 0.62rem;
  }
  .fkeys {
    display: flex;
    gap: 3px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .fkeys::-webkit-scrollbar { display: none; }
  .fkeys .fkey {
    flex: 1 1 0;
    min-width: 2.4em;
    min-height: 2.3em;
    font-size: 0.62rem;
  }
  .hints {
    display: flex;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    align-items: center;
  }
  .hints::-webkit-scrollbar { display: none; }
  .hint-chip {
    flex: 0 0 auto;
    white-space: nowrap;
    background: var(--panel);
    color: var(--accent-text);
    border: 1px solid var(--line-soft);
    border-radius: 999px;
    padding: 5px 11px;
    font-size: 0.7rem;
    touch-action: none;
    user-select: none;
    min-height: 2.3em;
  }
  .hint-chip:active { background: var(--accent-soft); }

  /* 键距收紧（行间 5→3.5px，键间 5→3px）。间距参数集中在 .rows/.row 两处，
     真机误触率若上升可就地回调。 */
  .rows {
    display: flex;
    flex-direction: column;
    gap: 3.5px;
    padding: 4px;
    flex: 1;
    overflow-y: auto;
  }
  .row {
    display: flex;
    gap: 3px;
  }
  .key {
    flex: 1 1 0;
    min-width: 0;
    min-height: 2.3em;
    background: var(--key);
    background-image: var(--key-bg-image);
    color: var(--key-text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-sm);
    box-shadow: var(--key-shadow), var(--key-inset);
    padding: 4px 0;
    font-size: 0.72rem;
    touch-action: none;
    user-select: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    line-height: 1;
    transition: background 0.08s, border-color 0.08s, transform 0.05s;
    overflow: hidden;
  }
  .key:active {
    background: var(--keyhi);
    box-shadow: none;
    transform: translateY(1px);
  }
  .key.mod {
    background: var(--key-mod-bg);
    font-size: 0.58rem;
    color: var(--dim);
  }
  .key.mod.on {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  .key.mod.locked {
    background: var(--accent-soft);
    color: var(--accent-text);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .key[data-key-id="Enter"] {
    background: var(--key-enter-bg);
    color: var(--key-enter-text);
    border-color: var(--key-enter-line);
    box-shadow: var(--key-enter-shadow);
    font-weight: 700;
  }
  .key[data-key-id="Enter"]:active { box-shadow: none; }
  .key .main {
    font-size: inherit;
  }
  .key .up {
    font-size: 0.55rem;
    color: var(--dim);
    line-height: 1;
  }
  .key.has-up {
    padding-top: 2px;
  }

  .ime {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    overflow-y: auto;
  }
  .ime.floating {
    position: fixed;
    left: 0; right: 0;
    /* VirtualKeyboard API path: sit exactly on top of the keyboard. The unit
       on the fallback is REQUIRED (a unitless 0 breaks env() in Safari). The
       visualViewport path overrides this with an inline `bottom:<px>`. */
    bottom: env(keyboard-inset-height, 0px);
    z-index: 30;
    background: var(--panel);
    border-top: 1px solid var(--line);
    box-shadow: var(--pop-shadow);
    padding: 8px 10px;
  }
  .target {
    font-size: 0.7rem;
    color: var(--dim);
  }
  .ime textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel2);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    color: var(--text);
    padding: 10px;
    font-size: 0.85rem;
    resize: none;
    font-family: inherit;
    outline: none;
  }
  .ime textarea:focus {
    border-color: var(--accent);
  }
  .ime-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .ime-actions button {
    border: 0;
    border-radius: var(--radius-md);
    padding: 8px 14px;
    font-size: 0.78rem;
  }
  .ime-actions .send {
    background: var(--primary-bg);
    color: var(--primary-text);
    font-weight: 600;
    flex: 1;
  }
  .ime-actions .clear {
    background: var(--key);
    color: var(--text);
  }
  .hint {
    font-size: 0.68rem;
    color: var(--dim);
    line-height: 1.6;
  }
  .ops {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    flex: 1;
    overflow-y: auto;
  }
  .ops-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .ops-row .act { padding: 10px 0; font-size: 0.72rem; }
  .ops-main {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }
  .dpad {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(3, 1fr);
    grid-template-areas:
      ". up ."
      "left toggle right"
      ". down .";
    gap: 4px;
    flex: 1 1 0;
  }
  .dpad .up { grid-area: up; }
  .dpad .left { grid-area: left; }
  .dpad .right { grid-area: right; }
  .dpad .down { grid-area: down; }
  .dpad .key {
    min-height: 3em;
    font-size: 0.8rem;
    padding: 0 2px;
  }
  .dpad .enter-center {
    grid-area: toggle;
    background: var(--key-enter-bg);
    color: var(--key-enter-text);
    border-color: var(--key-enter-line);
    font-weight: 700;
  }
  .ops-nav2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 4px;
    flex: 1 1 0;
  }
  .ops-nav2 .key { min-height: 3em; font-size: 0.75rem; }
  .ops-bottom {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .ops-bottom .key { min-height: 2.6em; font-size: 0.74rem; }
  .act {
    background: var(--key);
    color: var(--key-text);
    border: 1px solid var(--key-line);
    border-radius: var(--radius-md);
    padding: 6px 0;
    font-size: 0.72rem;
  }

  /* ---- 大键位布局（layered / flick）----
     一行 10 键让字母键从 24×34 涨到 36×46。键距横竖分开：横向是误触主方向
     且间隔直接吃键宽，竖向反而要留够，否则拇指上下滑一点就串行。 */
  .rows.big {
    --key-gap-x: 3px;
    --key-gap-y: 5px;
    gap: var(--key-gap-y);
    padding: var(--key-gap-y) var(--key-gap-x);
  }
  .rows.big .row { gap: var(--key-gap-x); }
  .rows.big .key { min-height: 2.9em; font-size: 0.92rem; }
  .rows.big .key.mod { font-size: 0.66rem; }
  /* 9 键行缩进半个键宽居中对齐 10 键行。缩进量随 gap 算，写死百分比改 gap 会错位。 */
  .rows.big .row.indent {
    padding: 0 calc((100% - 9 * var(--key-gap-x)) / 20 + var(--key-gap-x) / 2);
  }
  /* 方向键独立行：终端里 ↑ 翻历史、←→ 移光标比字母还高频，值得整整一行 */
  .rows.big .row.arrows .key { font-size: 1.05rem; }
  .rows.big .key.layerkey { background: var(--key-mod-bg); color: var(--dim); font-size: 0.7rem; }
  /* 功能行的 tab：与 esc 并成左侧固定簇，定宽——
     让它跟联想条抢 flex 会被压到 14px，比字母键还难按。 */
  .funcrow .key.fnk {
    flex: 0 0 auto; min-width: 3em; min-height: 2.3em; font-size: 0.62rem;
  }
</style>
