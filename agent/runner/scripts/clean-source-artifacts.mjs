import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function candidateSourcePaths(filePath) {
  const normalized = String(filePath || '');
  if (normalized.endsWith('.d.ts.map')) {
    return [
      normalized.slice(0, -'.d.ts.map'.length) + '.ts',
      normalized.slice(0, -'.d.ts.map'.length) + '.tsx',
    ];
  }
  if (normalized.endsWith('.d.ts')) {
    return [
      normalized.slice(0, -'.d.ts'.length) + '.ts',
      normalized.slice(0, -'.d.ts'.length) + '.tsx',
    ];
  }
  if (normalized.endsWith('.js.map')) {
    return [
      normalized.slice(0, -'.js.map'.length) + '.ts',
      normalized.slice(0, -'.js.map'.length) + '.tsx',
    ];
  }
  if (normalized.endsWith('.js')) {
    return [
      normalized.slice(0, -'.js'.length) + '.ts',
      normalized.slice(0, -'.js'.length) + '.tsx',
    ];
  }
  return [];
}

function shouldDeleteArtifact(filePath) {
  return candidateSourcePaths(filePath).some((candidate) =>
    fs.existsSync(candidate),
  );
}

function walk(dirPath, out) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (
      fullPath.endsWith('.js') ||
      fullPath.endsWith('.js.map') ||
      fullPath.endsWith('.d.ts') ||
      fullPath.endsWith('.d.ts.map')
    ) {
      out.push(fullPath);
    }
  }
}

export function cleanRunnerSourceArtifacts(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const runnerSrcDir = path.join(rootDir, 'agent', 'runner', 'src');
  const artifactPaths = [];
  walk(runnerSrcDir, artifactPaths);

  const removed = [];
  for (const artifactPath of artifactPaths) {
    if (!shouldDeleteArtifact(artifactPath)) continue;
    fs.rmSync(artifactPath, { force: true });
    removed.push(artifactPath);
  }
  return removed;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const removed = cleanRunnerSourceArtifacts({
    rootDir: path.resolve(path.dirname(currentFile), '..', '..', '..'),
  });
  if (removed.length > 0) {
    console.log(
      `Removed ${removed.length} runner source artifact(s):\n${removed.join('\n')}`,
    );
  }
}
