/**
 * history.ts — Visit recording + recency scoring + cap enforcement.
 *
 * LD5: History persisted in separate state/wt-history.json.
 * LD9: MAX_HISTORY_ENTRIES cap evicts oldest by lastUsed.
 *
 * Score formula: baseScore + uses×24 + max(0, 120 - ageDays×4)
 */

import type { AtomicJsonStore } from "pi-kit/store";
import type { WtHistory, WtHistoryEntry } from "./store.js";

export const MAX_HISTORY_ENTRIES = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Record a visit to a worktree path.
 * Increments uses for existing entries, creates new entries (unshifted to front).
 * Evicts oldest by lastUsed when exceeding MAX_HISTORY_ENTRIES.
 */
export function recordVisit(
  store: AtomicJsonStore<WtHistory>,
  wtPath: string,
  now: Date = new Date(),
): void {
  const data = store.read();
  const isoNow = now.toISOString();
  const existing = data.history.find((e) => e.path === wtPath);

  if (existing) {
    existing.uses += 1;
    existing.lastUsed = isoNow;
  } else {
    data.history.unshift({
      path: wtPath,
      uses: 1,
      firstUsed: isoNow,
      lastUsed: isoNow,
    });
  }

  // Evict oldest by lastUsed when over cap
  if (data.history.length > MAX_HISTORY_ENTRIES) {
    data.history.sort(
      (a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
    );
    data.history = data.history.slice(0, MAX_HISTORY_ENTRIES);
  }

  store.write(data);
}

/**
 * Compute ranking score: baseScore + uses×24 + max(0, 120 - ageDays×4).
 * Returns baseScore unchanged when entry is undefined.
 */
export function computeScore(
  baseScore: number,
  entry: WtHistoryEntry | undefined,
  now: Date,
): number {
  if (!entry) return baseScore;
  const ageMs = now.getTime() - new Date(entry.lastUsed).getTime();
  const ageDays = Math.floor(ageMs / MS_PER_DAY);
  const recency = Math.max(0, 120 - ageDays * 4);
  return baseScore + entry.uses * 24 + recency;
}
