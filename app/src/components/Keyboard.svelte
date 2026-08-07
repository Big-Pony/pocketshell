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
  import { isTap } from "../lib/term/tap-or-scroll";
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
  // flick 的竖向阈值，上下同值。比横向取消阈值（12px）大，因为竖向要区分于
  // 「手指按下时的自然抖动」；实际手势通常滑 30px 以上。
  // **上下必须同值**：不对称会让人觉得某个方向「难触发」，手上很别扭。
  const FLICK_PX = 22;

  // 当前按住的字节键，**跨越 deferred rAF 存活**（`pendingKey` 在第一帧后就被清空，
  // 而真实手指滑完 22px 要 50ms 以上，那时 pendingKey 早没了）。少了它，
  // 上滑在真机上永远判不成立——只有 jsdom 里同步派发事件才碰巧成立。
  let heldKey: { id: string; up?: string; down?: string } | undefined;
  // 本次按压已判定的滑动方向；undefined = 尚未越阈（还可能是轻点）。
  let flickDir: "up" | "down" | undefined;

  // 合成事件可能只带 clientX（jsdom 没有原生 PointerEvent，测试里的 helper 就是
  // 这样）。缺失的坐标当 0，而不是让 undefined 流进减法——NaN 参与的比较一律为
  // false，会把横滑取消整条路径静默废掉。
  const coord = (v: number | undefined) => (Number.isFinite(v as number) ? (v as number) : 0);

  /** 撤销「等待首发」的 rAF。写成一处，省得七个调用点各漏各的。 */
  function cancelPendingShot() {
    if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = undefined; }
  }

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
      cancelPendingShot();
      repeaters.get(pendingKey.id)?.start(); // fires its first shot + arms repeat
      pendingKey = undefined;
    }
    // safety: drop a stale repeater/pending for the same key.
    // **不能直接调 keyUp(id)**：带上滑的键在 keyUp 里会「抬手结算」发出字母，
    // 同一个键重复按下（丢了 pointerup 的情况）就会凭空多打一个字。
    // 这里要的只是清状态，不是结算，所以先把 heldKey 摘掉再清。
    if (heldKey?.id === id) heldKey = undefined;
    keyUp(id);
    const rep = createKeyRepeater(() => fireKey(id));
    repeaters.set(id, rep);
    flickDir = undefined;
    const { up, down } = capFlickOf(id);
    heldKey = { id, up, down };
    pendingKey = { id };
    cancelPendingShot();

    // 有滑动字符的键（上滑或下滑）：**抬手才输入**（keyUp 里结算），按下什么都不发。
    //
    // 试过用定时器延后首发，不成——那只是把问题推后：手指按住超过判定窗口
    // 再滑，字母照样先蹦出来。只要「按下」这个时刻就决定输出，就永远分不清
    // 用户是想轻点还是想上滑，因为这两个动作的开头完全一样。
    // 真正分得清的时刻只有一个：抬手。抬手时手指走过多远已成定局，
    // 越过阈值就是符号、没越过就是字母，不需要猜。
    //
    // 代价是这些键没有长按连发（连发要在按住期间就往外发，与上面的道理直接
    // 冲突）。字母/数字/符号本来也极少需要连打——要连打的是退格和方向键，
    // 那些键没有 up，走下面的 rAF 分支，行为一字未动。
    if (up || down) {
      repeaters.delete(id);   // 这个键不用 repeater：既不首发也不连发
      pendingKey = undefined; // 也不走 deferred 首发那套记账
      return;
    }

    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = undefined;
      if (pendingKey?.id === id) { pendingKey = undefined; rep.start(); } // first shot + arm repeat
    });
  }

  // 指针移动的三种归宿（取最先越阈的方向，不做两轴叠加）：
  //  1. 横向越 12px  → 这是面板滑动/误触，取消本次按键，什么都不发
  //     （只在 deferred 帧内有效，与既有行为逐字一致：pendingKey 已清就不再取消）
  //  2. 竖向越 22px（仅 flick，上下同阈）→ 改发对应角标字符，并立刻停掉长按连发
  //     （否则「按住 400ms 再滑」会一边连发字母一边出符号）
  //  3. 都没越 → 继续等，当普通轻点处理
  function keyMove(e: PointerEvent) {
    const dx = Math.abs(coord(e.clientX) - downX);
    const dySigned = downY - coord(e.clientY); // 正数 = 向上，负数 = 向下
    const dy = Math.abs(dySigned);

    // `dx >= dy` 这个「谁先越阈」的裁决只在 flick 下加进来：另两套布局没有滑动手势，
    // 加了它会让斜向的拖动（dx=30/dy=40）从「取消」变成「照发」——那是 classic
    // 行为的改动，而 classic 必须一字不变。
    // 这里用的是 dy 的**绝对值**：下滑补全（12 期）之后竖向两个方向都要参与裁决，
    // 只看有符号的 dySigned 会让斜下拖动恒判为「横滑取消」，下滑就再也滑不出来。
    const cancelled = dx > KEY_SWIPE_CANCEL_PX && (kbLayout !== "flick" || dx >= dy);
    // 判定用 (pendingKey || heldKey) 而不是只看 pendingKey：带滑动的键改成
    // 「抬手才输入」之后就不再设 pendingKey，只看它会让横滑取消对这些键整条失效
    // （横滑走了，抬手时 keyUp 照样结算出一个字母）。
    const active = pendingKey?.id ?? heldKey?.id;
    if (active && cancelled) {
      cancelPendingShot();
      repeaters.get(active)?.stop();
      repeaters.delete(active);
      pendingKey = undefined;
      heldKey = undefined;   // 清掉它，抬手时就不会再结算
      return;
    }

    if (flickDir || dy <= FLICK_PX) return;
    // 该方向没配字符就不武断：这个键下滑退化成轻点（10 个键刻意没配 down）。
    // 判定不成立时保持 flickDir 为 undefined，抬手照常结算出字母——静默吞掉的话
    // 用户滑歪一点就丢一个字符，且毫无反馈。
    const dir = dySigned > 0 ? "up" : "down";
    if (!(dir === "up" ? heldKey?.up : heldKey?.down)) return;
    flickDir = dir;
    cancelPendingShot();
    pendingKey = undefined;                 // 这一下不再走轻点路径
    repeaters.get(heldKey!.id)?.stop();     // 滑动不连发
    repeaters.delete(heldKey!.id);
  }

  function keyUp(id: string) {
    // 滑动已判定：发对应角标字符，不发主字符，也不走 repeater。
    if (flickDir && heldKey?.id === id) {
      const ch = flickDir === "up" ? heldKey.up : heldKey.down;
      cancelPendingShot();
      pendingKey = undefined;
      heldKey = undefined;
      flickDir = undefined;
      repeaters.get(id)?.stop();
      repeaters.delete(id);
      if (ch) { onText(ch); mods = consumeAfterKey(mods); }
      return;
    }
    // 带滑动的键：按下时什么都没发，抬手才结算成主字符（走到这里说明没越过
    // 竖向阈值，或滑的那个方向没配字符——两种情况都该出字母）。这是「按下不
    // 输入」的另一半，少了它这些键就彻底哑了。
    if (heldKey?.id === id && (heldKey.up || heldKey.down)) {
      heldKey = undefined;
      cancelPendingShot();
      pendingKey = undefined;
      repeaters.delete(id);
      fireKey(id);
      return;
    }
    if (heldKey?.id === id) heldKey = undefined;
    // Released before the deferred frame (a very fast tap, no swipe): fire the
    // single shot now so the key isn't dropped.
    if (pendingKey?.id === id) {
      cancelPendingShot();
      pendingKey = undefined;
      const rep = repeaters.get(id);
      if (rep) { rep.start(); rep.stop(); repeaters.delete(id); } // one shot, no repeat
      return;
    }
    const rep = repeaters.get(id);
    if (rep) { rep.stop(); repeaters.delete(id); }
  }

  onDestroy(() => {
    cancelPendingShot();
    pendingKey = undefined;
    heldKey = undefined;
    flickDir = undefined;
    for (const rep of repeaters.values()) rep.stop();
    repeaters.clear();
  });

  // 联想条「抬手才结算」（13 期需求 2）。
  //
  // 原先是按下即补全 + CSS touch-action:none，两条叠加的后果是这条提示区
  // 既滚不动也躲不开：手指一碰就选中，根本不给滚动的机会。
  // 现在按下只记坐标，抬手时才判——位移超阈说明用户在滚，什么都不发。
  // 这和带滑动的键是同一套心智：按下那一刻分不清点击还是滑动，只有抬手时
  // 手指走过多远才成定局。
  let hintDown: { cmd: string; x: number; y: number } | undefined;

  function hintPointerDown(e: PointerEvent, cmd: string) {
    hintDown = { cmd, x: coord(e.clientX), y: coord(e.clientY) };
  }

  function hintPointerUp(e: PointerEvent) {
    const d = hintDown;
    hintDown = undefined;
    if (!d) return;   // 已被 leave/cancel 清掉：手指离开了原目标，不替用户选词条
    if (!isTap({ x: d.x, y: d.y }, { x: coord(e.clientX), y: coord(e.clientY) })) return;
    buzz();           // 震动挪到这里：滚动时不该震，否则每次滑都在嗡嗡响
    onHint(d.cmd);
  }

  function sendIme() {
    onText(imeSendText(imeBuf));
    imeBuf = "";
  }

  const isModOn = (id: string) => MODSET.has(id) && mods[id as ModName] !== "off";
  const isModLocked = (id: string) => MODSET.has(id) && mods[id as ModName] === "locked";

  /** 该键在当前布局下的上/下滑字符；非 flick 时两个都是 undefined。 */
  function capFlickOf(id: string): { up?: string; down?: string } {
    if (kbLayout !== "flick") return {};
    for (const row of mainRows) {
      const k = row.find((c) => c.id === id);
      if (k) return { up: k.up, down: k.down };
    }
    return {};
  }

  // 键帽文字。两件事：
  //  1) 大写跟随——大布局下 Shift/Caps 亮着时字母键帽直接显示大写，省去用户心算。
  //     classic 的字母键帽历来恒为大写（照抄笔记本键帽的印刷），这里**不动**：
  //     改成跟随就是改了 classic 的行为，`getByText("Q")` 那条既有断言是它的守门人。
  //     只改字母：符号的 shift 变体在 layered 的符号层里是独立键位，跟着变反而对不上。
  //  2) 第二字符——classic/layered 的 `up` 是「Shift 时的字符」（随 shift 上下互换），
  //     flick 的 `up`/`down` 是「上/下滑发出的字符」（恒定显示在右上/左下角，不随
  //     shift 动）。**不印方向箭头**：键只有 36×46、角标 0.5rem，两个角都塞图形会
  //     糊成一团；角标所在的角本身已经暗示了方向。
  function keyLabel(k: import("../lib/term/keymap").KeyCap): { main: string; upper?: string; lower?: string } {
    const m = activeMods(mods);
    const flick = kbLayout === "flick";
    if (/^[a-z]$/.test(k.id)) {
      const main = kbLayout === "classic"
        ? capFor(k, layout)
        : (m.shift || m.caps ? k.id.toUpperCase() : k.id);
      return flick ? { main, upper: k.up, lower: k.down } : { main };
    }
    const main = capFor(k, layout);
    if (flick) return { main, upper: k.up, lower: k.down };
    if (k.up) return m.shift ? { main: k.up, upper: main } : { main, upper: k.up };
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
    <div class="funcrow" class:big={isBig}>
      <!-- Tab 在 Esc 左边（13 期需求 4）：终端里 Tab 补全比 Esc 高频，
           最左的位置该给更常按的那个。只有大布局的功能行有 Tab——
           classic 的 Tab 在主键区 Q 行最左，照抄笔记本键盘，不动。 -->
      {#if isBig}
        <button class="key fnk" data-key-id="Tab"
          onpointerdown={(e) => { e.preventDefault(); keyDown("Tab"); }}
          onpointerup={() => keyUp("Tab")}
          onpointercancel={() => keyUp("Tab")}
          onpointerleave={() => keyUp("Tab")}>Tab</button>
      {/if}
      <button class="key esc" data-key-id="Esc"
        onpointerdown={(e) => { e.preventDefault(); keyDown("Esc"); }}
        onpointerup={() => keyUp("Esc")}
        onpointercancel={() => keyUp("Esc")}
        onpointerleave={() => keyUp("Esc")}>{ESC_KEY.cap}</button>
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
            <button class="hint-chip"
              onpointerdown={(e) => hintPointerDown(e, h)}
              onpointerup={hintPointerUp}
              onpointercancel={() => (hintDown = undefined)}
              onpointerleave={() => (hintDown = undefined)}>{h}</button>
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
              class:has-down={label.lower}
              data-key-id={k.id}
              style="flex-grow: {k.wide ?? 1};"
              onpointerdown={(e) => { e.preventDefault(); keyDown(k.id); }}
              onpointerup={() => keyUp(k.id)}
              onpointercancel={() => keyUp(k.id)}
              onpointerleave={() => keyUp(k.id)}
            >
              {#if label.upper}<span class="up">{label.upper}</span>{/if}
              <span class="main">{label.main}</span>
              {#if label.lower}<span class="down">{label.lower}</span>{/if}
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
    /* pan-x：把横向滚动交还给浏览器（含惯性），我们不自己实现滚动。
       原先是 none，直接禁掉了原生滚动——这是「联想区滚不动」的另一半原因。 */
    touch-action: pan-x;
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
    /* 五行按比例分掉可用高度，不滚动。
       用固定行高（min-height）会在分割条压低键盘区时把最后一行——**方向键**——
       挤出可视区，而方向键是终端里最高频的键，藏进滚动区等于没有。
       所以高度富余时键更大，高度紧张时一起收缩，行数恒定。 */
    overflow: hidden;
    min-height: 0;
    /* 行高封顶后总高可能小于容器，富余的空白集中到底部一处，
       不要散在行与行之间（那样看起来像行距忽大忽小）。
       **不能用 flex-end**：一旦内容反过来超出容器（比如功能行变高挤占了
       主键区），flex-end 会把最上面一行切掉，比溢出更糟。 */
    justify-content: flex-start;
  }
  .rows.big .row {
    gap: var(--key-gap-x);
    flex: 1 1 0;
    /* 行可以被压到 24px（键盘区被分割条挤到很小时），但不再往下——
       比这更矮主字符自己就该被 overflow:hidden 切了。
       角标不参与这个下限：flick 把它绝对定位到了右上角，不占垂直空间。
       24 是算出来的：默认分割比例下主键区 154px，5 行 + 4 个 5px 行距 +
       上下各 5px padding 需要 5h+30 ≤ 154，即 h ≤ 24.8。 */
    min-height: 24px;
    /* 键高封顶 = 键宽 × 1.5。行高被 flex 拉大时，键不跟着抽成细长竖条——
       那个形状既难看也难按（拇指落点靠键的中心判断，太高会频繁点到相邻行）。
       封顶后多出来的高度留白，行仍均分容器，不会溢出。
       键宽 = (键盘可用宽 - 9 个间隔) / 10 列，可用宽 = 视口宽 - 左右 padding。
       用 100vw 而不是 100%：百分比在 max-height 里是相对父元素**高度**算的，
       写 100% 会得到一个跟宽度毫无关系的值。 */
    max-height: calc(
      (100vw - 2 * var(--key-gap-x) - 9 * var(--key-gap-x)) / 10 * 1.5
    );
  }
  /* 行内键撑满行高。**不设 min-height**：键的下限会顶破被 flex 压扁的行，
     多出来的那几 px 直接变成整个键区的溢出（方向键行又被推出可视区）。
     高度下限交给行来保证（.rows.big .row 的 min-height），键只负责填满行。 */
  .rows.big .key { min-height: 0; height: 100%; font-size: 0.92rem; }
  .rows.big .key.mod { font-size: 0.66rem; }
  /* 副字符一律绝对定位到右上角，不占垂直空间——两套大布局统一。
     上下叠放会让键内容需要 32px 高，而键盘区被分割条压缩时行只有 25px，
     .key 的 overflow:hidden 会把它切掉：flick 是看不见能滑出什么符号，
     layered 符号层是看不见 Shift 能打出什么，两边都等于废掉半个键帽。
     挪到角上，键再矮也切不着，和教程动画里演示的键帽也一致。

     两套布局的 `up` 语义不同，但都适合放角上：
       flick   —— 上滑发出的字符，恒定显示；
       layered —— Shift 时的字符，按下 Shift 时与主字符**互换位置**
                  （keyLabel 负责换，样式只管摆放，互换在角上照样成立）。
     classic 不在此列：它的键更小更密，角标挤在角上会糊成一团，维持叠放。 */
  .rows.big .key.has-up,
  .rows.big .key.has-down { padding-top: 4px; position: relative; }
  .rows.big .key.has-up .up,
  .rows.big .key.has-down .down {
    position: absolute;
    font-size: 0.5rem;
    line-height: 1;
    /* 角标宽度封顶到键宽的三分之一。键被分割条压到 25px 高时，上角标、主字符、
       下角标在**垂直方向本来就重叠**（实测 36×24.8 的键：角标占 3–11 与 13.8–21.8，
       主字符占 5–20），三者互不干扰全靠水平错开。不封顶的话，将来换个更宽的
       符号或更窄的键就会直接撞进主字符里。 */
    max-width: 33%;
    overflow: hidden;
  }
  .rows.big .key.has-up .up { top: 2px; right: 3px; }
  /* 下滑角标在左下角（12 期补全）。位置本身就是方向提示，所以**不加箭头**。
     对角摆放而不是同侧：同侧两个 0.5rem 字符在 36px 宽的键上会挤成一坨，
     且分不清哪个对应哪个方向。 */
  .rows.big .key.has-down .down { bottom: 2px; left: 3px; }
  /* 9 键行缩进半个键宽居中对齐 10 键行。缩进量随 gap 算，写死百分比改 gap 会错位。 */
  .rows.big .row.indent {
    padding: 0 calc((100% - 9 * var(--key-gap-x)) / 20 + var(--key-gap-x) / 2);
  }
  /* 方向键独立行：终端里 ↑ 翻历史、←→ 移光标比字母还高频，值得整整一行 */
  .rows.big .row.arrows .key { font-size: 1.05rem; }
  .rows.big .key.layerkey { background: var(--key-mod-bg); color: var(--dim); font-size: 0.7rem; }
  /* 功能行的 esc / tab：与 esc 并成左侧固定簇，定宽——
     让它跟联想条抢 flex 会被压到 14px，比字母键还难按。
     尺寸写成 px 而不是 em：em 会跟着 font-size:0.62rem 缩水，算下来只有
     30×23，比字母键（36×31）还小，而这两个是终端里最常按的键之一。
     字号仍留 0.62rem——键帽是三个字母，太大反而挤。
     **不碰 .hint-chip**：它有自己的 font-size/min-height，联想条字号不受影响。 */
  .funcrow .key.fnk,
  .funcrow.big .key.esc {
    flex: 0 0 auto;
    min-width: 46px;
    min-height: 34px;
    font-size: 0.62rem;
  }
</style>
