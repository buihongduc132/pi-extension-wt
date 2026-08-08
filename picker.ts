/**
 * picker.ts — Ranked worktree picker delegating to pi-kit/picker.
 *
 * LD10: 2-stage flow via pi-kit/picker rankedInputSelect.
 * Score = uses×24 + max(0, 120 - ageDays×4) from history entries.
 */

import * as path from "node:path";
import { rankedInputSelect, type PickerUI } from "pi-kit/picker";
import type { RankableItem } from "pi-kit/ranking";
import type { Worktree, WtHistoryEntry } from "./store.js";
import { computeScore } from "./history.js";

/**
 * Build RankableItem[] from worktrees + history for the picker.
 * - value/label = path basename
 * - searchText = "${branch} ${path}"
 * - baseScore = uses×24 + max(0, 120 - ageDays×4)
 */
function buildRankableItems(
  worktrees: Worktree[],
  history: WtHistoryEntry[],
  now: Date,
): RankableItem[] {
  return worktrees.map((wt) => {
    const entry = history.find((h) => h.path === wt.path);
    return {
      value: path.basename(wt.path),
      label: path.basename(wt.path),
      searchText: `${wt.branch} ${wt.path}`,
      baseScore: computeScore(0, entry, now),
    };
  });
}

/**
 * Select a worktree via pi-kit/picker rankedInputSelect (LD10).
 * Returns the selected Worktree or undefined on cancel.
 */
export async function selectWorktree(
  ui: PickerUI,
  worktrees: Worktree[],
  history: WtHistoryEntry[],
  now: Date = new Date(),
): Promise<Worktree | undefined> {
  const items = buildRankableItems(worktrees, history, now);

  const selected = await rankedInputSelect(ui, items, {
    cap: 24,
    inputTitle: "Filter worktrees",
    selectTitle: "Select worktree",
  });

  if (!selected) return undefined;

  // rankedInputSelect returns RankableItem in production; tests may return a string
  const value = typeof selected === "string" ? selected : selected.value;
  return worktrees.find((wt) => path.basename(wt.path) === value);
}
