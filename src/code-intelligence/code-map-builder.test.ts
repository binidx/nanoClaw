import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCodeMap,
  resolveJavaImportTarget,
  resolveGoImportTarget,
  resolvePythonImportTarget,
  resolveRustImportTarget,
} from './code-map-builder.js';
import { joinMultilineSignatures } from './code-search-index.js';
import { saveCodeMapToDb, loadCodeMapFromDb } from './code-map-persist.js';
import { _initTestDatabase } from '../db.js';

const tempRoots: string[] = [];

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-map-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

describe('resolveJavaImportTarget', () => {
  it('resolves fully-qualified Java import to file', () => {
    const fileSet = new Set([
      'src/main/java/org/apache/kafka/common/TopicPartition.java',
      'src/main/java/org/apache/kafka/common/utils/Utils.java',
    ]);
    const result = resolveJavaImportTarget(
      'org.apache.kafka.common.TopicPartition',
      fileSet,
      'java',
    );
    expect(result).toEqual(['src/main/java/org/apache/kafka/common/TopicPartition.java']);
  });

  it('resolves wildcard import to all files in package', () => {
    const fileSet = new Set([
      'src/main/java/org/apache/kafka/common/TopicPartition.java',
      'src/main/java/org/apache/kafka/common/Node.java',
      'src/main/java/org/apache/kafka/common/utils/Utils.java',
    ]);
    const result = resolveJavaImportTarget('org.apache.kafka.common.*', fileSet, 'java');
    expect(result).toContain('src/main/java/org/apache/kafka/common/TopicPartition.java');
    expect(result).toContain('src/main/java/org/apache/kafka/common/Node.java');
    expect(result).not.toContain('src/main/java/org/apache/kafka/common/utils/Utils.java');
  });

  it('resolves Scala import', () => {
    const fileSet = new Set([
      'core/src/main/scala/kafka/server/KafkaApis.scala',
    ]);
    const result = resolveJavaImportTarget(
      'kafka.server.KafkaApis',
      fileSet,
      'scala',
    );
    expect(result).toEqual(['core/src/main/scala/kafka/server/KafkaApis.scala']);
  });
});

describe('resolveGoImportTarget', () => {
  it('resolves Go module import to all files in directory', () => {
    const fileSet = new Set([
      'pkg/foo/handler.go',
      'pkg/foo/util.go',
      'pkg/bar/service.go',
    ]);
    const result = resolveGoImportTarget('github.com/org/repo/pkg/foo', fileSet);
    expect(result).toContain('pkg/foo/handler.go');
    expect(result).toContain('pkg/foo/util.go');
    expect(result).not.toContain('pkg/bar/service.go');
  });

  it('returns empty array for unknown import', () => {
    const fileSet = new Set(['pkg/bar/service.go']);
    expect(resolveGoImportTarget('github.com/org/repo/pkg/foo', fileSet)).toEqual([]);
  });
});

describe('resolvePythonImportTarget', () => {
  it('resolves dot-path to .py file', () => {
    const fileSet = new Set([
      'orders/service.py',
      'orders/__init__.py',
    ]);
    const result = resolvePythonImportTarget('orders.service', fileSet);
    expect(result).toEqual(['orders/service.py']);
  });

  it('resolves to __init__.py for package', () => {
    const fileSet = new Set([
      'orders/__init__.py',
    ]);
    const result = resolvePythonImportTarget('orders', fileSet);
    expect(result).toEqual(['orders/__init__.py']);
  });
});

describe('joinMultilineSignatures', () => {
  it('joins Java method signatures split across lines', () => {
    const lines = [
      '    public void handleFetchRequest(',
      '        FetchRequest request,',
      '        RequestContext context) {',
      '        // body',
      '    }',
    ];
    const joined = joinMultilineSignatures(lines);
    expect(joined.length).toBeLessThan(lines.length);
    expect(joined[0]).toContain('handleFetchRequest');
    expect(joined[0]).toContain('RequestContext context)');
  });

  it('leaves single-line signatures intact', () => {
    const lines = [
      'public class KafkaApis {',
      '    public void handle(Request req) {',
      '    }',
      '}',
    ];
    const joined = joinMultilineSignatures(lines);
    expect(joined).toEqual(lines);
  });
});

describe('buildCodeMap — basic TS/JS project', () => {
  it('builds edges and computes PageRank for TS files', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/index.ts', [
      "import { greet } from './greet';",
      "import { format } from './format';",
      'export function main() { greet(); format(); }',
    ].join('\n'));
    writeFile(root, 'src/greet.ts', [
      "import { format } from './format';",
      'export function greet() { return format("hello"); }',
    ].join('\n'));
    writeFile(root, 'src/format.ts', [
      'export function format(s: string) { return s.toUpperCase(); }',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'test-repo', 'main');

    expect(snapshot.stats.fileCount).toBe(3);
    expect(snapshot.stats.edgeCount).toBeGreaterThanOrEqual(3);

    const formatFile = snapshot.files.find((f) => f.relativePath.includes('format'));
    const indexFile = snapshot.files.find((f) => f.relativePath.includes('index'));
    expect(formatFile).toBeDefined();
    expect(indexFile).toBeDefined();
    expect(formatFile!.rank).toBeGreaterThan(indexFile!.rank);
  });
});

