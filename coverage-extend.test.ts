import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Coverage extension tests for pi-extension-wt.
 *
 * Targets the previously-uncovered regions of index.ts:
 *  - forkSessionToWorktree catch fallback (lines ~208-216)
 *  - selectWorktree TUI picker (lines ~228-294)
 *  - wtExtension session_start hook + /wt command handler (lines ~298-408)
 *
 * Strategy:
 *  - Real temp git repos where the source shells out to real git.
 *  - vi.mock('@earendil-works/pi-coding-agent') to fake SessionManager
 *    (the only SDK runtime dependency index.ts uses).
 *  - vi.mock('node:child_process') to fake execSync, with a per-test override
 *    so we can drive findMainWorktree's git rev-parse branches deterministically.
 *    By default it delegates to the real execSync so real git repos still work.
 *  - A reusable fake ExtensionAPI / ExtensionCommandContext harness so we can
 *    invoke the registered "session_start" hook and "/wt" handler directly.
 */

// --- Per-test execSync override ------------------------------------------------
// When non-null, the mocked execSync delegates to this instead of the real one.
// (Node's child_process.execSync is non-configurable, so vi.spyOn can't wrap it;
// a module mock with importActual + a toggle is the supported approach.)
let execSyncOverride:
  | ((command: string, options?: Record<string, unknown>) => string | Buffer)
  | null = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:child_process');
  return {
    ...actual,
    execSync: (command: string, options?: Record<string, unknown>) => {
      if (execSyncOverride) return execSyncOverride(command, options);
      return actual.execSync(command, options as any);
    },
  };
});

// Pull the (mocked) execSync for our own helpers.
const { execSync } = await import('node:child_process');

// --- Module-wide mock of the pi-coding-agent SDK SessionManager ----------------
// The source only uses: SessionManager.forkFrom(...) and SessionManager.create(...).
// Both return an object whose getSessionFile() yields the target session path.
// We make these configurable per-test via the `__forkFromImpl` / `__createImpl`
// escape hatches so we can drive both the success and the throw branches.

const fakeForkedSessionFile = '/tmp/pi-wt-cov-forked-session.jsonl';
const fakeCreatedSessionFile = '/tmp/pi-wt-cov-created-session.jsonl';

vi.mock('@earendil-works/pi-coding-agent', () => {
  const makeMgr = (file: string) => ({
    getSessionFile: () => file,
  });

  const SessionManager = {
    forkFrom: (...args: unknown[]) => {
      // @ts-expect-error escape hatch for per-test override
      if (typeof SessionManager.__forkFromImpl === 'function') {
        // @ts-expect-error escape hatch
        return SessionManager.__forkFromImpl(...args);
      }
      return makeMgr(fakeForkedSessionFile);
    },
    create: (...args: unknown[]) => {
      // @ts-expect-error escape hatch for per-test override
      if (typeof SessionManager.__createImpl === 'function') {
        // @ts-expect-error escape hatch
        return SessionManager.__createImpl(...args);
      }
      return makeMgr(fakeCreatedSessionFile);
    },
  };

  return {
    SessionManager,
    // Re-export the type-only symbols the source imports so the module shape
    // matches. These are erased at runtime.
  };
});

// --- Helpers ------------------------------------------------------------------

