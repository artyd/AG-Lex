#!/usr/bin/env node
/* AG Lex — install the docs pre-commit hook into .git/hooks/.
 *
 * We can't check the hook directly into .git/hooks/ (it lives outside
 * the worktree). The git-supported alternatives are husky (extra dep,
 * boilerplate) or `core.hooksPath` (changes global git config in a way
 * that some teams don't want). Simplest portable path: a tiny Node
 * install script that copies + chmods the file. Run once after clone:
 *
 *   npm run docs:install-hook
 *
 * Re-running is safe and idempotent. Uninstall via:
 *
 *   rm .git/hooks/pre-commit
 */
import { copyFileSync, existsSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const src = resolve(__dirname, 'pre-commit');
const dstDir = resolve(repoRoot, '.git', 'hooks');
const dst = resolve(dstDir, 'pre-commit');

if (!existsSync(resolve(repoRoot, '.git'))) {
  console.error('[docs:install-hook] not a git repository — nothing to install.');
  process.exit(1);
}
mkdirSync(dstDir, { recursive: true });

// If the user already has a pre-commit hook and it's NOT ours, refuse
// to clobber. They'll need to merge by hand. Detect via a marker line.
const MARKER = '# AG Lex — block commits whose code/doc are out of sync.';
if (existsSync(dst)) {
  const existing = readFileSync(dst, 'utf8');
  if (!existing.includes(MARKER)) {
    console.error('[docs:install-hook] .git/hooks/pre-commit already exists');
    console.error('[docs:install-hook] and is not ours. Refusing to overwrite.');
    console.error('[docs:install-hook] Merge the contents of tools/hooks/pre-commit by hand.');
    process.exit(1);
  }
}

copyFileSync(src, dst);
try { chmodSync(dst, 0o755); } catch (_) { /* Windows: no-op */ }
console.log(`[docs:install-hook] installed → ${dst}`);
console.log('[docs:install-hook] commits that change source without regenerating docs/');
console.log('[docs:install-hook] will now be blocked. Run `npm run docs` to update.');
