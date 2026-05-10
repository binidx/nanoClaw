import { describe, it, expect } from 'vitest';
import {
  BUILTIN_PROFILES,
  findProfileById,
  mergeProfileEnv,
  validateProfileTools,
  type RunnerProfile,
} from './runner-profiles.js';

describe('BUILTIN_PROFILES', () => {
  it('exposes the four Phase 1 profiles', () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id).sort();
    expect(ids).toEqual(['go', 'java8', 'nodejs', 'python']);
  });

  it('each profile has the required fields populated', () => {
    for (const p of BUILTIN_PROFILES) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(Array.isArray(p.detect.files)).toBe(true);
      expect(p.detect.files.length).toBeGreaterThan(0);
      expect(typeof p.detect.priority).toBe('number');
      expect(Array.isArray(p.requiredTools)).toBe(true);
      expect(p.requiredTools.length).toBeGreaterThan(0);
      expect(p.testCommand).toBeTruthy();
      expect(Array.isArray(p.testSuccessPatterns)).toBe(true);
    }
  });

  it('java8 profile targets pom.xml / build.gradle and requires java + mvn or gradle', () => {
    const j = findProfileById('java8');
    expect(j).toBeDefined();
    expect(j!.detect.files).toEqual(
      expect.arrayContaining(['pom.xml', 'build.gradle']),
    );
    expect(j!.requiredTools).toContain('java');
    expect(j!.testCommand.length).toBeGreaterThan(0);
  });

  it('go profile detects go.mod and requires go tool', () => {
    const g = findProfileById('go');
    expect(g).toBeDefined();
    expect(g!.detect.files).toContain('go.mod');
    expect(g!.requiredTools).toContain('go');
    expect(g!.testCommand).toMatch(/go\s+test/);
  });

  it('python profile detects pyproject.toml / requirements.txt', () => {
    const p = findProfileById('python');
    expect(p).toBeDefined();
    expect(p!.detect.files).toEqual(
      expect.arrayContaining(['pyproject.toml', 'requirements.txt']),
    );
    expect(p!.requiredTools).toEqual(expect.arrayContaining(['python3']));
  });

  it('nodejs profile detects package.json and requires node + npm', () => {
    const n = findProfileById('nodejs');
    expect(n).toBeDefined();
    expect(n!.detect.files).toContain('package.json');
    expect(n!.requiredTools).toEqual(expect.arrayContaining(['node', 'npm']));
  });
});

describe('findProfileById', () => {
  it('returns a profile for a known id', () => {
    expect(findProfileById('nodejs')?.id).toBe('nodejs');
  });

  it('returns undefined for unknown id', () => {
    expect(findProfileById('cobol')).toBeUndefined();
  });

  it('returns undefined for empty / whitespace id', () => {
    expect(findProfileById('')).toBeUndefined();
    expect(findProfileById('   ')).toBeUndefined();
  });
});

describe('mergeProfileEnv', () => {
  const makeProfile = (
    overrides: Partial<RunnerProfile['env']> = {},
  ): RunnerProfile => ({
    id: 'test',
    name: 'Test',
    description: '',
    detect: { files: [], priority: 0 },
    env: overrides,
    requiredTools: [],
    testCommand: 'echo test',
    testSuccessPatterns: [],
  });

  it('prepends pathPrepend entries to PATH', () => {
    const base = { PATH: '/usr/bin:/bin', HOME: '/home/me' };
    const profile = makeProfile({
      pathPrepend: ['/opt/jdk8/bin', '/opt/maven/bin'],
    });
    const merged = mergeProfileEnv(base, profile);
    expect(merged.PATH).toBe('/opt/jdk8/bin:/opt/maven/bin:/usr/bin:/bin');
    expect(merged.HOME).toBe('/home/me');
  });

  it('creates PATH even if base has none', () => {
    const base: Record<string, string | undefined> = {};
    const profile = makeProfile({ pathPrepend: ['/opt/jdk8/bin'] });
    const merged = mergeProfileEnv(base, profile);
    expect(merged.PATH).toBe('/opt/jdk8/bin');
  });

  it('overwrites extra env but does not touch unrelated keys', () => {
    const base = { PATH: '/bin', LANG: 'en_US.UTF-8' };
    const profile = makeProfile({
      extra: { JAVA_HOME: '/opt/jdk8', MAVEN_OPTS: '-Xmx512m' },
    });
    const merged = mergeProfileEnv(base, profile);
    expect(merged.JAVA_HOME).toBe('/opt/jdk8');
    expect(merged.MAVEN_OPTS).toBe('-Xmx512m');
    expect(merged.LANG).toBe('en_US.UTF-8');
  });

  it('extra overrides base for same key', () => {
    const base = { PATH: '/bin', JAVA_HOME: '/old/java' };
    const profile = makeProfile({ extra: { JAVA_HOME: '/opt/jdk8' } });
    const merged = mergeProfileEnv(base, profile);
    expect(merged.JAVA_HOME).toBe('/opt/jdk8');
  });

  it('empty profile env leaves base untouched', () => {
    const base = { PATH: '/bin', HOME: '/home' };
    const merged = mergeProfileEnv(base, makeProfile({}));
    expect(merged).toEqual(base);
  });

  it('does not mutate the input base object', () => {
    const base = { PATH: '/bin' };
    const snapshot = { ...base };
    mergeProfileEnv(base, makeProfile({ pathPrepend: ['/opt/new'] }));
    expect(base).toEqual(snapshot);
  });

  it('skips empty pathPrepend strings', () => {
    const base = { PATH: '/bin' };
    const profile = makeProfile({ pathPrepend: ['', '/opt/new', ''] });
    const merged = mergeProfileEnv(base, profile);
    expect(merged.PATH).toBe('/opt/new:/bin');
  });
});

describe('validateProfileTools', () => {
  const profile: RunnerProfile = {
    id: 'java8',
    name: 'Java 8',
    description: '',
    detect: { files: ['pom.xml'], priority: 10 },
    env: {},
    requiredTools: ['java', 'mvn'],
    testCommand: 'mvn test',
    testSuccessPatterns: ['BUILD SUCCESS'],
    toolHint: 'Install OpenJDK 8 and Maven, or set JAVA_HOME.',
  };

  it('ok=true when every required tool is available', () => {
    const result = validateProfileTools(profile, () => true);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('ok=false with missing list when some tool is absent', () => {
    const present = new Set(['java']);
    const result = validateProfileTools(profile, (t) => present.has(t));
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['mvn']);
  });

  it('ok=false with all tools missing reported', () => {
    const result = validateProfileTools(profile, () => false);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['java', 'mvn']);
  });

  it('empty requiredTools always ok', () => {
    const empty: RunnerProfile = { ...profile, requiredTools: [] };
    expect(validateProfileTools(empty, () => false).ok).toBe(true);
  });
});
