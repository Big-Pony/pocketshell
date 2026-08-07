// 「这次触摸是点击还是滚动」的判定。
//
// 用途：让横向可滚的列表（键盘联想条）既能点又能滑。按下那一刻分不清用户
// 想点还是想滑——两个动作的开头完全一样，只有抬手时手指走过多远才成定局。
// 这与 Keyboard.svelte 里带滑动的键「抬手才结算」是同一套心智。
export interface Pt { x?: number; y?: number }

// 合成事件可能只带部分坐标（jsdom 没有原生 PointerEvent），缺失当 0。
// 不能让 undefined 流进减法：NaN 参与的比较一律为 false，会把整条判定静默废掉。
const n = (v: number | undefined) => (Number.isFinite(v as number) ? (v as number) : 0);

/** 位移不超过阈值即为点击。默认 10px。 */
export function isTap(down: Pt, up: Pt, thresholdPx = 10): boolean {
  // 用合成位移而非只看 dx：联想条虽只能横滚，但斜向拖动常带竖向分量，
  // 只看 dx 会把明显的拖动误判成点击。
  return Math.hypot(n(up.x) - n(down.x), n(up.y) - n(down.y)) <= thresholdPx;
}