let seq = 0;
function uniqueTmp(prefix: string): string {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${seq++}-${Math.floor(Math.random() * 1e6)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a real git repo with one initial commit on `main`. Returns repo root. */
function makeGitRepo(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  execSync('git init -b main', { cwd: root });
  execSync('git config user.email test@test.com', { cwd: root });
  execSync('git config user.name Test', { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# init');
  execSync('git add . && git commit -m "init"', { cwd: root });
  return root;
}

/** Add a linked worktree at `relPath` on a new branch `branch`. */
function addWorktree(repoRoot: string, relPath: string, branch: string): string {
  const abs = path.join(repoRoot, relPath);
  execSync(`git worktree add ${JSON.stringify(abs)} -b ${branch}`, { cwd: repoRoot });
  return abs;
}

type Notifier = (msg: string, level?: 'info' | 'warning' | 'error') => void;
type StatusSetter = (key: string, text: string | undefined) => void;
type Selector = (title: string, options: string[]) => Promise<string | undefined>;

interface FakeCtxOptions {
  cwd?: string;
  hasUI?: boolean;
  currentSessionFile?: string | null;
  /** Queue of select() return values (consumed in order). */
  selectQueue?: (string | undefined)[];
  /** Explicit select impl overrides the queue. */
  selectImpl?: Selector;
}

/**
 * Build a fake ExtensionCommandContext and a fake ExtensionAPI that captures the
 * registered command + event handler so tests can invoke them directly.
 */
function makeHarness() {
  const piCalls: {
    events: Record<string, ((...args: unknown[]) => unknown)[]>;
    commands: Record<string, { getArgumentCompletions?: Function; handler: Function }>;
  } = { events: {}, commands: {} };

  const fakePi: any = {
    on(event: string, handler: Function) {
      (piCalls.events[event] ||= []).push(handler as any);
    },
    registerCommand(name: string, options: any) {
      piCalls.commands[name] = options;
    },
  };

  function makeCtx(opts: FakeCtxOptions = {}) {
    const notifications: { msg: string; level?: string }[] = [];
    const statuses: { key: string; text: string | undefined }[] = [];

    const notify: Notifier = (msg, level = 'info') => {
      notifications.push({ msg, level });
    };
    const setStatus: StatusSetter = (key, text) => {
      statuses.push({ key, text });
    };

    let selectIdx = 0;
    const queue = opts.selectQueue ?? [];
    const selectImpl =
      opts.selectImpl ??
      (async (): Promise<string | undefined> => {
        return queue[selectIdx++];
      });

    const switchCalls: { path: string; opts?: unknown }[] = [];
    let waitForIdleCalls = 0;

    const ctx: any = {
      cwd: opts.cwd ?? process.cwd(),
      hasUI: opts.hasUI ?? false,
      mode: 'tui',
      ui: {
        notify,
        setStatus,
        select: selectImpl,
      },
      sessionManager: {
        getSessionFile: () => opts.currentSessionFile ?? null,
      },
      waitForIdle: async () => {
        waitForIdleCalls++;
      },
      switchSession: async (sessionPath: string, switchOpts?: { withSession?: Function }) => {
        switchCalls.push({ path: sessionPath, opts: switchOpts });
        if (switchOpts?.withSession) {
          // Provide a ReplacedSessionContext-like object with the same ui.
          await switchOpts.withSession({ ui: ctx.ui });
        }
        return { cancelled: false };
      },
    };

    return {
      ctx,
      notifications,
      statuses,
      switchCalls,
      get waitForIdleCalls() {
        return waitForIdleCalls;
      },
    };
  }

  return { fakePi, piCalls, makeCtx };
}

// --- Test suite ---------------------------------------------------------------

describe('pi-extension-wt coverage extensions', () => {
  const createdDirs: string[] = [];
  let savedAgentDir: string | undefined;
  let savedConfigPath: string | undefined;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedConfigPath = process.env.PI_WT_CONFIG_PATH;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedConfigPath === undefined) delete process.env.PI_WT_CONFIG_PATH;
    else process.env.PI_WT_CONFIG_PATH = savedConfigPath;

    execSyncOverride = null;

    for (const d of createdDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // 1. parseWorktreeList edge cases
  // ===========================================================================
  describe('parseWorktreeList', () => {
    it('parses a detached HEAD line as (detached) branch', async () => {
      const { parseWorktreeList } = await import('./index.js');
      const out = `worktree /r/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /r/det
HEAD 2222222222222222222222222222222222222222
detached
`;
      const wts = parseWorktreeList(out);
      expect(wts).toHaveLength(2);
      expect(wts[0].branch).toBe('main');
      expect(wts[1].branch).toBe('(detached)');
      expect(wts[1].isMain).toBe(false);
    });

    it('leaves commit empty when HEAD line is missing', async () => {
      const { parseWorktreeList } = await import('./index.js');
      const out = `worktree /r/nohead
branch refs/heads/main
`;
      const wts = parseWorktreeList(out);
      expect(wts).toHaveLength(1);
      expect(wts[0].commit).toBe('');
      expect(wts[0].branch).toBe('main');
      expect(wts[0].isMain).toBe(true);
    });

    it('leaves branch empty when branch line is missing for a worktree', async () => {
      const { parseWorktreeList } = await import('./index.js');
      const out = `worktree /r/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /r/nobranch
HEAD 2222222222222222222222222222222222222222
`;
      const wts = parseWorktreeList(out);
      expect(wts).toHaveLength(2);
      expect(wts[1].branch).toBe('');
      expect(wts[1].commit).toBe('2222222222222222222222222222222222222222');
      expect(wts[1].isMain).toBe(false);
    });

    it('returns [] for empty input', async () => {
      const { parseWorktreeList } = await import('./index.js');
      expect(parseWorktreeList('')).toEqual([]);
      expect(parseWorktreeList('\n\n')).toEqual([]);
    });

    it('parses more than two worktrees and marks only the first as main', async () => {
      const { parseWorktreeList } = await import('./index.js');
      const out = `worktree /r/a
HEAD 1111111111111111111111111111111111111111
branch refs/heads/a

worktree /r/b
HEAD 2222222222222222222222222222222222222222
branch refs/heads/b

worktree /r/c
HEAD 3333333333333333333333333333333333333333
branch refs/heads/c
`;
      const wts = parseWorktreeList(out);
      expect(wts).toHaveLength(3);
      expect(wts.map((w) => w.isMain)).toEqual([true, false, false]);
    });

    it('single worktree with full data is main', async () => {
      const { parseWorktreeList } = await import('./index.js');
      const out = `worktree /r/solo
HEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
branch refs/heads/solo
`;
      const [wt] = parseWorktreeList(out);
      expect(wt.isMain).toBe(true);
      expect(wt.branch).toBe('solo');
      expect(wt.commit).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    });

    it('mid-loop push uses "" fallbacks when a non-first worktree has no HEAD/branch', async () => {
      const { parseWorktreeList } = await import('./index.js');
      // The first worktree is pushed when the SECOND "worktree " line starts.
      // Give the first worktree NO HEAD and NO branch line so its mid-loop
      // push hits the `current.branch || ""` / `current.commit || ""` fallbacks.
      const out = `worktree /r/first

worktree /r/second
HEAD 2222222222222222222222222222222222222222
branch refs/heads/second
`;
      const wts = parseWorktreeList(out);
      expect(wts).toHaveLength(2);
      expect(wts[0].path).toBe('/r/first');
      expect(wts[0].branch).toBe('');
      expect(wts[0].commit).toBe('');
      expect(wts[0].isMain).toBe(true);
      expect(wts[1].branch).toBe('second');
    });
  });

  // ===========================================================================
  // 2. findMainWorktree branches
  // ===========================================================================
  describe('findMainWorktree', () => {
    it('returns repo root when cwd exists (normal toplevel)', async () => {
      const { findMainWorktree } = await import('./index.js');
      const repo = uniqueTmp('fwt-root');
      createdDirs.push(repo);
      makeGitRepo(repo);
      expect(findMainWorktree(repo)).toBe(repo);
    });

    it('returns dirname when git-common-dir output ends with /.git', async () => {
      const { findMainWorktree } = await import('./index.js');
      const cwd = uniqueTmp('fwt-gitdir');
      createdDirs.push(cwd);

      // Fake execSync so the chained rev-parse returns a path ending in /.git.
      execSyncOverride = (cmd: string) => {
        if (cmd.includes('git rev-parse')) return '/srv/repo/.git\n';
        throw new Error('unexpected execSync: ' + cmd);
      };

      const main = findMainWorktree(cwd);
      expect(main).toBe('/srv/repo');
    });

    it('returns dirname when git-common-dir output is exactly ".git"', async () => {
      const { findMainWorktree } = await import('./index.js');
      const cwd = uniqueTmp('fwt-dotgit');
      createdDirs.push(cwd);

      execSyncOverride = (cmd: string) => {
        if (cmd.includes('git rev-parse')) return '.git\n';
        throw new Error('unexpected execSync: ' + cmd);
      };

      // output === '.git' -> path.join(cwd, '.git') then dirname -> cwd
      expect(findMainWorktree(cwd)).toBe(cwd);
    });

    it('falls back to parent-dir walk with .git when cwd is gone and no state file', async () => {
      const { findMainWorktree } = await import('./index.js');
      // Build a parent git repo, then point cwd at a non-existent child dir.
      const parent = uniqueTmp('fwt-parent');
      createdDirs.push(parent);
      makeGitRepo(parent); // creates parent/.git

      const agentDir = uniqueTmp('fwt-agent-no-state');
      createdDirs.push(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir; // no state file present

      const goneChild = path.join(parent, 'vanished', 'deep');
      expect(findMainWorktree(goneChild)).toBe(parent);
    });

    it('returns undefined when cwd is gone and nothing is found', async () => {
      const { findMainWorktree } = await import('./index.js');
      const agentDir = uniqueTmp('fwt-agent-empty');
      createdDirs.push(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir; // no state file
      // A deeply non-existent path under /tmp (whose ancestors have no .git).
      const gone = '/tmp/pi-wt-nope-' + Date.now() + '/a/b/c';
      expect(findMainWorktree(gone)).toBeUndefined();
    });

    it('returns undefined from the outer catch when git rev-parse throws (cwd exists)', async () => {
      const { findMainWorktree } = await import('./index.js');
      const cwd = uniqueTmp('fwt-throw');
      createdDirs.push(cwd);
      // cwd exists -> enters the rev-parse branch; make execSync throw to hit
      // the outermost try/catch in findMainWorktree (returns undefined).
      execSyncOverride = () => {
        throw new Error('git exploded');
      };
      expect(findMainWorktree(cwd)).toBeUndefined();
    });

    it('returns undefined when git rev-parse output is empty (cwd exists)', async () => {
      const { findMainWorktree } = await import('./index.js');
      const cwd = uniqueTmp('fwt-empty');
      createdDirs.push(cwd);
      // rev-parse returns empty string -> `output || undefined` yields undefined.
      execSyncOverride = () => '\n';
      expect(findMainWorktree(cwd)).toBeUndefined();
    });

    it('recovers from state file when cwd is gone and mainWorktree exists', async () => {
      const { findMainWorktree } = await import('./index.js');
      const repo = uniqueTmp('fwt-state-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);

      const agentDir = uniqueTmp('fwt-state-agent');
      createdDirs.push(agentDir);
      const stateDir = path.join(agentDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'main-worktree.json'),
        JSON.stringify({ mainWorktree: repo }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const gone = '/tmp/pi-wt-state-gone-' + Date.now();
      expect(findMainWorktree(gone)).toBe(repo);
    });

    it('falls through to parent walk when state mainWorktree does not exist', async () => {
      const { findMainWorktree } = await import('./index.js');
      const parent = uniqueTmp('fwt-state-fallthrough-parent');
      createdDirs.push(parent);
      makeGitRepo(parent);

      const agentDir = uniqueTmp('fwt-state-fallthrough-agent');
      createdDirs.push(agentDir);
      const stateDir = path.join(agentDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'main-worktree.json'),
        JSON.stringify({ mainWorktree: '/definitely/not/here' }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const goneChild = path.join(parent, 'gone-child');
      // State mainWorktree missing -> walks parents -> finds parent/.git
      expect(findMainWorktree(goneChild)).toBe(parent);
    });

    it('continues when state file is corrupt JSON', async () => {
      const { findMainWorktree } = await import('./index.js');
      const repo = uniqueTmp('fwt-state-corrupt-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);

      const agentDir = uniqueTmp('fwt-state-corrupt-agent');
      createdDirs.push(agentDir);
      const stateDir = path.join(agentDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'main-worktree.json'), '{ not valid json');
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const goneChild = path.join(repo, 'gone-child');
      // corrupt state caught -> falls through -> parent walk finds repo
      expect(findMainWorktree(goneChild)).toBe(repo);
    });
  });

  // ===========================================================================
  // 3. readConfig / writeConfig error branches + getAgentDir / getConfigPath
  // ===========================================================================
  describe('config helpers', () => {
    it('readConfig returns {} for invalid JSON', async () => {
      const tmp = uniqueTmp('cfg-badjson');
      createdDirs.push(tmp);
      const cfgPath = path.join(tmp, 'wt.json');
      fs.writeFileSync(cfgPath, '{ broken json');
      process.env.PI_WT_CONFIG_PATH = cfgPath;

      const { loadSort } = await import('./index.js');
      // Invalid JSON -> readConfig returns {} -> no sort -> default "created"
      expect(loadSort()).toBe('created');
    });

    it('writeConfig swallows errors when the config dir is unwritable', async () => {
      // Point config path at a location whose parent is a regular file so
      // mkdirSync(dirname) throws -> writeConfig swallows it.
      const tmp = uniqueTmp('cfg-badwrite');
      createdDirs.push(tmp);
      const blocker = path.join(tmp, 'blocker-file');
      fs.writeFileSync(blocker, 'x'); // regular file
      const cfgPath = path.join(blocker, 'wt.json'); // parent is a file
      process.env.PI_WT_CONFIG_PATH = cfgPath;

      const { persistSort } = await import('./index.js');
      expect(() => persistSort('updated')).not.toThrow();
    });

    it('expandTilde applies for PI_CODING_AGENT_DIR with ~/ prefix', async () => {
      // Force getAgentDir() to use a ~/ path; verify via state file lookup.
      // findMainWorktree reads state from getAgentDir()/state/main-worktree.json
      // and only returns mainWorktree if that path EXISTS, so use a real dir.
      const unique = 'pi-wt-cov-tilde-' + Date.now();
      const expectedDir = path.join(os.homedir(), unique);
      createdDirs.push(expectedDir);
      process.env.PI_CODING_AGENT_DIR = `~/${unique}`;

      const realMain = uniqueTmp('tilde-realmain');
      createdDirs.push(realMain);

      const { findMainWorktree } = await import('./index.js');
      const gone = '/tmp/pi-wt-tilde-gone-' + Date.now();
      const stateDir = path.join(expectedDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'main-worktree.json'),
        JSON.stringify({ mainWorktree: realMain }),
      );
      expect(findMainWorktree(gone)).toBe(realMain);
    });

    it('local .pi/wt.json takes precedence over global agent config', async () => {
      const project = uniqueTmp('cfg-local-prio');
      createdDirs.push(project);
      const localDir = path.join(project, '.pi');
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, 'wt.json'), JSON.stringify({ sort: 'updated' }));

      // global path exists too with different value
      const globalDir = uniqueTmp('cfg-global-prio');
      createdDirs.push(globalDir);
      fs.writeFileSync(path.join(globalDir, 'wt.json'), JSON.stringify({ sort: 'created' }));
      process.env.PI_CODING_AGENT_DIR = globalDir;
      delete process.env.PI_WT_CONFIG_PATH;

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(project);
      try {
        const { loadSort } = await import('./index.js');
        // Local should win -> "updated"
        expect(loadSort()).toBe('updated');
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });

  // ===========================================================================
  // 4. forkSessionToWorktree
  // ===========================================================================
  describe('forkSessionToWorktree', () => {
    it('notifies error and returns early when worktree path does not exist', async () => {
      const { forkSessionToWorktree } = await import('./index.js');
      const { makeCtx } = makeHarness();
      const { ctx, notifications, switchCalls } = makeCtx();

      await forkSessionToWorktree(ctx, '/tmp/this-wt-does-not-exist-' + Date.now());

      expect(notifications.some((n) => /worktree does not exist/.test(n.msg))).toBe(true);
      expect(notifications.some((n) => n.level === 'error')).toBe(true);
      expect(switchCalls).toHaveLength(0);
    });

    it('forks via SessionManager.forkFrom when current session exists and switchSession is invoked', async () => {
      const { forkSessionToWorktree } = await import('./index.js');
      const wtDir = uniqueTmp('fork-wt');
      createdDirs.push(wtDir);
      fs.mkdirSync(wtDir, { recursive: true });

      // Real-looking "current session file"
      const cur = path.join(wtDir, 'current.jsonl');
      fs.writeFileSync(cur, 'x');

      const { makeCtx } = makeHarness();
      const { ctx, switchCalls, notifications, statuses } = makeCtx({
        cwd: wtDir,
        currentSessionFile: cur,
      });

      await forkSessionToWorktree(ctx, wtDir);

      expect(switchCalls).toHaveLength(1);
      // forkFrom success path -> target = fake forked session file
      expect(switchCalls[0].path).toBe(fakeForkedSessionFile);
      // withSession callback should set status + notify
      expect(statuses.some((s) => /wt /.test(String(s.text)))).toBe(true);
      expect(notifications.some((n) => /wt → /.test(n.msg))).toBe(true);
    });

    it('falls back to SessionManager.create when forkFrom throws', async () => {
      const sdk = await import('@earendil-works/pi-coding-agent');
      // Make forkFrom throw -> catch -> create path.
      (sdk.SessionManager as any).__forkFromImpl = () => {
        throw new Error('boom');
      };

      try {
        const { forkSessionToWorktree } = await import('./index.js');
        const wtDir = uniqueTmp('fork-throw');
        createdDirs.push(wtDir);
        fs.mkdirSync(wtDir, { recursive: true });
        const cur = path.join(wtDir, 'current.jsonl');
        fs.writeFileSync(cur, 'x');

        const { makeCtx } = makeHarness();
        const { ctx, switchCalls } = makeCtx({
          cwd: wtDir,
          currentSessionFile: cur,
        });

        await forkSessionToWorktree(ctx, wtDir);

        expect(switchCalls).toHaveLength(1);
        expect(switchCalls[0].path).toBe(fakeCreatedSessionFile);
      } finally {
        delete (sdk.SessionManager as any).__forkFromImpl;
      }
    });

    it('uses SessionManager.create when currentSessionPath is null', async () => {
      const { forkSessionToWorktree } = await import('./index.js');
      const wtDir = uniqueTmp('fork-nocur');
      createdDirs.push(wtDir);
      fs.mkdirSync(wtDir, { recursive: true });

      const { makeCtx } = makeHarness();
      const { ctx, switchCalls } = makeCtx({
        cwd: wtDir,
        currentSessionFile: null,
      });

      await forkSessionToWorktree(ctx, wtDir);

      expect(switchCalls).toHaveLength(1);
      expect(switchCalls[0].path).toBe(fakeCreatedSessionFile);
    });

    it('uses SessionManager.create when currentSessionPath file does not exist', async () => {
      const { forkSessionToWorktree } = await import('./index.js');
      const wtDir = uniqueTmp('fork-missingcur');
      createdDirs.push(wtDir);
      fs.mkdirSync(wtDir, { recursive: true });

      const { makeCtx } = makeHarness();
      const { ctx, switchCalls } = makeCtx({
        cwd: wtDir,
        currentSessionFile: '/tmp/nonexistent-session-' + Date.now() + '.jsonl',
      });

      await forkSessionToWorktree(ctx, wtDir);
      // currentSessionPath returned but file missing -> create path
      expect(switchCalls).toHaveLength(1);
      expect(switchCalls[0].path).toBe(fakeCreatedSessionFile);
    });
  });

  // ===========================================================================
  // 5. selectWorktree (exercised via the registered /wt handler)
  // ===========================================================================
  describe('selectWorktree (via /wt handler)', () => {
    async function setupPicker(repoRelWts: { rel: string; branch: string }[]) {
      const repo = uniqueTmp('picker-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);
      const wts = repoRelWts.map((w) => addWorktree(repo, w.rel, w.branch));
      return { repo, wts };
    }

    it('returns undefined when hasUI is false', async () => {
      const { repo } = await setupPicker([
        { rel: '.wt/feat-a', branch: 'feat-a' },
      ]);
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls, notifications } = makeCtx({ cwd: repo, hasUI: false });
      await piCalls.commands['wt'].handler('', ctx);

      // hasUI false -> selectWorktree returns undefined -> no switch
      expect(switchCalls).toHaveLength(0);
      // not the "no worktrees" message (worktrees exist)
      expect(notifications.some((n) => n.msg === 'No worktrees found')).toBe(false);
    });

    it('returns undefined when there are no worktrees (covered elsewhere) — here: picker selection triggers fork', async () => {
      const { repo, wts } = await setupPicker([
        { rel: '.wt/feat-b', branch: 'feat-b' },
      ]);
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      // Force the picker to pick the first (only) item.
      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        selectImpl: async (_t, items) => items[0],
      });
      await piCalls.commands['wt'].handler('', ctx);

      expect(switchCalls).toHaveLength(1);
      // Fork target is one of our fake session files.
      expect([fakeForkedSessionFile, fakeCreatedSessionFile]).toContain(switchCalls[0].path);
      void wts;
    });

    it('"s" toggles sort then re-prompts and persists the new sort', async () => {
      const tmp = uniqueTmp('picker-toggle-cfg');
      createdDirs.push(tmp);
      process.env.PI_WT_CONFIG_PATH = path.join(tmp, 'wt.json');

      const { repo } = await setupPicker([
        { rel: '.wt/feat-c', branch: 'feat-c' },
        { rel: '.wt/feat-d', branch: 'feat-d' },
      ]);
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      // First select returns 's' (toggle), then returns first item.
      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        selectImpl: async (_t, items) => {
          // consume 's' once then a real item
          (ctx as any).__toggleDone = ((ctx as any).__toggleDone ?? 0) + 1;
          return (ctx as any).__toggleDone === 1 ? 's' : items[0];
        },
      });
      await piCalls.commands['wt'].handler('', ctx);

      // Should have forked after toggle.
      expect(switchCalls).toHaveLength(1);

      // persistSort should have written "updated" to the config.
      const cfg = JSON.parse(fs.readFileSync(process.env.PI_WT_CONFIG_PATH!, 'utf8'));
      expect(cfg.sort).toBe('updated');
    });

    it('selectWorktree returns undefined when worktrees list is empty', async () => {
      // Empty worktrees early-return inside selectWorktree. Drive by passing an
      // empty array path: a non-git cwd yields getWorktrees -> [].
      const nonGit = uniqueTmp('picker-nogit');
      createdDirs.push(nonGit);
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications, switchCalls } = makeCtx({
        cwd: nonGit,
        hasUI: true,
        selectImpl: async () => 'should-not-be-called',
      });
      await piCalls.commands['wt'].handler('', ctx);

      expect(notifications.some((n) => n.msg === 'No worktrees found')).toBe(true);
      expect(switchCalls).toHaveLength(0);
    });

    it('sort comparators fall back to 0 when a worktree dir is missing (created sort, no toggle)', async () => {
      // Deleting a worktree dir leaves it in `git worktree list --porcelain`
      // (marked prunable), so getWorktrees still returns it but statSync throws
      // inside the comparators -> exercises the catch (return 0) branches.
      const repo = uniqueTmp('picker-missing-created');
      createdDirs.push(repo);
      makeGitRepo(repo);
      const w1 = addWorktree(repo, '.wt/keep', 'keep');
      const w2 = addWorktree(repo, '.wt/gone', 'gone');
      // Remove one dir so its statSync throws during sort.
      fs.rmSync(w2, { recursive: true, force: true });

      const tmp = uniqueTmp('picker-missing-created-cfg');
      createdDirs.push(tmp);
      process.env.PI_WT_CONFIG_PATH = path.join(tmp, 'wt.json');

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        // Pick the existing (kept) worktree so the final comparator also runs
        // against a missing path (the deleted one is in the list).
        selectImpl: async (_t, items) => items.find((i) => i.includes('keep')) ?? items[0],
      });
      await piCalls.commands['wt'].handler('', ctx);
      expect(switchCalls).toHaveLength(1);
      void w1;
    });

    it('sort comparators fall back to 0 in "updated" sort after toggle when a dir is missing', async () => {
      const repo = uniqueTmp('picker-missing-updated');
      createdDirs.push(repo);
      makeGitRepo(repo);
      const w1 = addWorktree(repo, '.wt/keep2', 'keep2');
      const w2 = addWorktree(repo, '.wt/gone2', 'gone2');
      // Touch keep2 so its mtime differs; remove gone2 so statSync throws.
      fs.writeFileSync(path.join(w1, 'touch'), 'x');
      fs.rmSync(w2, { recursive: true, force: true });

      const tmp = uniqueTmp('picker-missing-updated-cfg');
      createdDirs.push(tmp);
      process.env.PI_WT_CONFIG_PATH = path.join(tmp, 'wt.json');

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      let call = 0;
      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        selectImpl: async (_t, items) => {
          call++;
          // First prompt: toggle to "updated" sort (exercises updated-sort
          // buildItems comparator with a missing path). Then pick keep2.
          if (call === 1) return 's';
          return items.find((i) => i.includes('keep2')) ?? items[0];
        },
      });
      await piCalls.commands['wt'].handler('', ctx);
      expect(switchCalls).toHaveLength(1);
    });

    it('empty-string selection also toggles sort (selected === "" branch)', async () => {
      const repo = uniqueTmp('picker-emptytoggle');
      createdDirs.push(repo);
      makeGitRepo(repo);
      addWorktree(repo, '.wt/et1', 'et1');
      addWorktree(repo, '.wt/et2', 'et2');

      const tmp = uniqueTmp('picker-emptytoggle-cfg');
      createdDirs.push(tmp);
      process.env.PI_WT_CONFIG_PATH = path.join(tmp, 'wt.json');

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      let call = 0;
      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        selectImpl: async (_t, items) => {
          call++;
          // First prompt returns "" -> toggles; then pick a real item.
          if (call === 1) return '';
          return items[0];
        },
      });
      await piCalls.commands['wt'].handler('', ctx);
      expect(switchCalls).toHaveLength(1);
    });

    it('returns undefined when the selected item is not in the item list (index < 0)', async () => {
      const repo = uniqueTmp('picker-badindex');
      createdDirs.push(repo);
      makeGitRepo(repo);
      addWorktree(repo, '.wt/bi1', 'bi1');

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        // Return a string that won't be in the formatted items.
        selectImpl: async () => 'this-is-not-an-item',
      });
      await piCalls.commands['wt'].handler('', ctx);
      // selected not found -> selectWorktree returns undefined -> no switch.
      expect(switchCalls).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 6. wtExtension session_start hook
  // ===========================================================================
  describe('wtExtension session_start hook', () => {
    it('notifies warning and sets status when cwd is gone', async () => {
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const gone = '/tmp/pi-wt-hook-gone-' + Date.now();
      const { ctx, notifications, statuses } = makeCtx({ cwd: gone });
      // session_start handler signature: (event, ctx)
      await piCalls.events['session_start'][0]({ type: 'session_start' }, ctx);

      expect(notifications.some((n) => /cwd gone/.test(n.msg) && n.level === 'warning')).toBe(true);
      expect(statuses.some((s) => /cwd gone/.test(String(s.text)))).toBe(true);
    });

    it('saves main-worktree.json to state dir when cwd exists', async () => {
      const agentDir = uniqueTmp('hook-agent');
      createdDirs.push(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const repo = uniqueTmp('hook-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, statuses } = makeCtx({ cwd: repo });
      await piCalls.events['session_start'][0]({ type: 'session_start' }, ctx);

      const stateFile = path.join(agentDir, 'state', 'main-worktree.json');
      expect(fs.existsSync(stateFile)).toBe(true);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.mainWorktree).toBe(repo);
      expect(typeof state.savedAt).toBe('string');
      // status set to "wt <basename>"
      expect(statuses.some((s) => s.text === `wt ${path.basename(repo)}`)).toBe(true);
    });

    it('swallows state-save errors (state dir unwritable)', async () => {
      // Make getAgentDir()/state point under a path whose parent is a file,
      // so mkdirSync(stateDir) throws inside the hook. We do this by setting
      // PI_CODING_AGENT_DIR to a path whose "state" parent is blocked.
      const blockerRoot = uniqueTmp('hook-block');
      createdDirs.push(blockerRoot);
      const blocker = path.join(blockerRoot, 'i-am-a-file');
      fs.writeFileSync(blocker, 'x');
      // agent dir = blocker; state dir = blocker/state -> mkdir fails
      process.env.PI_CODING_AGENT_DIR = blocker;

      const repo = uniqueTmp('hook-repo-throw');
      createdDirs.push(repo);
      makeGitRepo(repo);

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, statuses } = makeCtx({ cwd: repo });
      // The session_start handler is synchronous; it should not throw even
      // though the state save fails (the error is swallowed internally).
      expect(() =>
        piCalls.events['session_start'][0]({ type: 'session_start' }, ctx),
      ).not.toThrow();
      // status is still set after the try/catch block.
      expect(statuses.some((s) => s.text === `wt ${path.basename(repo)}`)).toBe(true);
    });
  });

  // ===========================================================================
  // 7. /wt command handler branches
  // ===========================================================================
  describe('/wt command handler', () => {
    async function setupRepoWithWorktrees() {
      const repo = uniqueTmp('wt-cmd-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);
      addWorktree(repo, '.wt/feat-x', 'feat-x');
      addWorktree(repo, '.wt/feat-y', 'feat-y');
      return repo;
    }

    it('--list formats worktrees with (main) marker', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications } = makeCtx({ cwd: repo });
      await piCalls.commands['wt'].handler('--list', ctx);

      const last = notifications[notifications.length - 1];
      expect(last.level).toBe('info');
      // Main repo basename appears with (main), feat branches listed.
      expect(last.msg).toContain(`(main)`);
      expect(last.msg).toContain('feat-x');
      expect(last.msg).toContain('feat-y');
    });

    it('--list with no worktrees notifies "No worktrees found"', async () => {
      const nonGit = uniqueTmp('wt-cmd-nogit');
      createdDirs.push(nonGit);
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications } = makeCtx({ cwd: nonGit });
      await piCalls.commands['wt'].handler('--list', ctx);
      expect(notifications.some((n) => n.msg === 'No worktrees found')).toBe(true);
    });

    it('--status notifies current worktree basename', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications } = makeCtx({ cwd: repo });
      await piCalls.commands['wt'].handler('--status', ctx);
      expect(notifications.some((n) => n.msg === `Current worktree: ${path.basename(repo)}`)).toBe(
        true,
      );
    });

    it('no-arg, cwd gone, main found -> fallback notify + fork', async () => {
      const repo = uniqueTmp('wt-cmd-gone-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);

      // Set up state file so findMainWorktree returns repo.
      const agentDir = uniqueTmp('wt-cmd-gone-agent');
      createdDirs.push(agentDir);
      const stateDir = path.join(agentDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'main-worktree.json'),
        JSON.stringify({ mainWorktree: repo }),
      );
      process.env.PI_CODING_AGENT_DIR = agentDir;

      const gone = '/tmp/pi-wt-cmd-gone-' + Date.now();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications, switchCalls } = makeCtx({ cwd: gone });
      await piCalls.commands['wt'].handler('', ctx);

      expect(notifications.some((n) => /cwd gone, falling back to main/.test(n.msg))).toBe(true);
      expect(switchCalls).toHaveLength(1);
    });

    it('no-arg, cwd gone, main NOT found -> error notify', async () => {
      const agentDir = uniqueTmp('wt-cmd-gone-nofound-agent');
      createdDirs.push(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir; // no state file

      const gone = '/tmp/pi-wt-cmd-nofound-' + Date.now() + '/x/y';
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications, switchCalls } = makeCtx({ cwd: gone });
      await piCalls.commands['wt'].handler('', ctx);

      expect(
        notifications.some((n) => /main worktree not found/.test(n.msg) && n.level === 'error'),
      ).toBe(true);
      expect(switchCalls).toHaveLength(0);
    });

    it('no-arg, cwd exists, picker returns undefined -> nothing happens', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        selectImpl: async () => undefined,
      });
      await piCalls.commands['wt'].handler('', ctx);
      expect(switchCalls).toHaveLength(0);
    });

    it('no-arg, cwd exists, picker returns selection -> fork', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({
        cwd: repo,
        hasUI: true,
        selectImpl: async (_t, items) => items[0],
      });
      await piCalls.commands['wt'].handler('', ctx);
      expect(switchCalls).toHaveLength(1);
    });

    it('direct /wt <name> exact basename match -> fork', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({ cwd: repo });
      await piCalls.commands['wt'].handler('feat-x', ctx);
      expect(switchCalls).toHaveLength(1);
    });

    it('direct /wt <name> wt-<name> prefix match -> fork', async () => {
      const repo = uniqueTmp('wt-cmd-prefix');
      createdDirs.push(repo);
      makeGitRepo(repo);
      // Worktree dir basename is "wt-cool"; passing "cool" matches wt-<name>.
      addWorktree(repo, '.wt/wt-cool', 'branch-cool');

      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({ cwd: repo });
      await piCalls.commands['wt'].handler('cool', ctx);
      expect(switchCalls).toHaveLength(1);
    });

    it('direct /wt <branch> branch match -> fork', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, switchCalls } = makeCtx({ cwd: repo });
      await piCalls.commands['wt'].handler('feat-y', ctx);
      expect(switchCalls).toHaveLength(1);
    });

    it('direct /wt <name> not found -> error notify', async () => {
      const repo = await setupRepoWithWorktrees();
      const { fakePi, piCalls, makeCtx } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const { ctx, notifications, switchCalls } = makeCtx({ cwd: repo });
      await piCalls.commands['wt'].handler('does-not-exist', ctx);
      expect(notifications.some((n) => /worktree not found/.test(n.msg) && n.level === 'error')).toBe(
        true,
      );
      expect(switchCalls).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 8. getArgumentCompletions
  // ===========================================================================
  describe('getArgumentCompletions', () => {
    it('returns matching completion items for a prefix', async () => {
      const repo = uniqueTmp('compl-repo');
      createdDirs.push(repo);
      makeGitRepo(repo);
      addWorktree(repo, '.wt/alpha', 'alpha');
      addWorktree(repo, '.wt/beta', 'beta');

      const { fakePi, piCalls } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      // getArgumentCompletions uses process.cwd(); spy it to the repo.
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
      try {
        const res = piCalls.commands['wt'].getArgumentCompletions('al');
        expect(Array.isArray(res)).toBe(true);
        expect((res as any[]).length).toBe(1);
        expect((res as any[])[0].value).toBe('alpha');
        expect((res as any[])[0].label).toBe('alpha');
        expect((res as any[])[0].description).toBe('alpha');
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it('returns null when nothing matches', async () => {
      const repo = uniqueTmp('compl-repo-nomatch');
      createdDirs.push(repo);
      makeGitRepo(repo);
      addWorktree(repo, '.wt/alpha', 'alpha');

      const { fakePi, piCalls } = makeHarness();
      const { default: wtExtension } = await import('./index.js');
      wtExtension(fakePi);

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
      try {
        const res = piCalls.commands['wt'].getArgumentCompletions('zzz');
        expect(res).toBeNull();
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });
});
