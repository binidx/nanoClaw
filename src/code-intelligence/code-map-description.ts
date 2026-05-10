import fs from 'node:fs';
import path from 'node:path';

import type { CodeMapSnapshot, CodeMapFile } from './code-map-types.js';
import { t } from '../i18n/index.js';

export interface RepoModule {
  name: string;
  directory: string;
  description: string;
  keyFiles: string[];
  fileCount: number;
  lineCount: number;
}

export interface RepoEntryPoint {
  file: string;
  description: string;
}

export interface RepoDescription {
  repositoryId: string;
  branch: string;
  manifestHash: string;
  overview: string;
  techStack: string[];
  architecture: string;
  modules: RepoModule[];
  entryPoints: RepoEntryPoint[];
  stats: {
    languages: Record<string, number>;
    totalFiles: number;
    totalLines: number;
    totalSymbols: number;
  };
  generatedAt: string;
}

const ENTRY_PATTERNS = [
  /^index\.\w+$/,
  /^main\.\w+$/,
  /^app\.\w+$/,
  /^server\.\w+$/,
  /^cli\.\w+$/,
  /^start\.\w+$/,
  /^entry\.\w+$/,
];

const PKG_FILES: Record<string, string> = {
  'package.json': 'Node.js / JavaScript',
  'requirements.txt': 'Python',
  'setup.py': 'Python',
  'pyproject.toml': 'Python',
  'Cargo.toml': 'Rust',
  'go.mod': 'Go',
  'pom.xml': 'Java / Maven',
  'build.gradle': 'Java / Gradle',
  'build.gradle.kts': 'Kotlin / Gradle',
  'Gemfile': 'Ruby',
  'composer.json': 'PHP',
  'CMakeLists.txt': 'C/C++',
  'Makefile': 'Make',
  'pubspec.yaml': 'Dart / Flutter',
};

export function identifyModules(snapshot: CodeMapSnapshot): RepoModule[] {
  const dirMap = new Map<string, CodeMapFile[]>();
  for (const file of snapshot.files) {
    const parts = file.relativePath.split('/');
    const topDir = parts.length > 1 ? parts[0] : '.';
    const group = dirMap.get(topDir) || [];
    group.push(file);
    dirMap.set(topDir, group);
  }

  const modules: RepoModule[] = [];
  const entries = Array.from(dirMap.entries()).sort((a, b) => b[1].length - a[1].length);

  for (const [dir, files] of entries) {
    if (dir === '.' && files.length <= 2) continue;
    const keyFiles = [...files]
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 5)
      .map((f) => f.relativePath);
    const lineCount = files.reduce((s, f) => s + f.lineCount, 0);

    modules.push({
      name: dir === '.' ? t('prompts.auto_c2b9f4', {}, undefined) : dir,
      directory: dir,
      description: '',
      keyFiles,
      fileCount: files.length,
      lineCount,
    });
  }

  return modules.slice(0, 20);
}

