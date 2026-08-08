import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Dynamic imports avoid vitest TDZ with vi.mock hoisting
const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");

// ─── Mocks: pi-kit/store — sync factory, real I/O via dynamic imports ───────
// Methods reference fs/path at CALL time (after module eval), not at
// factory-definition time.

vi.mock("pi-kit/store", () => {
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
      const dir = path.dirname(this.path);
      fs.mkdirSync(dir, { recursive: true });
      // Atomic write: temp file + rename, stamps schemaVersion on every write
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

describe("wt.json + state/wt-history.json — AtomicJsonStore (LD3, LD4, LD5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-store-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates wt.json store with schema version 1 and default sort=created (LD4)", async () => {
    const { createConfigStore } = await import("./index.js");

    const store = createConfigStore(tmpDir);

    expect(store.path).toBe(path.join(tmpDir, "wt.json"));
    const defaultData = store.read();
    expect(defaultData.version).toBe(1);
    expect(defaultData.sort).toBe("created");
  });

  it("creates state/wt-history.json as a separate file (LD5)", async () => {
    const { createHistoryStore } = await import("./index.js");

    const store = createHistoryStore(tmpDir);

    expect(store.path).toBe(path.join(tmpDir, "state", "wt-history.json"));
    const defaultData = store.read();
    expect(defaultData.version).toBe(1);
    expect(defaultData.history).toEqual([]);
  });

  it("stamps version on every write to wt.json (LD4)", async () => {
    const { createConfigStore } = await import("./index.js");

    const store = createConfigStore(tmpDir);
    store.write({ version: 1, sort: "updated" } as any);

    const raw = JSON.parse(fs.readFileSync(store.path, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.sort).toBe("updated");
  });

  it("stamps version on every write to history store", async () => {
    const { createHistoryStore } = await import("./index.js");

    const store = createHistoryStore(tmpDir);
    store.write({
      version: 1,
      history: [{ path: "/x", uses: 1, firstUsed: "now", lastUsed: "now" }],
    } as any);

    const raw = JSON.parse(fs.readFileSync(store.path, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.history).toHaveLength(1);
  });

  it("leaves no .tmp files after atomic write (LD3)", async () => {
    const { createConfigStore } = await import("./index.js");

    const store = createConfigStore(tmpDir);
    store.write({ version: 1, sort: "created" } as any);

    const dir = path.dirname(store.path);
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("wt.json and history.json are separate files in separate directories", async () => {
    const { createConfigStore, createHistoryStore } = await import("./index.js");

    const configStore = createConfigStore(tmpDir);
    const historyStore = createHistoryStore(tmpDir);

    expect(configStore.path).not.toBe(historyStore.path);
    expect(path.dirname(historyStore.path)).not.toBe(path.dirname(configStore.path));
  });
});
