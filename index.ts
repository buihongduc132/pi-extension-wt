import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertPiVersion, PI_KIT_VERSION } from "pi-kit";
import { rankAndCap, matchScore } from "pi-kit/ranking";

// ─── Module re-exports ───────────────────────────────────────────────────────

import type { Worktree } from "./store.js";
import {
  getDefaultSort,
  parseSortArg,
  loadSort,
  persistSort,
  getAgentDir,
} from "./sort.js";
export { getDefaultSort, parseSortArg, loadSort, persistSort };

export { createConfigStore, createHistoryStore } from "./store.js";
export type { Worktree, WtConfig, WtHistoryEntry, WtHistory } from "./store.js";

export { recordVisit, computeScore, MAX_HISTORY_ENTRIES } from "./history.js";

export { selectWorktree } from "./picker.js";

// ─── LD16: version sentinel logged at init ───────────────────────────────────

console.debug(`[wt] pi-kit@${PI_KIT_VERSION}`);

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_KEY = "wt";

// ─── Host pi version detection (LD8, LD13) ──────────────────────────────────

function getHostPiVersion(): string {
  try {
    return process.env.PI_VERSION?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ─── Worktree Parsing ────────────────────────────────────────────────────────

export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  const lines = output.split("\n");

  let current: Partial<Worktree> & { isMain?: boolean } = {};
  let isFirst = true;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("worktree ")) {
      // Save previous worktree
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || "",
          commit: current.commit || "",
          isMain: isFirst === false ? (current.isMain ?? false) : true,
        });
      }
      current = { path: trimmed.slice("worktree ".length) };
      current.isMain = isFirst;
      isFirst = false;
    } else if (trimmed.startsWith("HEAD ")) {
      current.commit = trimmed.slice("HEAD ".length);
    } else if (trimmed.startsWith("branch ")) {
      current.branch = trimmed.slice("branch refs/heads/".length);
    } else if (trimmed === "detached") {
      current.branch = "(detached)";
    }
  }

  // Save last worktree
  if (current.path) {
    worktrees.push({
      path: current.path,
      branch: current.branch || "",
      commit: current.commit || "",
      isMain: worktrees.length === 0,
    });
  }

  return worktrees;
}

function getWorktrees(cwd: string): Worktree[] {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    return parseWorktreeList(output);
  } catch {
    return [];
  }
}

// ─── Fallback Helpers ────────────────────────────────────────────────────────

export function isCwdGone(cwd: string): boolean {
  return !fs.existsSync(cwd);
}

export function findMainWorktree(cwd: string): string | undefined {
  try {
    // If cwd exists, use it directly
    if (fs.existsSync(cwd)) {
      const output = execSync("git rev-parse --show-toplevel 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null", {
        cwd,
        encoding: "utf8",
        timeout: 5000,
      }).trim();

      // git-common-dir points to .git, parent is the main worktree root
      if (output.endsWith("/.git") || output === ".git") {
        return path.dirname(output === ".git" ? path.join(cwd, output) : output);
      }

      return output || undefined;
    }

    // If cwd is deleted, try to find main worktree from state file
    const stateFile = path.join(getAgentDir(), "state", "main-worktree.json");
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (state.mainWorktree && fs.existsSync(state.mainWorktree)) {
          return state.mainWorktree;
        }
      } catch {
        // State file corrupt, continue
      }
    }

    // Fallback: try parent directories
    let dir = path.dirname(cwd);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) {
        return dir;
      }
      dir = path.dirname(dir);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Session Fork ────────────────────────────────────────────────────────────

export async function forkSessionToWorktree(
  ctx: ExtensionCommandContext,
  worktreePath: string,
): Promise<void> {
  if (!fs.existsSync(worktreePath)) {
    ctx.ui.notify(`wt: worktree does not exist: ${worktreePath}`, "error");
    return;
  }

  await ctx.waitForIdle();

  const currentSessionPath = ctx.sessionManager.getSessionFile();
  let targetSessionPath: string;

  if (currentSessionPath && fs.existsSync(currentSessionPath)) {
    try {
      const forked = SessionManager.forkFrom(currentSessionPath, worktreePath);
      targetSessionPath = forked.getSessionFile()!;
    } catch {
      targetSessionPath = SessionManager.create(worktreePath).getSessionFile()!;
    }
  } else {
    targetSessionPath = SessionManager.create(worktreePath).getSessionFile()!;
  }

  await ctx.switchSession(targetSessionPath, {
    withSession: async (nextCtx) => {
      nextCtx.ui.setStatus(STATUS_KEY, `wt ${path.basename(worktreePath)}`);
      nextCtx.ui.notify(`wt → ${path.basename(worktreePath)}`, "info");
    },
  });
}

// ─── TUI Picker (legacy ctx.ui.select-based, used by /wt handler) ───────────