export function identifyEntryPoints(snapshot: CodeMapSnapshot): RepoEntryPoint[] {
  const refCounts = new Map<string, number>();
  for (const edge of snapshot.edges) {
    refCounts.set(edge.toFile, (refCounts.get(edge.toFile) || 0) + 1);
  }

  const candidates: Array<{ file: CodeMapFile; score: number }> = [];
  for (const file of snapshot.files) {
    const fileName = file.relativePath.split('/').pop() || '';
    const isEntry = ENTRY_PATTERNS.some((p) => p.test(fileName));
    const refCount = refCounts.get(file.relativePath) || 0;
    if (isEntry || file.rank > 0.02 || refCount > 5) {
      const score = (isEntry ? 10 : 0) + file.rank * 100 + refCount;
      candidates.push({ file, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 8).map((c) => ({
    file: c.file.relativePath,
    description: t('prompts.entryPointDescription', { language: c.file.language, lineCount: c.file.lineCount, symbolCount: c.file.symbols.length }, undefined),
  }));
}

export function extractTechStack(rootDir: string): string[] {
  const stack: string[] = [];
  for (const [file, label] of Object.entries(PKG_FILES)) {
    const absPath = path.join(rootDir, file);
    try {
      if (fs.statSync(absPath).isFile()) stack.push(label);
    } catch { /* skip */ }
  }

  const pkgJsonPath = path.join(rootDir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = { ...(pkg.dependencies as Record<string, string> | undefined) };
    const knownFrameworks: Record<string, string> = {
      react: 'React', vue: 'Vue', angular: 'Angular', next: 'Next.js', nuxt: 'Nuxt',
      express: 'Express', koa: 'Koa', fastify: 'Fastify', nestjs: 'NestJS',
      vite: 'Vite', webpack: 'Webpack', typescript: 'TypeScript',
      prisma: 'Prisma', sequelize: 'Sequelize', mongoose: 'Mongoose',
      tailwindcss: 'Tailwind CSS', 'better-sqlite3': 'SQLite',
      pg: 'PostgreSQL', mysql2: 'MySQL',
    };
    for (const [dep, label] of Object.entries(knownFrameworks)) {
      if (deps[dep] || (pkg.devDependencies as Record<string, string> | undefined)?.[dep]) {
        stack.push(label);
      }
    }
  } catch { /* no package.json */ }

  return [...new Set(stack)];
}

export function computeLanguageStats(snapshot: CodeMapSnapshot): Record<string, number> {
  const langs: Record<string, number> = {};
  for (const file of snapshot.files) {
    const lang = file.language || 'unknown';
    langs[lang] = (langs[lang] || 0) + 1;
  }
  return langs;
}

const README_MAX_BYTES = 8 * 1024;

export function readReadmeSnippet(rootDir: string, maxLines = 30): string | null {
  for (const name of ['README.md', 'README.rst', 'README.txt', 'README']) {
    const absPath = path.join(rootDir, name);
    let fd: number | undefined;
    try {
      fd = fs.openSync(absPath, 'r');
      const buf = Buffer.alloc(README_MAX_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, README_MAX_BYTES, 0);
      const content = buf.subarray(0, bytesRead).toString('utf-8');
      const lines = content.split('\n').slice(0, maxLines);
      return lines.join('\n');
    } catch { /* skip */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return null;
}

export function readPackageDescription(rootDir: string): string | null {
  const pkgJsonPath = path.join(rootDir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    if (pkg.name) parts.push(`name: ${pkg.name}`);
    if (pkg.description) parts.push(`description: ${pkg.description}`);
    return parts.length > 0 ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

export function buildRepoDescriptionPrompt(
  snapshot: CodeMapSnapshot,
  rootDir: string,
): string {
  const modules = identifyModules(snapshot);
  const entryPoints = identifyEntryPoints(snapshot);
  const techStack = extractTechStack(rootDir);
  const langStats = computeLanguageStats(snapshot);
  const readme = readReadmeSnippet(rootDir, 30);
  const pkgDesc = readPackageDescription(rootDir);

  const lines: string[] = [
    t('prompts.auto_b977d4', {}, undefined),
    '',
    t('prompts.auto_6cc117', {}, undefined),
    '{',
    t('prompts.auto_7a4758', {}, undefined),
    t('prompts.auto_d1ccb0', {}, undefined),
    t('prompts.auto_0e4820', {}, undefined),
    '}',
    '',
    t('prompts.auto_6ef4bf', {}, undefined),
    t('prompts.repoLabel', { repositoryId: snapshot.repositoryId }, undefined),
    t('prompts.branchLabel', { branch: snapshot.branch }, undefined),
    t('prompts.fileStatsLabel', { fileCount: snapshot.stats.fileCount, symbolCount: snapshot.stats.symbolCount, edgeCount: snapshot.stats.edgeCount, totalLines: snapshot.stats.totalLines }, undefined),
    '',
  ];

  if (pkgDesc) {
    lines.push(t('prompts.auto_2be716', {}, undefined), pkgDesc, '');
  }

  if (techStack.length > 0) {
    lines.push(t('prompts.techStackLabel', { stack: techStack.join(', ') }, undefined), '');
  }

  const langEntries = Object.entries(langStats).sort((a, b) => b[1] - a[1]).slice(0, 10);
  lines.push(t('prompts.auto_777ac3', {}, undefined));
  for (const [lang, count] of langEntries) {
    lines.push(t('prompts.langFileCount', { lang, count }, undefined));
  }
  lines.push('');

  lines.push(t('prompts.auto_87c776', {}, undefined));
  for (const mod of modules) {
    lines.push(t('prompts.moduleInfo', { directory: mod.directory, fileCount: mod.fileCount, lineCount: mod.lineCount }, undefined));
    lines.push(t('prompts.keyFilesLabel', { files: mod.keyFiles.join(', ') }, undefined));
  }
  lines.push('');

  if (entryPoints.length > 0) {
    lines.push(t('prompts.auto_be05a6', {}, undefined));
    for (const ep of entryPoints) {
      lines.push(`  ${ep.file} (${ep.description})`);
    }
    lines.push('');
  }

  if (readme) {
    lines.push(t('prompts.auto_265a38', {}, undefined), readme, '');
  }

  lines.push(t('prompts.auto_c04b39', {}, undefined));

  return lines.join('\n');
}

export function assembleRepoDescription(
  snapshot: CodeMapSnapshot,
  rootDir: string,
  aiResult: { overview: string; architecture: string; modules: Array<{ name: string; directory: string; description: string }> },
): RepoDescription {
  const rawModules = identifyModules(snapshot);
  const entryPoints = identifyEntryPoints(snapshot);
  const techStack = extractTechStack(rootDir);
  const langStats = computeLanguageStats(snapshot);

  const mergedModules: RepoModule[] = rawModules.map((m) => {
    const aiMod = aiResult.modules?.find(
      (am) => am.directory === m.directory || am.name === m.name,
    );
    return {
      ...m,
      name: aiMod?.name || m.name,
      description: aiMod?.description || '',
    };
  });

  return {
    repositoryId: snapshot.repositoryId,
    branch: snapshot.branch,
    manifestHash: snapshot.manifestHash,
    overview: aiResult.overview || '',
    techStack,
    architecture: aiResult.architecture || '',
    modules: mergedModules,
    entryPoints,
    stats: {
      languages: langStats,
      totalFiles: snapshot.stats.fileCount,
      totalLines: snapshot.stats.totalLines,
      totalSymbols: snapshot.stats.symbolCount,
    },
    generatedAt: new Date().toISOString(),
  };
}
