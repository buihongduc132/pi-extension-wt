import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

type Worktree = {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
};

type WtConfig = {
  sort?: "created" | "updated";
};

const STATUS_KEY = "wt";

// ─── Config Helpers ──────────────────────────────────────────────────────────

function expandTilde(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim()
    ? expandTilde(process.env.PI_CODING_AGENT_DIR!.trim())
    : path.join(os.homedir(), ".pi", "agent");
}

function getConfigPath(): string {
  const envPath = process.env.PI_WT_CONFIG_PATH?.trim();
  if (envPath) return expandTilde(envPath);
  return path.join(getAgentDir(), "wt.json");
}

function readConfig(): WtConfig {
  try {
    if (!fs.existsSync(getConfigPath())) return {};
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as WtConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: WtConfig): void {
  try {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch {
    // Config persistence is best-effort
  }
}

export function getDefaultSort(): "created" | "updated" {
  return "created";
}

export function loadSort(): "created" | "updated" {
  return readConfig().sort || getDefaultSort();
}

export function persistSort(sort: "created" | "updated"): void {
  const config = readConfig();
  config.sort = sort;
  writeConfig(config);
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
    const output = execSync("git rev-parse --show-toplevel 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null", {
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    // git-common-dir points to .git, parent is the main worktree root
    if (output.endsWith("/.git") || output === ".git") {
      return path.dirname(output === ".git" ? path.join(cwd, output) : output);
    }

    return output || undefined;
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
    withSession: (nextCtx) => {
      nextCtx.ui.setStatus(STATUS_KEY, `wt ${path.basename(worktreePath)}`);
      nextCtx.ui.notify(`wt → ${path.basename(worktreePath)}`, "info");
    },
  });
}

// ─── TUI Picker ──────────────────────────────────────────────────────────────

async function selectWorktree(
  ctx: ExtensionCommandContext,
  worktrees: Worktree[],
): Promise<Worktree | undefined> {
  if (!ctx.hasUI || worktrees.length === 0) return undefined;

  let sort = loadSort();

  const buildItems = (): string[] => {
    const sorted = [...worktrees].sort((a, b) => {
      if (sort === "created") {
        // Real creation time: use birthtimeMs (file creation time)
        try {
          return fs.statSync(b.path).birthtimeMs - fs.statSync(a.path).birthtimeMs;
        } catch {
          return 0;
        }
      }
      // updated = mtime (last modification time)
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
  // Fallback hook: if cwd is gone, switch to main worktree
  pi.on("session_start", (_event, ctx) => {
    if (isCwdGone(ctx.cwd)) {
      const main = findMainWorktree(ctx.cwd);
      if (main && fs.existsSync(main)) {
        ctx.ui.notify(`wt: worktree gone (${ctx.cwd}), falling back to main`, "warning");

        const targetSession = SessionManager.create(main).getSessionFile();
        if (targetSession) {
          ctx.switchSession(targetSession, {
            withSession: (nextCtx) => {
              nextCtx.ui.setStatus(STATUS_KEY, "wt main");
              nextCtx.ui.notify(`wt → main (${main})`, "info");
            },
          });
        }
      } else {
        ctx.ui.setStatus(STATUS_KEY, "wt BROKEN (cwd gone, no main found)");
      }
    } else {
      ctx.ui.setStatus(STATUS_KEY, `wt ${path.basename(ctx.cwd)}`);
    }
  });

  pi.registerCommand("wt", {
    description: "Switch pi session to git worktree",
    getArgumentCompletions: (prefix: string) => {
      const worktrees = getWorktrees(process.cwd());
      const matching = worktrees.filter((wt) =>
        path.basename(wt.path).startsWith(prefix),
      );
      return matching.length > 0
        ? matching.map((wt) => ({
            value: path.basename(wt.path),
            label: path.basename(wt.path),
            description: wt.branch,
          }))
        : null;
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
        const worktrees = getWorktrees(ctx.cwd);
        if (worktrees.length === 0) {
          ctx.ui.notify("No worktrees found", "info");
          return;
        }
        const selected = await selectWorktree(ctx, worktrees);
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
