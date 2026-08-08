import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks: pi-kit not yet installed ────────────────────────────────────────

const pickerMocks = vi.hoisted(() => ({
  rankedInputSelect: vi.fn(),
  rankedSelect: vi.fn(),
}));

vi.mock("pi-kit/picker", () => pickerMocks);

const rankingMocks = vi.hoisted(() => ({
  matchScore: vi.fn(),
  rankAndCap: vi.fn(),
}));

vi.mock("pi-kit/ranking", () => rankingMocks);

vi.mock("pi-kit", () => ({
  PI_KIT_VERSION: "0.1.0",
  MINIMUM_PI_VERSION: "0.83.0",
  assertPiVersion: vi.fn(),
}));

// Mock pi-coding-agent SDK (not installed in dev env)
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    forkFrom: vi.fn(),
    create: vi.fn(),
  },
}));

// ─── Test data types ────────────────────────────────────────────────────────

interface TestWorktree {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
}

interface TestHistoryEntry {
  path: string;
  uses: number;
  firstUsed: string;
  lastUsed: string;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("selectWorktree — pi-kit/picker delegation (LD10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockUI = { id: "picker-ui-mock" };

  const worktrees: TestWorktree[] = [
    { path: "/repo", branch: "main", commit: "aaa111", isMain: true },
    { path: "/repo/.worktrees/wt-feat", branch: "feat", commit: "bbb222", isMain: false },
    { path: "/repo/.worktrees/wt-bug", branch: "bugfix", commit: "ccc333", isMain: false },
  ];

  it("delegates to rankedInputSelect with cap=24", async () => {
    const { selectWorktree } = await import("./index.js");

    pickerMocks.rankedInputSelect.mockResolvedValueOnce("wt-feat");

    await selectWorktree(mockUI, worktrees, []);

    expect(pickerMocks.rankedInputSelect).toHaveBeenCalledTimes(1);
    const callArgs = pickerMocks.rankedInputSelect.mock.calls[0];
    expect(callArgs[0]).toBe(mockUI); // ui passed through
    expect(callArgs[2]).toMatchObject({ cap: 24 }); // opts with cap
  });

  it("builds RankableItem[] with value=basename, label=basename", async () => {
    const { selectWorktree } = await import("./index.js");

    pickerMocks.rankedInputSelect.mockResolvedValueOnce(undefined);

    await selectWorktree(mockUI, worktrees, []);

    const items = pickerMocks.rankedInputSelect.mock.calls[0][1];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ value: "repo", label: "repo" });
    expect(items[1]).toMatchObject({ value: "wt-feat", label: "wt-feat" });
    expect(items[2]).toMatchObject({ value: "wt-bug", label: "wt-bug" });
  });

  it("sets searchText = branch + ' ' + path", async () => {
    const { selectWorktree } = await import("./index.js");

    pickerMocks.rankedInputSelect.mockResolvedValueOnce(undefined);

    await selectWorktree(mockUI, worktrees, []);

    const items = pickerMocks.rankedInputSelect.mock.calls[0][1];
    expect(items[1].searchText).toBe("feat /repo/.worktrees/wt-feat");
    expect(items[2].searchText).toBe("bugfix /repo/.worktrees/wt-bug");
  });

  it("calculates baseScore = uses×24 + max(0, 120 - ageDays×4)", async () => {
    const { selectWorktree } = await import("./index.js");

    const now = new Date("2026-08-09T12:00:00Z");
    const twoDaysAgo = new Date("2026-08-07T12:00:00Z").toISOString();
    const tenDaysAgo = new Date("2026-07-30T12:00:00Z").toISOString();

    const history: TestHistoryEntry[] = [
      { path: "/repo/.worktrees/wt-feat", uses: 3, firstUsed: twoDaysAgo, lastUsed: twoDaysAgo },
      { path: "/repo/.worktrees/wt-bug", uses: 1, firstUsed: tenDaysAgo, lastUsed: tenDaysAgo },
    ];

    pickerMocks.rankedInputSelect.mockResolvedValueOnce(undefined);
    await selectWorktree(mockUI, worktrees, history, now);

    const items = pickerMocks.rankedInputSelect.mock.calls[0][1];

    // wt-feat: 3×24 + max(0, 120 - 2×4) = 72 + 112 = 184
    expect(items[1].baseScore).toBe(184);
    // wt-bug: 1×24 + max(0, 120 - 10×4) = 24 + 80 = 104
    expect(items[2].baseScore).toBe(104);
    // repo (main): no history → baseScore = 0
    expect(items[0].baseScore).toBe(0);
  });

  it("returns the Worktree matching the selected value", async () => {
    const { selectWorktree } = await import("./index.js");

    pickerMocks.rankedInputSelect.mockResolvedValueOnce("wt-bug");

    const result = await selectWorktree(mockUI, worktrees, []);

    expect(result).toBeDefined();
    expect(result.path).toBe("/repo/.worktrees/wt-bug");
    expect(result.branch).toBe("bugfix");
  });

  it("returns undefined when rankedInputSelect returns undefined", async () => {
    const { selectWorktree } = await import("./index.js");

    pickerMocks.rankedInputSelect.mockResolvedValueOnce(undefined);

    const result = await selectWorktree(mockUI, worktrees, []);

    expect(result).toBeUndefined();
  });
});
