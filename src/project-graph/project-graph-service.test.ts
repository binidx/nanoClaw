import { describe, expect, it } from 'vitest';

import {
  extractDatabaseTableCandidates,
  extractServiceDependencyCandidates,
  getProjectGraphConfigFromRepository,
  normalizeProjectGraphConfig,
} from './project-graph-service.js';
import type { RepositoryInfo } from '../repo-review/repository-service.js';

function makeRepository(
  featureConfig?: Record<string, unknown>,
  enabled = true,
): RepositoryInfo {
  return {
    id: 'repo-1',
    name: 'billing-service',
    language: 'Java',
    localRepoPath: '/repo',
    remoteProvider: 'gitlab',
    remoteRepoSlug: 'payments/billing-service',
    remoteBaseUrl: 'https://gitlab.example.com',
    cloneUrl: 'https://gitlab.example.com/payments/billing-service.git',
    defaultTargetBranch: 'main',
    sshKeyId: null,
    autoSyncEnabled: false,
    autoSyncIntervalMinutes: 30,
    lastAutoSyncAt: null,
    lastAutoSyncStatus: null,
    enabled: true,
    status: 'active',
    visibility: null,
    aiDescription: null,
    techStack: ['Spring'],
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    features: featureConfig
      ? [
          {
            featureType: 'project_graph',
            enabled,
            config: featureConfig,
          },
        ]
      : [],
  };
}

describe('project graph service config', () => {
  it('normalizes scanner and binding arrays from unknown input', () => {
    const config = normalizeProjectGraphConfig({
      enabled: false,
      scanners: ['overview', '', 'database_usage'],
      skillIds: ['java-dubbo', null, ''],
      serviceNames: {
        production: 'billing-prod',
        testing: 'billing-test',
        nacosKeys: ['billing.yaml', ''],
        logServiceNames: ['billing-service'],
      },
      owners: ['alice', ''],
      businessDomain: 'payments',
    });

    expect(config.enabled).toBe(false);
    expect(config.scanners).toEqual(['overview', 'database_usage']);
    expect(config.skillIds).toEqual(['java-dubbo']);
    expect(config.serviceNames).toEqual({
      production: 'billing-prod',
      testing: 'billing-test',
      nacosKeys: ['billing.yaml'],
      logServiceNames: ['billing-service'],
    });
    expect(config.owners).toEqual(['alice']);
    expect(config.businessDomain).toBe('payments');
  });

  it('reads project graph config from repository feature state', () => {
    const config = getProjectGraphConfigFromRepository(
      makeRepository(
        {
          scanners: ['overview'],
          owners: ['team-platform'],
          serviceNames: { production: 'billing-prod' },
        },
        false,
      ),
    );

    expect(config.enabled).toBe(false);
    expect(config.scanners).toEqual(['overview']);
    expect(config.owners).toEqual(['team-platform']);
    expect(config.serviceNames.production).toBe('billing-prod');
  });
});

describe('project graph code scanners', () => {
  it('extracts service dependency candidates from Feign, Dubbo, and HTTP snippets', () => {
    const candidates = extractServiceDependencyCandidates([
      {
        id: 'chunk-1',
        filePath: 'src/main/java/demo/BillingClient.java',
        chunkIndex: 0,
        startLine: 10,
        endLine: 30,
        content: `
          @FeignClient(name = "order-service")
          interface OrderClient {}
          @DubboReference(interfaceName = "com.demo.InventoryService")
          private InventoryService inventoryService;
        `,
        tokenCount: 30,
        summary: 'service clients',
        contentHash: 'a',
        summarySource: 'fallback',
      },
      {
        id: 'chunk-2',
        filePath: 'web/src/api.ts',
        chunkIndex: 0,
        startLine: 1,
        endLine: 20,
        content: `axios.get("https://risk.example.com/api/check")`,
        tokenCount: 10,
        summary: 'http client',
        contentHash: 'b',
        summarySource: 'fallback',
      },
    ]);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'order-service', relation: 'calls' }),
        expect.objectContaining({
          name: 'com.demo.InventoryService',
          relation: 'calls',
        }),
        expect.objectContaining({
          name: 'risk.example.com',
          relation: 'calls',
        }),
      ]),
    );
  });

  it('extracts database table candidates from SQL and table annotations', () => {
    const candidates = extractDatabaseTableCandidates([
      {
        id: 'chunk-1',
        filePath: 'src/main/java/demo/OrderMapper.java',
        chunkIndex: 0,
        startLine: 5,
        endLine: 40,
        content: `
          @TableName("billing_order")
          class BillingOrder {}
          SELECT * FROM billing_order JOIN user_account ON user_account.id = billing_order.user_id
          UPDATE billing_order SET status = ?
          INSERT INTO billing_event(id) VALUES (?)
        `,
        tokenCount: 60,
        summary: 'mapper sql',
        contentHash: 'c',
        summarySource: 'fallback',
      },
    ]);

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'billing_order',
          relation: 'owns_table',
        }),
        expect.objectContaining({
          name: 'billing_order',
          relation: 'reads_table',
        }),
        expect.objectContaining({
          name: 'billing_order',
          relation: 'writes_table',
        }),
        expect.objectContaining({
          name: 'billing_event',
          relation: 'writes_table',
        }),
      ]),
    );
  });
});
