// app/src/lib/status-bar-tip.ts
// 分割条「双击全屏」微提示的一次性标记。单独一个 localStorage key，不进
// ps.settings —— 它不是用户偏好，是「这个人已经知道这个手势了」的事实，
// 没有对应的设置项可调，也不该出现在设置面板里。

const KEY = "ps.statusbar.tipSeen";

export function loadTipSeen(store: Storage | undefined = safeStore()): boolean {
  try {
    return store?.getItem(KEY) === "1";
  } catch {
    // 隐私模式下 localStorage 可能抛异常：当成「没看过」，最多多提示一次
    return false;
  }
}

export function saveTipSeen(store: Storage | undefined = safeStore()): void {
  try {
    store?.setItem(KEY, "1");
  } catch {
    // 存不下就算了，提示会再出现一次，不影响功能
  }
}

function safeStore(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}