async function selectWorktreeTUI(
  ctx: ExtensionCommandContext,
  worktrees: Worktree[],
): Promise<Worktree | undefined> {
  if (!ctx.hasUI || worktrees.length === 0) return undefined;

  let sort = loadSort();

  const buildItems = (): string[] => {
    const sorted = [...worktrees].sort((a, b) => {
      if (sort === "created") {
        try {
          return fs.statSync(b.path).birthtimeMs - fs.statSync(a.path).birthtimeMs;
        } catch {
          return 0;
        }
      }
      try {
        return fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs;
      } catch {
        return 0;
      }
    });

    return sorted.map((wt, index) => {
      const mainMark = wt.isMain ? "★" : "↳";
      const name = path.basename(wt.path);
      const branch = wt.branch;
      return `${mainMark} ${name} — ${branch} [${index + 1}]`;
    });
  };

  let items = buildItems();
  let selected = await ctx.ui.select(`Worktrees (sort: ${sort}, press 's' to toggle)`, items);

  // If user typed 's', toggle sort and re-prompt
  while (selected === "s" || selected === "") {
    sort = sort === "created" ? "updated" : "created";
    persistSort(sort);
    items = buildItems();
    selected = await ctx.ui.select(`Worktrees (sort: ${sort}, press 's' to toggle)`, items);
  }

  if (!selected) return undefined;

  const index = items.indexOf(selected);
  if (index < 0) return undefined;

  const sorted = [...worktrees].sort((a, b) => {
    if (sort === "created") {
      try {
        return fs.statSync(b.path).birthtimeMs - fs.statSync(a.path).birthtimeMs;
      } catch {
        return 0;
      }
    }
    try {
      return fs.statSync(b.path).mtimeMs - fs.statSync(a.path).mtimeMs;
    } catch {
      return 0;
    }
  });

  return sorted[index];
}

// ─── Extension Entry ─────────────────────────────────────────────────────────

export default function wtExtension(pi: ExtensionAPI): void {
  // LD13: assert pi version compatibility at session_start
  pi.on("session_start", (_event, ctx) => {
    try {
      assertPiVersion(getHostPiVersion());
    } catch {
      // Non-fatal: version mismatch doesn't block session
    }

    if (isCwdGone(ctx.cwd)) {
      ctx.ui.notify(`wt: cwd gone (${ctx.cwd}) — run /wt to switch`, "warning");
      ctx.ui.setStatus(STATUS_KEY, "wt: ⚠ cwd gone — run /wt to switch");
    } else {
      // Save main worktree path to state for fallback recovery
      try {
        const mainPath = findMainWorktree(ctx.cwd);
        if (mainPath) {
          const stateDir = path.join(getAgentDir(), "state");
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          fs.writeFileSync(
            path.join(stateDir, "main-worktree.json"),
            JSON.stringify({ mainWorktree: mainPath, savedAt: new Date().toISOString() }),
          );
        }
      } catch {
        // Non-fatal: state save failed
      }
      ctx.ui.setStatus(STATUS_KEY, `wt ${path.basename(ctx.cwd)}`);
    }
  });

  pi.registerCommand("wt", {
    description: "Switch pi session to git worktree",
    getArgumentCompletions: (prefix: string) => {
      const worktrees = getWorktrees(process.cwd());
      const items = worktrees.map((wt) => ({
        value: path.basename(wt.path),
        label: path.basename(wt.path),
        searchText: wt.branch,
        description: wt.branch,
      }));
      const ranked = rankAndCap(items, prefix);
      // rankAndCap keeps zero-score items (fuzzyScore returns 0, not -∞);
      // post-filter to drop non-matches for real prefix filtering
      const matching = ranked.filter((item) => {
        const score = matchScore(item, prefix);
        return typeof score === "number" ? score > 0 : true;
      });
      return matching.length > 0 ? matching : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "--list") {
        const worktrees = getWorktrees(ctx.cwd);
        if (worktrees.length === 0) {
          ctx.ui.notify("No worktrees found", "info");
          return;
        }
        const lines = worktrees.map((wt) => {
          const mainMark = wt.isMain ? " (main)" : "";
          return `${path.basename(wt.path)}${mainMark}: ${wt.branch}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (trimmed === "--status") {
        ctx.ui.notify(`Current worktree: ${path.basename(ctx.cwd)}`, "info");
        return;
      }

      if (!trimmed) {
        // Auto-fallback: if cwd is gone, switch to main worktree
        if (isCwdGone(ctx.cwd)) {
          const mainPath = findMainWorktree(ctx.cwd);
          if (mainPath && fs.existsSync(mainPath)) {
            ctx.ui.notify(`wt: cwd gone, falling back to main`, "warning");
            await forkSessionToWorktree(ctx, mainPath);
            return;
          }
          ctx.ui.notify("wt: cwd gone and main worktree not found", "error");
          return;
        }

        const worktrees = getWorktrees(ctx.cwd);
        if (worktrees.length === 0) {
          ctx.ui.notify("No worktrees found", "info");
          return;
        }
        const selected = await selectWorktreeTUI(ctx, worktrees);
        if (selected) {
          await forkSessionToWorktree(ctx, selected.path);
        }
        return;
      }

      // Direct: /wt <name>
      const worktrees = getWorktrees(ctx.cwd);
      const found = worktrees.find(
        (wt) =>
          path.basename(wt.path) === trimmed ||
          path.basename(wt.path) === `wt-${trimmed}` ||
          wt.branch === trimmed,
      );

      if (!found) {
        ctx.ui.notify(`wt: worktree not found: ${trimmed}`, "error");
        return;
      }

      await forkSessionToWorktree(ctx, found.path);
    },
  });
}
