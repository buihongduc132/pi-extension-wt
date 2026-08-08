import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mocks: pi-kit/store with real I/O (shared with store.test.ts) ───────────

vi.mock("pi-kit/store", async () => {
  const fs = await import("node:fs");
  const nodePath = await import("node:path");

  class AtomicJsonStore<T extends { version: number }> {
    readonly path: string;
    private readonly schemaVersion: number;
    private readonly defaultValue: T;

    constructor(filePath: string, schemaVersion: number, defaultValue: T) {
      this.path = filePath;
      this.schemaVersion = schemaVersion;
      this.defaultValue = defaultValue;
    }

    read(): T {
      try {
        if (fs.existsSync(this.path)) {
          return JSON.parse(fs.readFileSync(this.path, "utf8")) as T;
        }
      } catch {
        // fall through to default
      }
      return { ...this.defaultValue };
    }

    write(data: T): void {
      const dir = nodePath.dirname(this.path);
      fs.mkdirSync(dir, { recursive: true });
      const stamped = { ...data, version: this.schemaVersion };
      const tmpPath = this.path + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(stamped, null, 2));
      fs.renameSync(tmpPath, this.path);
    }

    clear(): void {
      try {
        fs.unlinkSync(this.path);
      } catch {
        // ignore
      }
    }
  }

  return { AtomicJsonStore };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    forkFrom: vi.fn(),
    create: vi.fn(),
  },
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("history — recordVisit + scoring + cap (LD5, LD9)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-history-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── recordVisit ───────────────────────────────────────────────────────────

  it("recordVisit increments uses for existing entry, updates lastUsed", async () => {
    const { recordVisit, createHistoryStore } = await import("./index.js");
    const store = createHistoryStore(tmpDir);

    store.write({
      version: 1,
      history: [
        { path: "/repo/wt-feat", uses: 2, firstUsed: "2026-01-01", lastUsed: "2026-01-02" },
      ],
    } as any);

    const now = new Date("2026-08-09T12:00:00Z");
    recordVisit(store, "/repo/wt-feat", now);

    const data = store.read();
    expect(data.history).toHaveLength(1);
    expect(data.history[0].uses).toBe(3);
    expect(data.history[0].lastUsed).toBe(now.toISOString());
    // firstUsed unchanged on revisit
    expect(data.history[0].firstUsed).toBe("2026-01-01");
  });

  it("recordVisit creates new entry for unknown path with uses=1", async () => {
    const { recordVisit, createHistoryStore } = await import("./index.js");
    const store = createHistoryStore(tmpDir);

    const now = new Date("2026-08-09T12:00:00Z");
    recordVisit(store, "/repo/wt-new", now);

    const data = store.read();
    expect(data.history).toHaveLength(1);
    expect(data.history[0]).toEqual({
      path: "/repo/wt-new",
      uses: 1,
      firstUsed: now.toISOString(),
      lastUsed: now.toISOString(),
    });
  });

  it("recordVisit unshifts new entry to front (most-recent-first ordering)", async () => {
    const { recordVisit, createHistoryStore } = await import("./index.js");
    const store = createHistoryStore(tmpDir);

    store.write({
      version: 1,
      history: [
        { path: "/old", uses: 5, firstUsed: "2026-01-01", lastUsed: "2026-01-01" },
      ],
    } as any);

    const now = new Date("2026-08-09T12:00:00Z");
    recordVisit(store, "/new", now);

    const data = store.read();
    expect(data.history[0].path).toBe("/new");
    expect(data.history[1].path).toBe("/old");
  });

  // ── computeScore ──────────────────────────────────────────────────────────

  it("computeScore = baseScore + uses×24 + max(0, 120 - ageDays×4)", async () => {
    const { computeScore } = await import("./index.js");

    const now = new Date("2026-08-09T12:00:00Z");

    // 2 days ago, 3 uses, baseScore 10
    // score = 10 + 3×24 + max(0, 120 - 2×4) = 10 + 72 + 112 = 194
    const recent = {
      path: "/x",
      uses: 3,
      firstUsed: "2026-01-01",
      lastUsed: new Date("2026-08-07T12:00:00Z").toISOString(),
    };
    expect(computeScore(10, recent, now)).toBe(194);

    // 40 days ago → ageDays×4 = 160 > 120 → recency floored at 0
    // score = 10 + 1×24 + 0 = 34
    const old = {
      path: "/y",
      uses: 1,
      firstUsed: "2026-01-01",
      lastUsed: new Date("2026-06-30T12:00:00Z").toISOString(),
    };
    expect(computeScore(10, old, now)).toBe(34);
  });

  it("computeScore returns baseScore when entry is undefined", async () => {
    const { computeScore } = await import("./index.js");

    const now = new Date("2026-08-09T12:00:00Z");
    expect(computeScore(42, undefined, now)).toBe(42);
  });

  // ── MAX_HISTORY_ENTRIES cap ───────────────────────────────────────────────

  it("MAX_HISTORY_ENTRIES = 200, evicts oldest by lastUsed", async () => {
    const { recordVisit, createHistoryStore, MAX_HISTORY_ENTRIES } = await import("./index.js");

    expect(MAX_HISTORY_ENTRIES).toBe(200);

    const store = createHistoryStore(tmpDir);

    // Pre-fill exactly 200 entries, each one day apart
    const entries = Array.from({ length: 200 }, (_, i) => ({
      path: `/wt-${i}`,
      uses: 1,
      firstUsed: new Date(2026, 0, 1).toISOString(),
      lastUsed: new Date(2026, 0, i + 1).toISOString(), // wt-0 = Jan 1 (oldest)
    }));
    store.write({ version: 1, history: entries } as any);

    // Add one more → should evict oldest (wt-0, lastUsed Jan 1)
    const now = new Date("2026-08-09T12:00:00Z");
    recordVisit(store, "/wt-new", now);

    const data = store.read();
    expect(data.history).toHaveLength(200);
    // wt-0 (oldest lastUsed) should be evicted
    expect(data.history.find((e: any) => e.path === "/wt-0")).toBeUndefined();
    // new entry should be present at front
    expect(data.history.find((e: any) => e.path === "/wt-new")).toBeDefined();
  });
});
