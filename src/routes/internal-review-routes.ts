import type { Express, RequestHandler } from 'express';

import {
  getReviewRunById,
  getReviewRepositoryById,
  listReviewRunsForQuery,
  parseReviewRunRecord,
  type ReviewRunFindingSummary,
} from '../db/review.js';
import { acquireWorktree, listWorktrees } from '../agent/worktree-manager.js';
import { logger } from '../logger.js';

interface InternalReviewRouteOptions {
  requireInternalApi: RequestHandler;
}

interface FindingCount {
  high: number;
  medium: number;
  low: number;
}

interface FindingSummaryItem {
  severity: string;
  title: string;
  file?: string;
}

function computeFindingSummary(findingsJson: string): {
  counts: FindingCount;
  topFindings: FindingSummaryItem[];
} {
  let findings: Array<{ severity?: string; title?: string; file?: string }>;
  try {
    findings = JSON.parse(findingsJson || '[]');
  } catch {
    findings = [];
  }
  if (!Array.isArray(findings)) findings = [];

  const counts: FindingCount = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const sev = String(f.severity || 'low');
    if (sev === 'high') counts.high++;
    else if (sev === 'medium') counts.medium++;
    else counts.low++;
  }

  const sorted = [...findings].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
    return (order[String(a.severity)] ?? 2) - (order[String(b.severity)] ?? 2);
  });

  const topFindings: FindingSummaryItem[] = sorted.slice(0, 5).map((f) => ({
    severity: String(f.severity || 'low'),
    title: String(f.title || ''),
    ...(f.file ? { file: String(f.file) } : {}),
  }));

  return { counts, topFindings };
}

async function resolveWorktreeStatus(
  repositoryId: string,
  branch: string | null,
): Promise<{ worktreePath: string | null; worktreeStatus: 'active' | 'none' }> {
  if (!branch) return { worktreePath: null, worktreeStatus: 'none' };
  try {
    const worktrees = await listWorktrees(repositoryId);
    const match = worktrees.find((w) => w.branch === branch);
    if (match) return { worktreePath: match.workDirectory, worktreeStatus: 'active' };
  } catch (err) {
    logger.warn({ err, repositoryId, branch }, 'resolveWorktreeStatus failed');
  }
  return { worktreePath: null, worktreeStatus: 'none' };
}

async function resolveRepositoryName(
  repositoryId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(repositoryId);
  if (cached !== undefined) return cached;
  try {
    const repo = await getReviewRepositoryById(repositoryId);
    const name = repo?.name || repositoryId;
    cache.set(repositoryId, name);
    return name;
  } catch {
    cache.set(repositoryId, repositoryId);
    return repositoryId;
  }
}

export function registerInternalReviewRoutes(
  app: Express,
  options: InternalReviewRouteOptions,
): void {
  app.post(
    '/internal/review/query',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const repositoryIds = Array.isArray(body?.repositoryIds)
          ? (body.repositoryIds as string[]).map(String).filter(Boolean)
          : undefined;
        const branch = String(body?.branch || '').trim() || undefined;
        const severityFilter = String(body?.severity || '').trim() || undefined;
        const limit = Number(body?.limit) || 10;

        const rows: ReviewRunFindingSummary[] = await listReviewRunsForQuery({
          repositoryIds,
          branch,
          limit: Math.min(limit * 2, 50),
        });

        const repoNameCache = new Map<string, string>();
        const results: unknown[] = [];

        for (const row of rows) {
          const { counts, topFindings } = computeFindingSummary(
            row.findings_json,
          );
          if (
            severityFilter &&
            counts[severityFilter as keyof FindingCount] === 0
          ) {
            continue;
          }

          const repoName = await resolveRepositoryName(
            row.repository_id,
            repoNameCache,
          );
          const wt = await resolveWorktreeStatus(row.repository_id, row.branch);
          results.push({
            runId: row.id,
            repositoryId: row.repository_id,
            repositoryName: repoName,
            branch: row.branch,
            overall: row.overall || row.status,
            completedAt: row.completed_at,
            findingCounts: counts,
            topFindings,
            ...wt,
          });

          if (results.length >= limit) break;
        }

        res.json({ results });
      } catch (err) {
        logger.error({ err }, 'Internal review query failed');
        res.status(500).json({ error: 'Internal review query failed' });
      }
    },
  );

  app.post(
    '/internal/review/detail',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const runId = String(body?.runId || '').trim();
        if (!runId) {
          res.status(400).json({ error: 'runId is required' });
          return;
        }
        const allowedRepoIds = Array.isArray(body?.repositoryIds)
          ? (body.repositoryIds as string[]).map(String).filter(Boolean)
          : [];

        const record = await getReviewRunById(runId);
        if (!record) {
          res.status(404).json({ error: 'Review run not found' });
          return;
        }

        if (
          allowedRepoIds.length > 0 &&
          !allowedRepoIds.includes(record.repository_id)
        ) {
          res.status(403).json({ error: 'Review run does not belong to the bound repositories' });
          return;
        }

        const parsed = await parseReviewRunRecord(record);
        const findings = (parsed.findings || []) as Array<{
          severity?: string;
          title?: string;
          file?: string;
          detail?: string;
          suggestion?: string;
        }>;

        const grouped: Record<string, unknown[]> = {
          high: [],
          medium: [],
          low: [],
        };
        for (const f of findings) {
          const sev = String(f.severity || 'low');
          const bucket = grouped[sev] || grouped.low!;
          bucket.push({
            title: f.title || '',
            file: f.file || undefined,
            detail: f.detail || '',
            suggestion: f.suggestion || undefined,
          });
        }

        const repo = await getReviewRepositoryById(record.repository_id);
        const wt = await resolveWorktreeStatus(record.repository_id, record.branch);

        res.json({
          runId: record.id,
          repositoryId: record.repository_id,
          repositoryName: repo?.name || record.repository_id,
          branch: record.branch,
          overall: record.overall || record.status,
          summary: record.summary || '',
          completedAt: record.completed_at,
          findingCounts: {
            high: grouped.high!.length,
            medium: grouped.medium!.length,
            low: grouped.low!.length,
          },
          findings: grouped,
          ...wt,
        });
      } catch (err) {
        logger.error({ err }, 'Internal review detail failed');
        res.status(500).json({ error: 'Internal review detail failed' });
      }
    },
  );

  app.post(
    '/internal/worktree/acquire',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const repositoryId = String(body?.repositoryId || '').trim();
        const branch = String(body?.branch || '').trim();
        if (!repositoryId || !branch) {
          res.status(400).json({ error: 'repositoryId and branch are required' });
          return;
        }
        const wt = await acquireWorktree({ repositoryId, branch });
        res.json(wt);
      } catch (err) {
        logger.error({ err }, 'Internal worktree acquire failed');
        res.status(500).json({ error: 'Internal worktree acquire failed' });
      }
    },
  );

  app.get(
    '/internal/worktree/list',
    options.requireInternalApi,
    async (req, res) => {
      try {
        const repositoryId = String(req.query.repositoryId || '').trim();
        if (!repositoryId) {
          res.status(400).json({ error: 'repositoryId query param is required' });
          return;
        }
        const worktrees = await listWorktrees(repositoryId);
        res.json({ worktrees });
      } catch (err) {
        logger.error({ err }, 'Internal worktree list failed');
        res.status(500).json({ error: 'Internal worktree list failed' });
      }
    },
  );
}
