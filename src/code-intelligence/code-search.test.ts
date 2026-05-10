import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCodeSearchIndex,
  getCodeSearchCacheStatus,
  loadOrBuildPersistentCodeSearchIndex,
  searchCodeReferenceHints,
  searchCodeSymbols,
} from './code-search.js';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

describe('code search', () => {
  it('extracts imports and symbols across supported languages', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'src/order-service.ts',
      [
        "import { buildOrderSummary } from './summary';",
        'export class OrderService {',
        '  async runSync(orderId: string) {',
        '    return buildOrderSummary(orderId);',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'pkg/sync/service.go',
      [
        'package syncsvc',
        '',
        'import "example.com/acme/order"',
        '',
        'type Reconciler struct{}',
        '',
        'func (r Reconciler) RunOrderSync() error {',
        '  return nil',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'app/reconcile.py',
      [
        'from order.jobs import OrderWorker',
        '',
        'class ReconcileRunner:',
        '    async def run_order_reconcile(self):',
        '        return OrderWorker()',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/main/java/com/acme/OrderSyncJob.java',
      [
        'package com.acme;',
        '',
        'import com.acme.order.OrderRepository;',
        '',
        'public class OrderSyncJob {',
        '  public void runJob() {',
        '  }',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const tsFile = index.files.find((file) => file.relativePath === 'src/order-service.ts');
    const goFile = index.files.find((file) => file.relativePath === 'pkg/sync/service.go');
    const pyFile = index.files.find((file) => file.relativePath === 'app/reconcile.py');
    const javaFile = index.files.find(
      (file) => file.relativePath === 'src/main/java/com/acme/OrderSyncJob.java',
    );

    expect(tsFile?.imports).toEqual([
      expect.objectContaining({
        modulePath: './summary',
        symbolName: 'buildOrderSummary',
      }),
    ]);
    expect(goFile?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'package', name: 'syncsvc' }),
        expect.objectContaining({ kind: 'struct', name: 'Reconciler' }),
        expect.objectContaining({ kind: 'method', name: 'RunOrderSync' }),
      ]),
    );
    expect(pyFile?.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'ReconcileRunner' }),
        expect.objectContaining({
          kind: 'function',
          name: 'run_order_reconcile',
        }),
      ]),
    );
    expect(javaFile?.imports).toEqual([
      expect.objectContaining({
        modulePath: 'com.acme.order.OrderRepository',
        symbolName: 'OrderRepository',
      }),
    ]);
  });

  it('persists imports in sqlite and reuses the cache for stable workspace keys', async () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'src/order-service.ts',
      [
        "import { OrderRepository } from './repo';",
        'export class OrderService {}',
      ].join('\n'),
    );

    const first = await loadOrBuildPersistentCodeSearchIndex(root, {
      cacheKey: 'workspace-a',
    });
    const second = await loadOrBuildPersistentCodeSearchIndex(root, {
      cacheKey: 'workspace-a',
    });

    expect(first?.source).toBe('rebuilt');
    expect(second?.source).toBe('database');
    expect(second?.index.files[0]?.imports).toEqual([
      expect.objectContaining({
        modulePath: './repo',
        symbolName: 'OrderRepository',
      }),
    ]);
    expect(
      getCodeSearchCacheStatus(root, {
        cacheKey: 'workspace-a',
      }),
    ).toMatchObject({
      cacheKey: 'code-search-index:workspace-a',
      status: 'fresh',
    });
  });

  it('treats maxFiles 0 as unlimited when building the index', () => {
    const root = createTempWorkspace();
    writeFile(root, 'app/src/InventoryService.ts', 'export class InventoryService {}\n');
    writeFile(root, 'app/src/OutboundService.ts', 'export class OutboundService {}\n');
    writeFile(root, 'app/src/InboundService.ts', 'export class InboundService {}\n');

    const index = buildCodeSearchIndex(root, { maxFiles: 0 });

    expect(index.fileCount).toBe(3);
    expect(index.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining([
        'app/src/InventoryService.ts',
        'app/src/OutboundService.ts',
        'app/src/InboundService.ts',
      ]),
    );
  });

  it('applies include and exclude globs during indexing', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'app/src/InventorySyncJob.java',
      [
        'package com.example.project;',
        'public class InventorySyncJob {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'app/generated/InventorySyncJobGenerated.java',
      [
        'package com.example.project.generated;',
        'public class InventorySyncJobGenerated {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'bms-service/src/BillingSyncJob.java',
      [
        'package com.example.bms;',
        'public class BillingSyncJob {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root, {
      maxFiles: 0,
      includeGlobs: ['app/**'],
      excludeGlobs: ['**/generated/**'],
    });

    expect(index.files.map((file) => file.relativePath)).toEqual([
      'app/src/InventorySyncJob.java',
    ]);
    expect(searchCodeSymbols(index, 'InventorySyncJob', { limit: 1 })[0]).toEqual(
      expect.objectContaining({
        relativePath: 'app/src/InventorySyncJob.java',
      }),
    );
    expect(
      searchCodeSymbols(index, 'BillingSyncJob', { limit: 3 }).every(
        (entry) => entry.relativePath !== 'bms-service/src/BillingSyncJob.java',
      ),
    ).toBe(true);
    expect(
      searchCodeSymbols(index, 'InventorySyncJobGenerated', { limit: 3 }).every(
        (entry) =>
          entry.relativePath !== 'app/generated/InventorySyncJobGenerated.java',
      ),
    ).toBe(true);
  });

  it('returns symbol hits and reference hints for code lookup', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'src/order-service.ts',
      [
        "import { OrderRepository } from './repo';",
        'export class OrderService {',
        '  sync(repo: OrderRepository) {',
        '    return repo.findById("1");',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'src/runner.ts',
      [
        "import { OrderService } from './order-service';",
        '',
        'const runner = new OrderService();',
        'runner.sync(repo);',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const symbolHits = searchCodeSymbols(index, 'order service');
    const referenceHints = searchCodeReferenceHints(index, 'OrderService');

    expect(symbolHits[0]).toEqual(
      expect.objectContaining({
        relativePath: 'src/order-service.ts',
        symbol: expect.objectContaining({
          name: 'OrderService',
          kind: 'class',
        }),
      }),
    );
    expect(referenceHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'src/runner.ts',
          matchedBy: 'import',
        }),
        expect.objectContaining({
          relativePath: 'src/runner.ts',
          matchedBy: 'constructor',
        }),
      ]),
    );
  });

  it('prefers module-aligned imports over distant references', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'payments/gateway/service.ts',
      [
        "import { PaymentClient } from '../client';",
        'const client = new PaymentClient();',
        'export class GatewayService {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'helpers/log.ts',
      [
        "import { PaymentClient } from '../client';",
        'export function logPayment(client: PaymentClient) {',
        '  return client;',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const referenceHints = searchCodeReferenceHints(index, 'PaymentClient');

    expect(referenceHints.length).toBeGreaterThanOrEqual(2);
    expect(referenceHints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'payments/gateway/service.ts',
        matchedBy: 'constructor',
      }),
    );
    expect(referenceHints[1]).toEqual(
      expect.objectContaining({
        relativePath: 'payments/gateway/service.ts',
      }),
    );
  });

  it('uses package proximity when directory names align with the query', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'orders/service.py',
      [
        'def sync_orders():',
        '    pass',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const referenceHints = searchCodeReferenceHints(index, 'orders');

    expect(referenceHints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'orders/service.py',
        matchedBy: 'package',
      }),
    );
  });

  it('prefers exact CamelCase symbols over package noise', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/org/apache/kafka/GroupCoordinator.java',
      [
        'package org.apache.kafka;',
        'public class GroupCoordinator {',
        '  public void heartbeat() {}',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/org/apache/kafka/coordinator/Coordinator.java',
      [
        'package org.apache.kafka.coordinator;',
        'public class Coordinator {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hits = searchCodeSymbols(index, 'GroupCoordinator', { limit: 2 });

    expect(hits[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/java/org/apache/kafka/GroupCoordinator.java',
        symbol: expect.objectContaining({
          name: 'GroupCoordinator',
          kind: 'class',
        }),
      }),
    );
  });

  it(
    'falls back to exact source files when the definition file was not indexed',
    () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/image/MetadataDelta.java',
      [
        'package org.apache.kafka.image;',
        'public final class MetadataDelta {',
        '  public MetadataDelta() {}',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala/kafka/server/KafkaApis.scala',
      [
        'package kafka.server',
        'class KafkaApis',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala/kafka/server/ReplicaManager.scala',
      [
        'package kafka.server',
        'class ReplicaManager',
      ].join('\n'),
    );
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java',
      [
        'package org.apache.kafka.controller;',
        'public final class QuorumController {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root, { maxFiles: 2 });

    expect(
      index.files.some(
        (file) =>
          file.relativePath ===
          'metadata/src/main/java/org/apache/kafka/image/MetadataDelta.java',
      ),
    ).toBe(false);

    const hits = searchCodeSymbols(index, 'MetadataDelta', { limit: 2 });

    expect(hits[0]).toEqual(
      expect.objectContaining({
        relativePath: 'metadata/src/main/java/org/apache/kafka/image/MetadataDelta.java',
        symbol: expect.objectContaining({
          name: 'MetadataDelta',
          kind: 'class',
        }),
      }),
    );
    },
    15_000,
  );

  it('prioritizes src/main/java files when maxFiles is constrained', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'src/main/java/org/apache/kafka/Favored.java',
      'public class Favored {}',
    );
    writeFile(
      root,
      'src/test/java/org/apache/kafka/TestFavored.java',
      'public class TestFavored {}',
    );
    writeFile(root, 'misc/Other.java', 'public class Other {}');

    const index = buildCodeSearchIndex(root, { maxFiles: 2 });

    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'src/main/java/org/apache/kafka/Favored.java',
        }),
        expect.objectContaining({
          relativePath: 'src/test/java/org/apache/kafka/TestFavored.java',
        }),
      ]),
    );
    expect(
      index.files.map((file) => file.relativePath),
    ).not.toEqual(
      expect.arrayContaining(['misc/Other.java']),
    );
  });

  it('indexes Scala service classes and ranks exact symbol matches first', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/scala/kafka/server/KafkaApis.scala',
      [
        'package kafka.server',
        'import kafka.network.RequestChannel',
        'class KafkaApis(val requestChannel: RequestChannel) {',
        '  def handle(): Unit = ()',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala/kafka/server/KafkaApiSupport.scala',
      [
        'package kafka.server',
        'object KafkaApiSupport {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root, { maxFiles: 1 });
    const hits = searchCodeSymbols(index, 'KafkaApis', { limit: 3 });

    expect(index.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'core/src/main/scala/kafka/server/KafkaApis.scala',
          language: 'scala',
          symbols: expect.arrayContaining([
            expect.objectContaining({
              name: 'KafkaApis',
              kind: 'class',
            }),
          ]),
        }),
      ]),
    );
    expect(hits[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/scala/kafka/server/KafkaApis.scala',
        symbol: expect.objectContaining({
          name: 'KafkaApis',
          kind: 'class',
        }),
      }),
    );
  });

  it('extracts final Java classes as class symbols', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java',
      [
        'package org.apache.kafka.controller;',
        'public final class QuorumController implements AutoCloseable {',
        '  public void close() {}',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hits = searchCodeSymbols(index, 'QuorumController', { limit: 3 });

    expect(hits[0]).toEqual(
      expect.objectContaining({
        relativePath:
          'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java',
        symbol: expect.objectContaining({
          name: 'QuorumController',
          kind: 'class',
        }),
      }),
    );
  });

  it('retains core Scala modules when maxFiles is constrained alongside clients', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'clients/src/main/java/org/apache/kafka/clients/AdminClient.java',
      [
        'package org.apache.kafka.clients;',
        'public class AdminClient {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'clients/src/main/java/org/apache/kafka/clients/KafkaConsumer.java',
      [
        'package org.apache.kafka.clients;',
        'public class KafkaConsumer {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala/kafka/server/KafkaApis.scala',
      [
        'package kafka.server',
        'class KafkaApis {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root, { maxFiles: 3 });
    const paths = index.files.map((file) => file.relativePath);

    expect(paths).toEqual(
      expect.arrayContaining([
        'core/src/main/scala/kafka/server/KafkaApis.scala',
      ]),
    );
    expect(index.files.some((file) => file.language === 'scala')).toBe(true);
  });

  it('allocates slots across modules in low-cap scenarios', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'clients/src/main/java/org/apache/kafka/clients/QuotaManager.java',
      [
        'package org.apache.kafka.clients;',
        'public class QuotaManager {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala/kafka/server/ReplicaManager.scala',
      [
        'package kafka.server',
        'class ReplicaManager {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/metadata/MetadataPublisher.java',
      [
        'package org.apache.kafka.metadata;',
        'public class MetadataPublisher {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root, { maxFiles: 3 });
    const topModules = new Set(index.files.map((file) => file.relativePath.split('/')[0]));

    expect([...topModules]).toEqual(
      expect.arrayContaining(['clients', 'core', 'metadata']),
    );
  });

  it('keeps key symbols discoverable in mixed-language repos with duplicated source folder names', () => {
    const root = createTempWorkspace();
    for (let index = 0; index < 12; index += 1) {
      writeFile(
        root,
        `clients/src/main/java 2/org/apache/kafka/clients/admin/AdminFile${String(index).padStart(2, '0')}.java`,
        [
          'package org.apache.kafka.clients.admin;',
          `public class AdminFile${String(index).padStart(2, '0')} {}`,
        ].join('\n'),
      );
    }
    writeFile(
      root,
      'core/src/main/scala 2/kafka 2/server/KafkaApis.scala',
      [
        'package kafka.server',
        'class KafkaApis {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala 2/kafka 2/server/ReplicaManager.scala',
      [
        'package kafka.server',
        'class ReplicaManager {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'metadata/src/main/java 2/org/apache/kafka/controller/QuorumController.java',
      [
        'package org.apache.kafka.controller;',
        'public class QuorumController {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root, { maxFiles: 7 });
    const paths = index.files.map((file) => file.relativePath);

    expect(paths).toEqual(
      expect.arrayContaining([
        'core/src/main/scala 2/kafka 2/server/KafkaApis.scala',
        'core/src/main/scala 2/kafka 2/server/ReplicaManager.scala',
        'metadata/src/main/java 2/org/apache/kafka/controller/QuorumController.java',
      ]),
    );
    expect(searchCodeSymbols(index, 'KafkaApis', { limit: 1 })[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/scala 2/kafka 2/server/KafkaApis.scala',
      }),
    );
    expect(searchCodeSymbols(index, 'ReplicaManager', { limit: 1 })[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/scala 2/kafka 2/server/ReplicaManager.scala',
      }),
    );
    expect(
      searchCodeSymbols(index, 'QuorumController', { limit: 1 })[0],
    ).toEqual(
      expect.objectContaining({
        relativePath:
          'metadata/src/main/java 2/org/apache/kafka/controller/QuorumController.java',
      }),
    );
  });

  it('extracts final Java classes as exact symbol hits', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java',
      [
        'package org.apache.kafka.controller;',
        'public final class QuorumController {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/controller/metrics/QuorumControllerMetrics.java',
      'public class QuorumControllerMetrics {}',
    );

    const index = buildCodeSearchIndex(root);
    const hits = searchCodeSymbols(index, 'QuorumController', { limit: 2 });

    expect(hits[0]).toEqual(
      expect.objectContaining({
        relativePath:
          'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java',
        symbol: expect.objectContaining({
          name: 'QuorumController',
          kind: 'class',
        }),
      }),
    );
  });

  it('symbol search prefers main definitions over benchmark duplicates', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/Service.java',
      [
        'package com.example;',
        'public class Service {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'benchmarks/src/main/java/com/example/Service.java',
      [
        'package com.example;',
        'public class Service {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hits = searchCodeSymbols(index, 'Service', { limit: 2 });

    expect(hits[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/java/com/example/Service.java',
        symbol: expect.objectContaining({
          name: 'Service',
          kind: 'class',
        }),
      }),
    );
  });

  it('reference hints rank core imports above test noise', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/MainService.java',
      [
        'package com.example;',
        'import com.example.MainConfig;',
        'public class MainService {',
        '  public MainConfig create() {',
        '    return new MainConfig();',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'tests/src/test/java/com/example/MainConfigTest.java',
      [
        'package com.example;',
        'import com.example.MainConfig;',
        'public class MainConfigTest {',
        '  public void shouldUseConfig() {',
        '    new MainConfig();',
        '  }',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'MainConfig', { limit: 2 });

    expect(hints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/java/com/example/MainService.java',
        matchedBy: 'constructor',
      }),
    );
  });

  it('demotes partial CamelCase imports below exact imports and usage', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/ControllerUsage.java',
      [
        'package com.example;',
        'public class ControllerUsage {',
        '  public void run() {',
        '    new QuorumController();',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/ExactImport.java',
      [
        'package com.example;',
        'import org.apache.kafka.controller.QuorumController;',
        'public class ExactImport {}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/MetricsImport.java',
      [
        'package com.example;',
        'import org.apache.kafka.controller.metrics.QuorumControllerMetrics;',
        'public class MetricsImport {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'QuorumController', { limit: 6 });

    expect(hints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/java/com/example/ControllerUsage.java',
        matchedBy: 'constructor',
      }),
    );
    expect(
      hints.findIndex((hint) => hint.relativePath.endsWith('ExactImport.java')),
    ).toBeGreaterThanOrEqual(0);
    expect(
      hints.findIndex((hint) => hint.relativePath.endsWith('MetricsImport.java')),
    ).toBeGreaterThanOrEqual(0);
    expect(
      hints.findIndex((hint) => hint.relativePath.endsWith('ExactImport.java')),
    ).toBeLessThan(
      hints.findIndex((hint) => hint.relativePath.endsWith('MetricsImport.java')),
    );
  });

  it('deduplicates repeated import hints on the same line', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/scala/kafka/server/ControllerServer.scala',
      [
        'package kafka.server',
        'import org.apache.kafka.controller.{Controller, QuorumController, QuorumFeatures}',
        'class ControllerServer',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'QuorumController', { limit: 4 });
    const exactImportHints = hints.filter(
      (hint) =>
        hint.relativePath === 'core/src/main/scala/kafka/server/ControllerServer.scala' &&
        hint.line === 2 &&
        hint.matchedBy === 'import',
    );

    expect(exactImportHints).toHaveLength(1);
  });

  it('prefers actionable usage lines before import-only matches', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/Service.java',
      [
        'package com.example;',
        'public class Service {',
        '  public void work() {}',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/ServiceClient.java',
      [
        'package com.example;',
        'public class ServiceClient {',
        '  public void run() {',
        '    new Service().work();',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'benchmarks/src/main/java/com/example/ServiceBenchmark.java',
      [
        'package com.example;',
        'import com.example.Service;',
        'public class ServiceBenchmark {',
        '  public void setup() {',
        '    // only imports Service',
        '  }',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'Service', { limit: 3 });

    expect(hints[0].relativePath).toBe(
      'core/src/main/java/com/example/ServiceClient.java',
    );
    expect(hints[0].matchedBy).toBe('constructor');
    expect(
      hints.some((hint) =>
        hint.relativePath.endsWith('ServiceBenchmark.java') &&
        hint.matchedBy === 'import',
      ),
    ).toBe(true);
  });

  it('reference hints demote comment-only matches', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/ServiceCaller.java',
      [
        'package com.example;',
        'public class ServiceCaller {',
        '  public void call() {',
        '    new Service().work();',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/Commented.java',
      [
        'package com.example;',
        '/**',
        ' * Reference: Service',
        ' */',
        'public class Commented {}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'Service', { limit: 8 });

    expect(hints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/java/com/example/ServiceCaller.java',
        matchedBy: 'constructor',
      }),
    );
    expect(
      hints.slice(0, 2).every(
        (hint) => hint.relativePath !== 'core/src/main/java/com/example/Commented.java',
      ),
    ).toBe(true);
  });

  it('does not treat string-literal mentions as constructor usage', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java',
      [
        'package org.apache.kafka.controller;',
        'public final class QuorumController {',
        '  void trace() {',
        '    log.info("Creating new QuorumController with clusterId {}", clusterId);',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/scala/kafka/server/ControllerServer.scala',
      [
        'class ControllerServer {',
        '  def build(): Unit = {',
        '    new QuorumController()',
        '  }',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'QuorumController', { limit: 4 });

    expect(hints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/scala/kafka/server/ControllerServer.scala',
        matchedBy: 'constructor',
      }),
    );
    expect(
      hints.find(
        (hint) =>
          hint.relativePath ===
            'metadata/src/main/java/org/apache/kafka/controller/QuorumController.java' &&
          hint.line === 4 &&
          hint.matchedBy === 'constructor',
      ),
    ).toBeUndefined();
  });

  it('keeps definition-file noise below cross-file usage with multiple matches', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/Service.java',
      [
        'package com.example;',
        'public class Service {',
        '  public static final Service INSTANCE = new Service();',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/Usage.java',
      [
        'package com.example;',
        'public class Usage {',
        '  public void call(Service service) {',
        '    service.work();',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/ServiceSupport.java',
      [
        'package com.example;',
        'public class ServiceSupport {',
        '  public void register() {',
        '    Service.INSTANCE.work();',
        '  }',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'Service', { limit: 4 });

    const topTwo = new Set(hints.slice(0, 2).map((hint) => hint.relativePath));
    expect(topTwo).toEqual(
      new Set([
        'core/src/main/java/com/example/Usage.java',
        'core/src/main/java/com/example/ServiceSupport.java',
      ]),
    );
    expect(
      hints.findIndex((hint) => hint.relativePath.endsWith('Service.java')),
    ).toBeGreaterThan(1);
  });

  it('static imports stay below constructor/invocation usage', () => {
    const root = createTempWorkspace();
    writeFile(
      root,
      'core/src/main/java/com/example/ServiceConstructor.java',
      [
        'package com.example;',
        'public class ServiceConstructor {',
        '  public Service newService() {',
        '    return new Service();',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFile(
      root,
      'core/src/main/java/com/example/StaticReferences.java',
      [
        'package com.example;',
        'import static com.example.Service.INSTANCE;',
        'public class StaticReferences {',
        '  public void describe() {',
        '    // reference to Service via static import only',
        '  }',
        '}',
      ].join('\n'),
    );

    const index = buildCodeSearchIndex(root);
    const hints = searchCodeReferenceHints(index, 'Service', { limit: 4 });

    expect(hints[0]).toEqual(
      expect.objectContaining({
        relativePath: 'core/src/main/java/com/example/ServiceConstructor.java',
        matchedBy: 'constructor',
      }),
    );
    expect(
      hints.findIndex(
        (hint) => hint.relativePath === 'core/src/main/java/com/example/StaticReferences.java',
      ),
    ).toBeGreaterThan(0);
    expect(
      hints.find((hint) => hint.relativePath.includes('StaticReferences')),
    ).toEqual(
      expect.objectContaining({
        matchedBy: 'static_import',
      }),
    );
  });
});
