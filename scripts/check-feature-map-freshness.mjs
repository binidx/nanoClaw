import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const featureMapPath = path.join(root, 'docs', 'repo-feature-map', 'index.md');
const codePaths = ['src', 'web/src', 'agent/runner/src', 'skills-engine', 'package.json', 'web/package.json'];

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.trim()) {
      return error.stdout.trim();
    }
    throw error;
  }
}

if (!fs.existsSync(featureMapPath)) {
  console.error('Feature map missing: docs/repo-feature-map/index.md');
  process.exit(1);
}

const featureMap = fs.readFileSync(featureMapPath, 'utf8');
const match = featureMap.match(/source_head_sha=([a-f0-9]{40})/);
if (!match) {
  console.error('Feature map missing source_head_sha metadata');
  process.exit(1);
}

const indexedSha = match[1];
const latestCodeSha = git(['log', '-n', '1', '--format=%H', '--', ...codePaths]);

if (!latestCodeSha) {
  console.log('Feature map freshness check skipped: no code commits found');
  process.exit(0);
}

const dirtyRelevant = git(['status', '--short', '--', ...codePaths])
  .split('\n')
  .filter(Boolean);
if (dirtyRelevant.length > 0) {
  console.warn('Feature map freshness warning: relevant code paths have uncommitted changes.');
  for (const line of dirtyRelevant) console.warn(`- ${line}`);
  console.warn('Freshness is checked against the latest committed code only.');
}

if (indexedSha === latestCodeSha) {
  console.log(`Feature map freshness check passed (${indexedSha.slice(0, 7)})`);
  process.exit(0);
}

let ancestor = false;
try {
  git(['merge-base', '--is-ancestor', indexedSha, latestCodeSha]);
  ancestor = true;
} catch {
  ancestor = false;
}

if (ancestor) {
  console.error(
    `Feature map is stale: source_head_sha ${indexedSha.slice(0, 7)} is behind latest code commit ${latestCodeSha.slice(0, 7)}.`,
  );
  console.error('Update docs/repo-feature-map/index.md and docs/repo-feature-map/log.md when stable entrypoints changed.');
  process.exit(1);
}

console.error(
  `Feature map source_head_sha ${indexedSha.slice(0, 7)} is not an ancestor of latest code commit ${latestCodeSha.slice(0, 7)}.`,
);
console.error('Verify the feature map metadata and current branch history.');
process.exit(1);
