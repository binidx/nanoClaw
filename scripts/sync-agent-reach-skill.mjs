#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const sourceRoot = '/proj/Agent-Reach/agent_reach/skill';
const targetRoot = path.resolve(
  'src/extension/marketplaces/agent-reach/bundles/agent-reach/skills/agent-reach',
);

function copyRecursive(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

if (!fs.existsSync(sourceRoot)) {
  console.error(`Agent Reach source not found: ${sourceRoot}`);
  process.exit(1);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
copyRecursive(sourceRoot, targetRoot);
console.log(`Synced Agent Reach skill bundle to ${targetRoot}`);
