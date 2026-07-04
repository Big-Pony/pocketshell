// P1c destructive-action guard: delete requires two taps on the confirm button
// within a short window. First tap arms (UI shows a warning state); a second tap
// inside windowMs fires; a late second tap just re-arms (fresh timer).
export interface ArmState { armed: boolean; armedAt: number }
export const IDLE: ArmState = { armed: false, armedAt: 0 };
const DEFAULT_WINDOW = 2000;

export function press(state: ArmState, now: number, windowMs = DEFAULT_WINDOW): { state: ArmState; fire: boolean } {
  if (state.armed && now - state.armedAt <= windowMs) return { state: IDLE, fire: true };
  return { state: { armed: true, armedAt: now }, fire: false };
}