describe('buildCodeMap — Kafka-style Java project', () => {
  it('resolves Java imports and ranks by dependency', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/main/java/org/apache/kafka/common/TopicPartition.java', [
      'package org.apache.kafka.common;',
      '',
      'public class TopicPartition {',
      '    private final String topic;',
      '    private final int partition;',
      '    public TopicPartition(String topic, int partition) {',
      '        this.topic = topic;',
      '        this.partition = partition;',
      '    }',
      '    public String topic() { return topic; }',
      '    public int partition() { return partition; }',
      '}',
    ].join('\n'));
    writeFile(root, 'src/main/java/org/apache/kafka/server/KafkaApis.java', [
      'package org.apache.kafka.server;',
      '',
      'import org.apache.kafka.common.TopicPartition;',
      '',
      'public class KafkaApis {',
      '    public void handleFetchRequest(TopicPartition tp) {',
      '        String topic = tp.topic();',
      '    }',
      '}',
    ].join('\n'));
    writeFile(root, 'src/main/java/org/apache/kafka/server/ReplicaManager.java', [
      'package org.apache.kafka.server;',
      '',
      'import org.apache.kafka.common.TopicPartition;',
      '',
      'public class ReplicaManager {',
      '    public void fetchMessages(TopicPartition tp) {}',
      '}',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'kafka', 'trunk');

    expect(snapshot.stats.fileCount).toBe(3);
    expect(snapshot.stats.edgeCount).toBeGreaterThanOrEqual(2);

    const tpFile = snapshot.files.find((f) => f.relativePath.includes('TopicPartition'));
    expect(tpFile).toBeDefined();
    expect(tpFile!.rank).toBeGreaterThan(0);

    const kafkaApisFile = snapshot.files.find((f) => f.relativePath.includes('KafkaApis'));
    expect(kafkaApisFile).toBeDefined();
    expect(tpFile!.rank).toBeGreaterThanOrEqual(kafkaApisFile!.rank);
  });

  it('extracts static nested class', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/main/java/kafka/server/Outer.java', [
      'package kafka.server;',
      '',
      'public class Outer {',
      '    public static class Builder {',
      '        public Outer build() { return new Outer(); }',
      '    }',
      '}',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'kafka', 'trunk');
    const outerFile = snapshot.files.find((f) => f.relativePath.includes('Outer'));
    expect(outerFile).toBeDefined();
    const classNames = outerFile!.symbols.filter((s) => s.kind === 'class').map((s) => s.name);
    expect(classNames).toContain('Outer');
    expect(classNames).toContain('Builder');
  });

  it('handles multiline Java method signature', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/main/java/kafka/server/Handler.java', [
      'package kafka.server;',
      '',
      'public class Handler {',
      '    public void processRequest(',
      '            String topic,',
      '            int partition) {',
      '        // body',
      '    }',
      '}',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'kafka', 'trunk');
    const handler = snapshot.files.find((f) => f.relativePath.includes('Handler'));
    expect(handler).toBeDefined();
    const methodNames = handler!.symbols.filter((s) => s.kind === 'method').map((s) => s.name);
    expect(methodNames).toContain('processRequest');
  });
});

