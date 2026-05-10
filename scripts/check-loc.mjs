import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const maxIndex = args.indexOf('--max');
const max = maxIndex >= 0 ? Number.parseInt(args[maxIndex + 1] || '700', 10) : 700;
const roots = ['src', 'web/src'];
const offenders = [];
const baselinePath = path.join(process.cwd(), 'scripts', 'check-loc-baseline.json');
const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  : {};

function scan(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = path.resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      scan(fullPath);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
    const lineCount = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/).length;
    const normalizedPath = fullPath.replace(/\//g, '\\');
    const allowedMax = Math.max(max, Number(baseline[normalizedPath] || 0));
    if (lineCount > allowedMax) {
      offenders.push({ file: fullPath, lineCount });
    }
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) {
    scan(root);
  }
}

if (offenders.length === 0) {
  console.log(`LOC check passed (max ${max})`);
  process.exit(0);
}

console.error(`LOC check failed: ${offenders.length} file(s) exceed ${max} lines`);
for (const offender of offenders) {
  console.error(`- ${offender.file}: ${offender.lineCount}`);
}
process.exit(1);
