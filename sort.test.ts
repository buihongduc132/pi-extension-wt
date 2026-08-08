import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mocks: pi-kit/store with real I/O ───────────────────────────────────────

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

describe("--sort flag parsing + persistence (LD4, LD6)", () => {
  let tmpDir: string;
  let savedConfigPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-sort-"));
    savedConfigPath = process.env.PI_WT_CONFIG_PATH;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedConfigPath === undefined) delete process.env.PI_WT_CONFIG_PATH;
    else process.env.PI_WT_CONFIG_PATH = savedConfigPath;
    vi.restoreAllMocks();
  });

  // ── parseSortArg ──────────────────────────────────────────────────────────

  it("parses '--sort updated'", async () => {
    const { parseSortArg } = await import("./index.js");
    expect(parseSortArg("--sort updated")).toBe("updated");
  });

  it("parses '--sort created'", async () => {
    const { parseSortArg } = await import("./index.js");
    expect(parseSortArg("--sort created")).toBe("created");
  });

  it("defaults to 'created' for empty or whitespace args", async () => {
    const { parseSortArg } = await import("./index.js");
    expect(parseSortArg("")).toBe("created");
    expect(parseSortArg("   ")).toBe("created");
  });

  it("defaults to 'created' for invalid sort values", async () => {
    const { parseSortArg } = await import("./index.js");
    expect(parseSortArg("--sort invalid")).toBe("created");
    expect(parseSortArg("--sort foo")).toBe("created");
  });

  // ── LD6: 's' toggle killed ────────────────────────────────────────────────

  it("does NOT treat 's' as a sort toggle (LD6)", async () => {
    const { parseSortArg } = await import("./index.js");
    // 's' must default to "created", NOT toggle to "updated"
    expect(parseSortArg("s")).toBe("created");
    expect(parseSortArg("s")).not.toBe("updated");
  });

  // ── persistSort via AtomicJsonStore ───────────────────────────────────────

  it("persists sort to wt.json with version=1 via AtomicJsonStore", async () => {
    const configPath = path.join(tmpDir, "wt.json");
    process.env.PI_WT_CONFIG_PATH = configPath;
    vi.resetModules();

    const { persistSort } = await import("./index.js");
    persistSort("updated");

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.sort).toBe("updated");
  });

  it("persistSort round-trips through read (created → updated → created)", async () => {
    const configPath = path.join(tmpDir, "wt.json");
    process.env.PI_WT_CONFIG_PATH = configPath;
    vi.resetModules();

    const { persistSort, loadSort } = await import("./index.js");

    persistSort("updated");
    expect(loadSort()).toBe("updated");

    persistSort("created");
    expect(loadSort()).toBe("created");
  });
});
