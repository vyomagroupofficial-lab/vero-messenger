/**
 * Full-screen story viewer as a pure state machine (unit-tested).
 *
 * The viewer walks a list of groups (one per author, in tray order), each a
 * list of story ids. A story starts "loading" (durationMs = null) until the
 * screen reports READY with its duration (fixed for text/photo, the clip
 * length for video). TICKs advance the clock unless something holds it:
 * pauses are reason-counted ('hold', 'reply', 'sheet', 'background') so a
 * finger lifting doesn't resume while the reply box is still open.
 */

export const TEXT_STORY_MS = 5_000;
export const PHOTO_STORY_MS = 6_000;

export type PauseReason = 'hold' | 'reply' | 'sheet' | 'background';

export interface ViewerState {
  groups: string[][];
  group: number;
  index: number;
  elapsedMs: number;
  /** null while the current story's media is loading. */
  durationMs: number | null;
  pausedBy: PauseReason[];
  closed: boolean;
}

export type ViewerAction =
  | { type: 'TICK'; dt: number }
  | { type: 'READY'; storyId: string; durationMs: number }
  | { type: 'NEXT' }
  | { type: 'PREV' }
  | { type: 'NEXT_GROUP' }
  | { type: 'PAUSE'; reason: PauseReason }
  | { type: 'RESUME'; reason: PauseReason }
  | { type: 'REMOVE'; storyId: string }
  | { type: 'CLOSE' };

export function initViewer(groups: string[][], startGroup = 0, startIndex = 0): ViewerState {
  const nonEmpty = groups.filter((g) => g.length > 0);
  const offset = groups.slice(0, startGroup).filter((g) => g.length === 0).length;
  const group = Math.min(Math.max(0, startGroup - offset), Math.max(0, nonEmpty.length - 1));
  const index = nonEmpty.length ? Math.min(Math.max(0, startIndex), nonEmpty[group].length - 1) : 0;
  return {
    groups: nonEmpty,
    group,
    index,
    elapsedMs: 0,
    durationMs: null,
    pausedBy: [],
    closed: nonEmpty.length === 0,
  };
}

export function currentStoryId(s: ViewerState): string | null {
  if (s.closed) return null;
  return s.groups[s.group]?.[s.index] ?? null;
}

export function isPaused(s: ViewerState): boolean {
  return s.pausedBy.length > 0;
}

/** Fill (0..1) of progress bar `i` in the current group. */
export function progressAt(s: ViewerState, i: number): number {
  if (i < s.index) return 1;
  if (i > s.index || !s.durationMs) return 0;
  return Math.min(1, s.elapsedMs / s.durationMs);
}

function goTo(s: ViewerState, group: number, index: number): ViewerState {
  return { ...s, group, index, elapsedMs: 0, durationMs: null };
}

function next(s: ViewerState): ViewerState {
  if (s.index + 1 < s.groups[s.group].length) return goTo(s, s.group, s.index + 1);
  if (s.group + 1 < s.groups.length) return goTo(s, s.group + 1, 0);
  return { ...s, closed: true, elapsedMs: s.durationMs ?? s.elapsedMs };
}

function prev(s: ViewerState): ViewerState {
  if (s.index > 0) return goTo(s, s.group, s.index - 1);
  if (s.group > 0) return goTo(s, s.group - 1, s.groups[s.group - 1].length - 1);
  // First story overall: restart it.
  return { ...s, elapsedMs: 0 };
}

export function viewerReducer(s: ViewerState, a: ViewerAction): ViewerState {
  if (s.closed && a.type !== 'CLOSE') return s;
  switch (a.type) {
    case 'TICK': {
      if (isPaused(s) || s.durationMs === null || a.dt <= 0) return s;
      const elapsedMs = s.elapsedMs + a.dt;
      return elapsedMs >= s.durationMs ? next(s) : { ...s, elapsedMs };
    }
    case 'READY':
      if (a.storyId !== currentStoryId(s) || s.durationMs !== null) return s;
      return { ...s, durationMs: Math.max(1, a.durationMs) };
    case 'NEXT':
      return next(s);
    case 'PREV':
      return prev(s);
    case 'NEXT_GROUP':
      return s.group + 1 < s.groups.length ? goTo(s, s.group + 1, 0) : { ...s, closed: true };
    case 'PAUSE':
      return s.pausedBy.includes(a.reason) ? s : { ...s, pausedBy: [...s.pausedBy, a.reason] };
    case 'RESUME':
      return s.pausedBy.includes(a.reason) ? { ...s, pausedBy: s.pausedBy.filter((r) => r !== a.reason) } : s;
    case 'REMOVE': {
      const gi = s.groups.findIndex((g) => g.includes(a.storyId));
      if (gi < 0) return s;
      const ii = s.groups[gi].indexOf(a.storyId);
      const wasCurrent = gi === s.group && ii === s.index;
      const groups = s.groups.map((g, i) => (i === gi ? g.filter((id) => id !== a.storyId) : g));
      let group = s.group;
      let index = s.index;
      if (gi === s.group && ii < s.index) index -= 1;
      // Drop an emptied group.
      if (groups[gi].length === 0) {
        groups.splice(gi, 1);
        if (gi < group) group -= 1;
        else if (gi === group) index = 0;
      }
      if (groups.length === 0) return { ...s, groups, closed: true };
      if (group >= groups.length) return { ...s, groups, closed: true };
      if (index >= groups[group].length) {
        // Removed the last story of the current group: continue with the next group.
        if (group + 1 < groups.length) return goTo({ ...s, groups }, group + 1, 0);
        return { ...s, groups, closed: true };
      }
      const moved = { ...s, groups, group, index };
      return wasCurrent ? { ...moved, elapsedMs: 0, durationMs: null } : moved;
    }
    case 'CLOSE':
      return { ...s, closed: true };
  }
}
