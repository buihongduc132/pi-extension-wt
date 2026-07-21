import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * TDD RED phase: failing tests for pi-extension-wt
 * 
 * Covers:
 * - git worktree list parsing
 * - Sort toggle (created|updated) persisted to config
 * - Fallback when cwd deleted
 * - Session fork
 */

describe('pi-extension-wt', () => {
  const testDir = '/tmp/pi-wt-test';
  
  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });
  
  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
  
  describe('git worktree list parsing', () => {
    it('should parse git worktree list output', async () => {
      // Arrange - mock git worktree list output
      const mockOutput = `worktree /home/user/repo
HEAD abc1234567890abcdef1234567890abcdef1234567
branch refs/heads/main

worktree /home/user/repo/.worktrees/wt-feature
HEAD def9876543210fedcba9876543210fedcba98765
branch refs/heads/feature
`;
      
      // Act
      const { parseWorktreeList } = await import('./index.js');
      const worktrees = parseWorktreeList(mockOutput);
      
      // Assert
      expect(worktrees).toHaveLength(2);
      expect(worktrees[0].path).toBe('/home/user/repo');
      expect(worktrees[0].branch).toBe('main');
      expect(worktrees[0].isMain).toBe(true);
      expect(worktrees[1].path).toBe('/home/user/repo/.worktrees/wt-feature');
      expect(worktrees[1].branch).toBe('feature');
      expect(worktrees[1].isMain).toBe(false);
    });
  });
  
  describe('Sort toggle', () => {
    it('should default to "created" sort', async () => {
      // Act
      const { getDefaultSort } = await import('./index.js');
      const sort = getDefaultSort();
      
      // Assert
      expect(sort).toBe('created');
    });
    
    it('should read sort from config file', async () => {
      // Arrange
      const configPath = join(testDir, 'wt.json');
      writeFileSync(configPath, JSON.stringify({ sort: 'updated' }));
      
      process.env.PI_WT_CONFIG_PATH = configPath;
      
      // Act
      const { loadSort } = await import('./index.js');
      const sort = loadSort();
      
      // Assert
      expect(sort).toBe('updated');
      
      delete process.env.PI_WT_CONFIG_PATH;
    });
    
    it('should persist sort toggle to config file', async () => {
      // Arrange
      const configPath = join(testDir, 'wt.json');
      writeFileSync(configPath, JSON.stringify({ sort: 'created' }));
      
      process.env.PI_WT_CONFIG_PATH = configPath;
      
      // Act
      const { persistSort } = await import('./index.js');
      persistSort('updated');
      
      // Assert
      const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
      expect(config.sort).toBe('updated');
      
      delete process.env.PI_WT_CONFIG_PATH;
    });
  });
  
  describe('Fallback when cwd deleted', () => {
    it('should detect when cwd no longer exists', async () => {
      // Arrange
      const gonePath = '/tmp/this-does-not-exist-12345';
      
      // Act
      const { isCwdGone } = await import('./index.js');
      const gone = isCwdGone(gonePath);
      
      // Assert
      expect(gone).toBe(true);
    });
    
    it('should find main worktree via git rev-parse --show-toplevel', async () => {
      // Arrange - create a real git repo with worktree
      const repoPath = join(testDir, 'test-repo');
      mkdirSync(repoPath, { recursive: true });
      execSync('git init -b main', { cwd: repoPath });
      execSync('git config user.email test@test.com', { cwd: repoPath });
      execSync('git config user.name Test', { cwd: repoPath });
      writeFileSync(join(repoPath, 'README.md'), '# Test');
      execSync('git add . && git commit -m "init"', { cwd: repoPath });
      
      // Act
      const { findMainWorktree } = await import('./index.js');
      const main = findMainWorktree(repoPath);
      
      // Assert
      expect(main).toBe(repoPath);
    });
  });
  
  describe('Session fork', () => {
    it('should fork session when /wt <name> invoked', async () => {
      // This test requires mocking pi extension API
      // For now, just verify the function exists
      const { forkSessionToWorktree } = await import('./index.js');
      expect(typeof forkSessionToWorktree).toBe('function');
    });
  });
});
