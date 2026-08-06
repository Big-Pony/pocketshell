// app/src/lib/term/kb-tutorial.ts
// 键盘教程弹窗的「看过没有」标记。抽成纯逻辑（注入 Storage）是为了能单测——
// 与 lib/ui/status-bar-tip.ts 同构，key 前缀也对齐那边的 ps.statusbar.tipSeen。
//
// classic 不弹教程：它是默认值，也没有需要学的新概念。

import type { KbLayoutId } from "./keymap";

export type TutorialId = "layered" | "flick";

const PREFIX = "ps.kbTutSeen.";

/** 该布局对应的教程 id；classic 返回 null（无教程）。 */
export function tutorialFor(id: KbLayoutId): TutorialId | null {
  return id === "layered" || id === "flick" ? id : null;
}

function store(s?: Storage): Storage | null {
  if (s) return s;
  return typeof localStorage !== "undefined" ? localStorage : null;
}

/**
 * 是否该弹教程。Storage 不可用或抛异常时一律返回 false——
 * 隐私模式下弹不出教程只是少个提示，把键盘搞崩才是事故。
 */
export function shouldShowTutorial(id: KbLayoutId, s?: Storage): boolean {
  const tut = tutorialFor(id);
  if (!tut) return false;
  const st = store(s);
  if (!st) return false;
  try {
    return st.getItem(PREFIX + tut) !== "1";
  } catch {
    return false;
  }
}

export function markTutorialSeen(id: KbLayoutId, s?: Storage): void {
  const tut = tutorialFor(id);
  if (!tut) return;
  try {
    store(s)?.setItem(PREFIX + tut, "1");
  } catch { /* 配额满 / 隐私模式：教程会再弹一次，不是问题 */ }
}

export function resetTutorial(id: KbLayoutId, s?: Storage): void {
  const tut = tutorialFor(id);
  if (!tut) return;
  try {
    store(s)?.removeItem(PREFIX + tut);
  } catch { /* 同上 */ }
}
