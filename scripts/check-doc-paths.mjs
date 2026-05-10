import fs from 'fs';
import path from 'path';

const root = process.cwd();

const scanTargets = [
  'AGENTS.md',
  'CLAUDE.md',
  '.codex/README.md',
  '.claude/README.md',
  '.cursor/rules/project-harness.mdc',
  'docs/agent-harness.md',
  'docs/agent-index-guide.md',
  'docs/agent-lessons.md',
  'docs/repo-feature-map/index.md',
  'docs/系统概览.md',
  'docs/后端运行时与服务架构.md',
  'docs/开发与测试.md',
  '.codex/skills/nanoclaw-backend-ts/SKILL.md',
  '.claude/skills/nanoclaw-backend-ts/SKILL.md',
  '.codex/skills/nanoclaw-conversation-flow/SKILL.md',
  '.claude/skills/nanoclaw-conversation-flow/SKILL.md',
];

const allowedMissing = new Set([
  'README_zh.md',
]);

const missing = [];

function shouldCheckToken(token) {
  if (!token) return false;
  if (token.includes('*')) return false;
  if (token.includes('$')) return false;
  if (token.includes('://')) return false;
  if (token.startsWith('/')) return false;
  if (token.startsWith('npm ')) return false;
  if (token.startsWith('cd ')) return false;
  if (token.startsWith('npx ')) return false;
  if (token.startsWith('git ')) return false;
  if (token.startsWith('VARCHAR(')) return false;
  if (token.includes(' ')) return false;
  if (token.includes('`')) return false;
  if (token.includes('|')) return false;
  if (token.includes('→')) return false;
  if (token.includes('->')) return false;
  if (token.includes(':') && !token.startsWith('docs/')) return false;
  if (token.endsWith('/')) return true;
  if (!token.includes('/')) {
    return /^(README(?:_zh)?\.md|CLAUDE\.md|AGENTS\.md)$/.test(token);
  }
  return /^(src|web|docs|agent|skills-engine|setup|scripts|deploy|\.codex|\.claude|\.cursor)(?:\/[\w.\-\u4e00-\u9fff]+)+$/.test(
    token,
  );
}

function pathExists(token, sourceFile) {
  const candidates = [path.join(root, token)];
  if (sourceFile.startsWith('docs/') && !token.includes('/')) {
    candidates.push(path.join(root, 'docs', token));
  }
  return candidates.some((candidate) => fs.existsSync(candidate));
}

for (const target of scanTargets) {
  const fullPath = path.join(root, target);
  if (!fs.existsSync(fullPath)) {
    missing.push({ file: target, line: 0, token: target, reason: 'scan target missing' });
    continue;
  }
  const lines = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/);
  lines.forEach((lineText, index) => {
    if (lineText.includes('->')) return;
    const matches = lineText.matchAll(/`([^`]+)`/g);
    for (const match of matches) {
      const token = match[1].trim();
      if (!shouldCheckToken(token)) continue;
      if (allowedMissing.has(token)) continue;
      if (pathExists(token, target)) continue;
      missing.push({ file: target, line: index + 1, token, reason: 'referenced path missing' });
    }
  });
}

if (missing.length === 0) {
  console.log(`Doc path check passed (${scanTargets.length} files)`);
  process.exit(0);
}

console.error(`Doc path check failed: ${missing.length} missing reference(s)`);
for (const item of missing) {
  const location = item.line ? `${item.file}:${item.line}` : item.file;
  console.error(`- ${location}: ${item.token} (${item.reason})`);
}
process.exit(1);
