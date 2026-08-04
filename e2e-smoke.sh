#!/usr/bin/env bash
# E2E smoke test for pi-extension-wt
# Verifies real behavior in a live pi session (not mocked)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR=$(mktemp -d)
EXIT_CODE=0

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "=== E2E: pi-extension-wt ==="
echo "Test dir: $TEST_DIR"
echo ""

# Test 1: Extension loads without errors (requires pi binary)
echo "[1/5] Extension loads without errors..."
cd "$TEST_DIR"
if command -v pi >/dev/null 2>&1; then
  LOAD_OUTPUT=$(timeout 120 pi -p -ne "echo loaded" 2>&1 || true)
  if echo "$LOAD_OUTPUT" | grep -q "Failed to load extension.*pi-extension-wt"; then
    echo "  FAIL: wt extension failed to load"
    EXIT_CODE=1
  else
    echo "  PASS: no load errors for wt"
  fi
else
  echo "  SKIP: pi binary not available (CI environment)"
fi

# Test 2: git worktree list parsing
echo "[2/5] git worktree list parsing works..."
mkdir -p "$TEST_DIR/repo"
cd "$TEST_DIR/repo"
git init -b main >/dev/null 2>&1
git config user.email test@test.com
git config user.name Test
echo "# Test" > README.md
git add . && git commit -m "init" >/dev/null 2>&1

# Add a worktree
git worktree add "$TEST_DIR/repo/.worktrees/wt-feature" -b feature >/dev/null 2>&1

PARSE_RESULT=$(timeout 30 node -e "
  import('$REPO_DIR/index.ts').then(m => {
    const output = require('child_process').execSync('git worktree list --porcelain', { cwd: '$TEST_DIR/repo', encoding: 'utf8' });
    const wts = m.parseWorktreeList(output);
    console.log(JSON.stringify({
      count: wts.length,
      mainPath: wts[0]?.path,
      mainBranch: wts[0]?.branch,
      mainIsMain: wts[0]?.isMain,
      featurePath: wts[1]?.path,
      featureBranch: wts[1]?.branch,
      featureIsMain: wts[1]?.isMain
    }));
  }).catch(e => { console.log('ERROR:', e.message); process.exit(1); });
" 2>&1 || true)

if echo "$PARSE_RESULT" | grep -q '"count":2' && echo "$PARSE_RESULT" | grep -q '"mainBranch":"main"' && echo "$PARSE_RESULT" | grep -q '"featureBranch":"feature"'; then
  echo "  PASS: worktree parsing correct"
  echo "  Result: $PARSE_RESULT"
else
  echo "  FAIL: worktree parsing incorrect"
  echo "  Output: $PARSE_RESULT"
  EXIT_CODE=1
fi

# Test 3: Sort default
echo "[3/5] Default sort is 'created'..."
SORT_RESULT=$(timeout 30 node -e "
  import('$REPO_DIR/index.ts').then(m => {
    console.log(JSON.stringify({ defaultSort: m.getDefaultSort() }));
  }).catch(e => { console.log('ERROR:', e.message); process.exit(1); });
" 2>&1 || true)

if echo "$SORT_RESULT" | grep -q '"defaultSort":"created"'; then
  echo "  PASS: default sort is 'created'"
else
  echo "  FAIL: default sort wrong"
  echo "  Output: $SORT_RESULT"
  EXIT_CODE=1
fi

# Test 4: Sort persistence
echo "[4/5] Sort persists to config..."
mkdir -p "$TEST_DIR/state"
cat > "$TEST_DIR/wt.json" << 'EOF'
{ "sort": "created" }
EOF

PERSIST_RESULT=$(PI_WT_CONFIG_PATH="$TEST_DIR/wt.json" \
  timeout 30 node -e "
  import('$REPO_DIR/index.ts').then(m => {
    m.persistSort('updated');
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$TEST_DIR/wt.json', 'utf8'));
    console.log(JSON.stringify({ persistedSort: config.sort }));
  }).catch(e => { console.log('ERROR:', e.message); process.exit(1); });
" 2>&1 || true)

if echo "$PERSIST_RESULT" | grep -q '"persistedSort":"updated"'; then
  echo "  PASS: sort persisted correctly"
else
  echo "  FAIL: sort persistence failed"
  echo "  Output: $PERSIST_RESULT"
  EXIT_CODE=1
fi

# Test 5: isCwdGone detection
echo "[5/5] isCwdGone detects missing cwd..."
CWD_RESULT=$(timeout 30 node -e "
  import('$REPO_DIR/index.ts').then(m => {
    console.log(JSON.stringify({
      goneExists: m.isCwdGone('/tmp/definitely-does-not-exist-12345'),
      goneFake: m.isCwdGone('/tmp'),
    }));
  }).catch(e => { console.log('ERROR:', e.message); process.exit(1); });
" 2>&1 || true)

if echo "$CWD_RESULT" | grep -q '"goneExists":true' && echo "$CWD_RESULT" | grep -q '"goneFake":false'; then
  echo "  PASS: cwd detection works"
else
  echo "  FAIL: cwd detection failed"
  echo "  Output: $CWD_RESULT"
  EXIT_CODE=1
fi

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "=== ALL E2E TESTS PASSED ==="
else
  echo "=== SOME E2E TESTS FAILED ==="
fi
exit $EXIT_CODE
