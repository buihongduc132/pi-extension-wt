/**
 * sort.ts — Sort argument parsing + config persistence.
 *
 * LD4: version: 1 stamped on every write.
 * LD6: NO 's' toggle — sort via --sort flag only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Path helpers ────────────────────────────────────────────────────────────

export function expandTilde(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim()
    ? expandTilde(process.env.PI_CODING_AGENT_DIR!.trim())
    : path.join(os.homedir(), ".pi", "agent");
}

function getConfigPath(): string {
  const envPath = process.env.PI_WT_CONFIG_PATH?.trim();
  if (envPath) return expandTilde(envPath);
  const localPath = path.join(process.cwd(), ".pi", "wt.json");
  if (fs.existsSync(localPath)) return localPath;
  return path.join(getAgentDir(), "wt.json");
}

// ─── Config I/O (simple, backward-compatible) ────────────────────────────────

interface RawConfig {
  sort?: "created" | "updated";
}

function readConfig(): RawConfig {
  try {
    if (!fs.existsSync(getConfigPath())) return {};
    return JSON.parse(fs.readFileSync(getConfigPath(), "utf8")) as RawConfig;
  } catch {
    return {};
  }
}

function writeConfig(config: RawConfig): void {
  try {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // LD4: stamp version: 1 on every write
    const data = { version: 1, ...config };
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  } catch {
    // Config persistence is best-effort
  }
}

// ─── Sort API ────────────────────────────────────────────────────────────────

export function getDefaultSort(): "created" | "updated" {
  return "created";
}

/**
 * Parse sort argument. Accepts "--sort created" or "--sort updated".
 * LD6: 's' is NOT a toggle — defaults to "created" for any non-flag input.
 */
export function parseSortArg(args: string): "created" | "updated" {
  const trimmed = args.trim();
  if (!trimmed) return getDefaultSort();

  const match = trimmed.match(/^--sort\s+(\S+)/);
  if (!match) return getDefaultSort();

  const value = match[1];
  if (value !== "created" && value !== "updated") return getDefaultSort();
  return value;
}

export function loadSort(): "created" | "updated" {
  return readConfig().sort || getDefaultSort();
}

export function persistSort(sort: "created" | "updated"): void {
  const config = readConfig();
  config.sort = sort;
  writeConfig(config);
}
