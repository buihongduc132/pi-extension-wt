import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E2E SESSION-BEHAVIOR TESTS for pi-extension-wt
 * 
 * These tests exercise the actual slash-command/session-fork path:
 * - Verify fallback triggers when cwd gone
 * - Verify sort persistence
 * - Verify worktree parsing
 * - Verify fork invocation calls switchSession
 */

describe('pi-extension-wt — session behavior', () => {
  const testDir = '/tmp/pi-wt-e2e';
  
  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.pi', 'agent'), { recursive: true });
  });
  
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });
  
  it('FALLBACK: isCwdGone returns true for non-existent path', async () => {
    const { isCwdGone } = await import('./index.js');
    
    expect(isCwdGone('/tmp/definitely-does-not-exist-xyz')).toBe(true);
    expect(isCwdGone('/tmp')).toBe(false);
  });
  
  it('FALLBACK: findMainWorktree returns repo root when cwd exists', async () => {
    const { findMainWorktree } = await import('./index.js');
    
    // Use pi-plugins repo (has worktrees)
    const repoRoot = '~/projects/pi-plugins';
    const main = findMainWorktree(repoRoot);
    
    expect(main).toBe(repoRoot);
  });

  it('FALLBACK: findMainWorktree recovers from state file when cwd deleted', async () => {
    // Arrange: create a real git repo with a worktree, then delete the worktree
    const { execSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const repoPath = join(testDir, 'test-repo');
    mkdirSync(repoPath, { recursive: true });
    execSync('git init -b main', { cwd: repoPath });
    execSync('git config user.email test@test.com', { cwd: repoPath });
    execSync('git config user.name Test', { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), '# Test');
    execSync('git add . && git commit -m "init"', { cwd: repoPath });

    // Create a worktree
    const wtPath = join(repoPath, '.worktrees', 'wt-feature');
    execSync(`git worktree add ${wtPath} -b feature`, { cwd: repoPath });

    // Save main worktree to state file (simulating what session_start does)
    const stateDir = join(testDir, '.pi', 'agent', 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'main-worktree.json'), JSON.stringify({ mainWorktree: repoPath }));

    // Set PI_CODING_AGENT_DIR so getAgentDir() returns testDir/.pi/agent
    process.env.PI_CODING_AGENT_DIR = join(testDir, '.pi', 'agent');

    // Delete the worktree (simulating cwd gone)
    rmSync(wtPath, { recursive: true, force: true });

    // Act
    const { findMainWorktree, isCwdGone } = await import('./index.js');
    expect(isCwdGone(wtPath)).toBe(true);
    const main = findMainWorktree(wtPath);

    // Assert — should find main via state file
    expect(main).toBe(repoPath);

    delete process.env.PI_CODING_AGENT_DIR;
  });
  
  it('SORT: persistSort writes to config file', async () => {
    process.env.PI_WT_CONFIG_PATH = join(testDir, 'wt.json');
    
    const { persistSort, loadSort } = await import('./index.js');
    
    persistSort('updated');
    expect(loadSort()).toBe('updated');
    
    persistSort('created');
    expect(loadSort()).toBe('created');
    
    delete process.env.PI_WT_CONFIG_PATH;
  });
  
  it('SORT: default is "created"', async () => {
    const { getDefaultSort } = await import('./index.js');
    expect(getDefaultSort()).toBe('created');
  });
  
  it('PARSE: git worktree list output parsed correctly', async () => {
    const { parseWorktreeList } = await import('./index.js');
    
    const mockOutput = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/repo/.worktrees/wt-feature
HEAD def456
branch refs/heads/feature

`;
    
    const worktrees = parseWorktreeList(mockOutput);
    
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0].path).toBe('/home/user/repo');
    expect(worktrees[0].branch).toBe('main');
    expect(worktrees[0].isMain).toBe(true);
    expect(worktrees[1].path).toBe('/home/user/repo/.worktrees/wt-feature');
    expect(worktrees[1].branch).toBe('feature');
    expect(worktrees[1].isMain).toBe(false);
  });
  
  it('FORK INVOCATION: forkSessionToWorktree calls ctx.switchSession', async () => {
    const { forkSessionToWorktree } = await import('./index.js');
    
    // Create a real dir to fork to
    const targetWt = join(testDir, 'target-wt');
    mkdirSync(targetWt, { recursive: true });
    
    // Mock ctx that tracks switchSession calls
    let switchCalled = false;
    let switchTarget: string | undefined;
    const mockCtx: any = {
      cwd: testDir,
      hasUI: true,
      waitForIdle: async () => {},
      sessionManager: {
        getSessionFile: () => undefined, // no current session
      },
      switchSession: async (targetPath: string, opts: any) => {
        switchCalled = true;
        switchTarget = targetPath;
        if (opts?.withSession) {
          opts.withSession({
            ui: {
              setStatus: () => {},
              notify: () => {},
            }
          });
        }
      },
      ui: {
        setStatus: () => {},
        notify: () => {},
      },
    };
    
    await forkSessionToWorktree(mockCtx, targetWt);
    
    // Assert: switchSession was called
    expect(switchCalled).toBe(true);
    expect(switchTarget).toBeDefined();
  });
});
