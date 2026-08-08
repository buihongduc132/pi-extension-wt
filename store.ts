/**
 * store.ts — AtomicJsonStore factories for wt.json + state/wt-history.json.
 *
 * LD3: AtomicJsonStore for both config and history (separate files).
 * LD4: version: 1 field in all JSON stores.
 * LD5: history in separate file state/wt-history.json.
 */

import { AtomicJsonStore, type VersionedStore } from "pi-kit/store";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Worktree {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

export interface WtConfig extends VersionedStore {
  sort: "created" | "updated";
}

export interface WtHistoryEntry {
  path: string;
  uses: number;
  firstUsed: string;
  lastUsed: string;
}

export interface WtHistory extends VersionedStore {
  history: WtHistoryEntry[];
}

// ─── Factories ───────────────────────────────────────────────────────────────

export function createConfigStore(agentDir: string): AtomicJsonStore<WtConfig> {
  return new AtomicJsonStore<WtConfig>(
    path.join(agentDir, "wt.json"),
    1,
    { version: 1, sort: "created" },
  );
}

export function createHistoryStore(agentDir: string): AtomicJsonStore<WtHistory> {
  return new AtomicJsonStore<WtHistory>(
    path.join(agentDir, "state", "wt-history.json"),
    1,
    { version: 1, history: [] },
  );
}
