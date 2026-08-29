export const TAB_DETACH_GRACE_MS = 2_000;

export interface StreamPolicyState {
  current: string | null;
  grace: string | null;
}

export interface StreamTransition {
  state: StreamPolicyState;
  stream: string[];
  detachNow: string[];
  scheduleDetach: string | null;
}

export interface StreamStop {
  state: StreamPolicyState;
  stream: string[];
  detachNow: string[];
  preserveGraceTimer: boolean;
}

function streamIds(state: StreamPolicyState): string[] {
  return [...new Set([state.current, state.grace].filter((id): id is string => id !== null))];
}

export function switchStream(
  previous: StreamPolicyState,
  nextTerminal: string | null,
): StreamTransition {
  if (nextTerminal === previous.current) {
    return { state: previous, stream: [], detachNow: [], scheduleDetach: null };
  }

  const oldCurrent = previous.current;
  const oldGrace = previous.grace;
  const grace = oldCurrent && oldCurrent !== nextTerminal ? oldCurrent : null;
  const state = { current: nextTerminal, grace };
  const detachNow = oldGrace && oldGrace !== nextTerminal && oldGrace !== oldCurrent
    ? [oldGrace]
    : [];

  return {
    state,
    stream: streamIds(state),
    detachNow,
    scheduleDetach: grace,
  };
}

export function stopStream(previous: StreamPolicyState, sessionId: string): StreamStop {
  if (previous.current !== sessionId && previous.grace !== sessionId) {
    return {
      state: previous,
      stream: [],
      detachNow: [sessionId],
      preserveGraceTimer: true,
    };
  }

  const state = {
    current: previous.current === sessionId ? null : previous.current,
    grace: previous.grace === sessionId ? null : previous.grace,
  };

  return {
    state,
    stream: streamIds(state),
    detachNow: [sessionId],
    preserveGraceTimer: false,
  };
}

export function graceExpiryIsCurrent(
  captured: { sessionId: string; generation: number },
  current: { state: StreamPolicyState; generation: number; streaming: ReadonlySet<string> },
): boolean {
  return current.generation === captured.generation
    && current.state.grace === captured.sessionId
    && current.state.current !== captured.sessionId
    && current.streaming.has(captured.sessionId);
}
