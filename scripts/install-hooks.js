// Installs scripts/hooks/pre-commit into this checkout's git hooks directory
// (works in worktrees). Run once per clone: npm run hooks:install
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const hooksDir = execSync('git rev-parse --git-path hooks').toString().trim();
fs.mkdirSync(hooksDir, { recursive: true });
const dest = path.join(hooksDir, 'pre-commit');
fs.copyFileSync(path.join(__dirname, 'hooks', 'pre-commit'), dest);
fs.chmodSync(dest, 0o755);
console.log(`installed ${dest}`);
