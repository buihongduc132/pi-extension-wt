import { parseWorktreeList, persistSort, loadSort, isCwdGone, findMainWorktree } from './index.ts';

// Test parsing
const mockOutput = `worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/repo/.worktrees/wt-feature
HEAD def456
branch refs/heads/feature

`;
const wts = parseWorktreeList(mockOutput);
console.log('parsed worktrees:', wts);

// Test sort persistence
process.env.PI_WT_CONFIG_PATH = '/tmp/pi-audit-test/wt.json';
console.log('default sort:', loadSort());
persistSort('updated');
console.log('after persist updated:', loadSort());
persistSort('created');
console.log('after persist created:', loadSort());

// Test isCwdGone
console.log('isCwdGone(/tmp/nope):', isCwdGone('/tmp/nope-xyz'));
console.log('isCwdGone(/tmp):', isCwdGone('/tmp'));

// Test findMainWorktree
console.log('main of pi-plugins:', findMainWorktree('~/projects/pi-plugins'));