describe('buildCodeMap — Scala project', () => {
  it('extracts trait, object, and class', () => {
    const root = createTempWorkspace();
    writeFile(root, 'core/src/main/scala/kafka/server/KafkaApis.scala', [
      'package kafka.server',
      '',
      'sealed trait RequestHandler {',
      '  def handle(): Unit',
      '}',
      '',
      'class KafkaApis extends RequestHandler {',
      '  override def handle(): Unit = {}',
      '}',
      '',
      'object KafkaApis {',
      '  def apply(): KafkaApis = new KafkaApis()',
      '}',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'kafka-scala', 'main');
    const file = snapshot.files.find((f) => f.relativePath.includes('KafkaApis'));
    expect(file).toBeDefined();
    const kinds = file!.symbols.map((s) => s.kind);
    expect(kinds).toContain('trait');
    expect(kinds).toContain('class');
    expect(kinds).toContain('module');
  });
});

describe('buildCodeMap — maxFiles limit', () => {
  it('respects maxFiles option', () => {
    const root = createTempWorkspace();
    for (let i = 0; i < 20; i++) {
      writeFile(root, `src/file${i}.ts`, `export const val${i} = ${i};\n`);
    }
    const snapshot = buildCodeMap(root, 'test', 'main', { maxFiles: 10 });
    expect(snapshot.stats.fileCount).toBeLessThanOrEqual(10);
  });
});

describe('resolveRustImportTarget', () => {
  it('resolves crate::module::item to .rs file', () => {
    const fileSet = new Set(['src/config.rs', 'src/utils/mod.rs']);
    expect(resolveRustImportTarget('crate::config', fileSet)).toEqual(['src/config.rs']);
  });

  it('resolves to mod.rs directory', () => {
    const fileSet = new Set(['src/utils/mod.rs', 'src/config.rs']);
    expect(resolveRustImportTarget('crate::utils', fileSet)).toEqual(['src/utils/mod.rs']);
  });

  it('returns empty for unmatched use', () => {
    const fileSet = new Set(['src/config.rs']);
    expect(resolveRustImportTarget('crate::missing', fileSet)).toEqual([]);
  });
});

describe('buildCodeMap — Kotlin project', () => {
  it('extracts Kotlin class, object, fun, data class', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/main/kotlin/com/example/App.kt', [
      'package com.example',
      '',
      'data class User(val name: String, val age: Int)',
      '',
      'object AppConfig {',
      '    val VERSION = "1.0"',
      '}',
      '',
      'fun main() {',
      '    println(AppConfig.VERSION)',
      '}',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'kt-test', 'main');
    const file = snapshot.files.find((f) => f.relativePath.includes('App.kt'));
    expect(file).toBeDefined();
    const names = file!.symbols.map((s) => s.name);
    expect(names).toContain('User');
    expect(names).toContain('AppConfig');
    expect(names).toContain('main');
  });
});

describe('buildCodeMap — Rust project', () => {
  it('extracts Rust struct, fn, and resolves use imports', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/config.rs', [
      'pub struct Config {',
      '    pub name: String,',
      '}',
      '',
      'pub fn default_config() -> Config {',
      '    Config { name: "default".to_string() }',
      '}',
    ].join('\n'));
    writeFile(root, 'src/main.rs', [
      'mod config;',
      '',
      'use config::Config;',
      '',
      'fn main() {',
      '    let c = config::default_config();',
      '    println!("{}", c.name);',
      '}',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'rs-test', 'main');
    expect(snapshot.stats.fileCount).toBe(2);
    const configFile = snapshot.files.find((f) => f.relativePath.includes('config.rs'));
    expect(configFile).toBeDefined();
    const names = configFile!.symbols.map((s) => s.name);
    expect(names).toContain('Config');
    expect(names).toContain('default_config');
  });
});

describe('buildCodeMap — Java wildcard edges', () => {
  it('creates edges for wildcard import to all files in package', () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/main/java/com/example/models/User.java', [
      'package com.example.models;',
      'public class User {}',
    ].join('\n'));
    writeFile(root, 'src/main/java/com/example/models/Order.java', [
      'package com.example.models;',
      'public class Order {}',
    ].join('\n'));
    writeFile(root, 'src/main/java/com/example/App.java', [
      'package com.example;',
      'import com.example.models.*;',
      'public class App { }',
    ].join('\n'));

    const snapshot = buildCodeMap(root, 'wildcard-test', 'main');
    const appEdges = snapshot.edges.filter((e) => e.fromFile.includes('App.java'));
    expect(appEdges.length).toBeGreaterThanOrEqual(2);
    const targets = appEdges.map((e) => e.toFile);
    expect(targets.some((t) => t.includes('User.java'))).toBe(true);
    expect(targets.some((t) => t.includes('Order.java'))).toBe(true);
  });
});

describe('DB persistence round-trip', () => {
  it('saves and loads a snapshot with edges and ranks', async () => {
    const root = createTempWorkspace();
    writeFile(root, 'src/a.ts', [
      "import { b } from './b';",
      'export function a() { return b(); }',
    ].join('\n'));
    writeFile(root, 'src/b.ts', [
      'export function b() { return 42; }',
    ].join('\n'));

    const original = buildCodeMap(root, 'round-trip-test', 'main');
    expect(original.stats.fileCount).toBe(2);
    expect(original.edges.length).toBeGreaterThanOrEqual(1);

    await saveCodeMapToDb(original);
    const loaded = await loadCodeMapFromDb('round-trip-test', 'main');
    expect(loaded).not.toBeNull();
    expect(loaded!.repositoryId).toBe('round-trip-test');
    expect(loaded!.branch).toBe('main');
    expect(loaded!.stats.fileCount).toBe(original.stats.fileCount);
    expect(loaded!.stats.edgeCount).toBe(original.stats.edgeCount);
    expect(loaded!.edges.length).toBe(original.edges.length);
    expect(loaded!.files.length).toBe(original.files.length);

    for (const origFile of original.files) {
      const loadedFile = loaded!.files.find((f) => f.relativePath === origFile.relativePath);
      expect(loadedFile).toBeDefined();
      expect(loadedFile!.rank).toBeCloseTo(origFile.rank, 5);
      expect(loadedFile!.symbols.length).toBe(origFile.symbols.length);
    }
  });
});
