import crypto from 'crypto';

import type {
  ReviewRemoteProvider,
  ReviewRepositoryRecord,
} from '../db.js';
import { logger } from '../logger.js';
import type { RepoReviewEvent } from './repo-review-service.js';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeWebhookEventName(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function resolveGitLabWebhookKind(
  headers: Record<string, string | string[] | undefined>,
  payload: Record<string, unknown>,
): 'push' | 'merge_request' | '' {
  const headerEvent = normalizeWebhookEventName(headers['x-gitlab-event']);
  if (headerEvent === 'push hook') return 'push';
  if (headerEvent === 'merge request hook') return 'merge_request';

  const objectKind = normalizeWebhookEventName(payload.object_kind);
  if (objectKind === 'push') return 'push';
  if (objectKind === 'merge_request') return 'merge_request';
  return '';
}

function normalizeBranchName(value: string): string {
  return value.trim().replace(/^refs\/heads\//, '');
}

function shortSha(value: string): string {
  return value ? value.slice(0, 12) : '';
}

function trimMessageLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function firstLine(value: string): string {
  return trimMessageLine(value.split('\n')[0] || '');
}

export function verifyRepoReviewWebhook(input: {
  provider: ReviewRemoteProvider;
  repository: ReviewRepositoryRecord;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}): boolean {
  const secret = stringValue(input.repository.webhook_secret);
  if (!secret) {
    const requireSecret =
      (process.env.NANOCLAW_REQUIRE_WEBHOOK_SECRET || '').trim().toLowerCase() === 'true';
    if (requireSecret) return false;
    logger.warn(
      { provider: input.provider, repositoryId: input.repository.id },
      'Webhook accepted without secret — set webhook_secret for this repository or NANOCLAW_REQUIRE_WEBHOOK_SECRET=true to enforce',
    );
    return true;
  }
  const header = (name: string) => {
    const value = input.headers[name] || input.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] || '' : value || '';
  };
  if (input.provider === 'github') {
    const signature = header('x-hub-signature-256');
    if (!signature.startsWith('sha256=')) return false;
    const digest =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(input.rawBody).digest('hex');
    if (signature.length !== digest.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }
  if (input.provider === 'gitlab') {
    const token = header('x-gitlab-token');
    if (!token || token.length !== secret.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  }
  const signature = header('x-gitea-signature');
  if (!signature) return false;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(input.rawBody)
    .digest('hex');
  if (signature.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

function parseGitHubLikePushEvent(
  provider: 'github' | 'gitea',
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  const commits = Array.isArray(payload.commits)
    ? (payload.commits as Array<Record<string, unknown>>)
    : [];
  const commitDetails = commits
    .map((commit) => ({
      commit: shortSha(stringValue(commit.id)),
      title: firstLine(stringValue(commit.message)),
      author:
        stringValue(asRecord(commit.author).username) ||
        stringValue(asRecord(commit.author).name),
      message: stringValue(commit.message),
      url: stringValue(commit.url),
      timestamp: stringValue(commit.timestamp),
    }))
    .filter((entry) => entry.commit || entry.title);
  return {
    source: provider,
    stage: 'push',
    repositoryId,
    ref: stringValue(payload.ref),
    branch: normalizeBranchName(stringValue(payload.ref)),
    baseSha: stringValue(payload.before),
    headSha: stringValue(payload.after),
    actor:
      provider === 'github'
        ? stringValue(asRecord(payload.pusher).name) ||
          stringValue(asRecord(payload.sender).login)
        : stringValue(asRecord(payload.pusher).login),
    blockingExpected: false,
    callbackContext: {
      commitDetails,
      commitSummaryLines: commits
        .map((commit) => {
          const sha = shortSha(stringValue(commit.id));
          const message = firstLine(stringValue(commit.message));
          return trimMessageLine(`${sha} ${message}`);
        })
        .filter(Boolean)
        .slice(0, 20),
    },
  };
}

function parseGitHubPushEvent(
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  return parseGitHubLikePushEvent('github', repositoryId, payload);
}

function parseGiteaPushEvent(
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  return parseGitHubLikePushEvent('gitea', repositoryId, payload);
}

function parseGitHubPullRequestEvent(
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  const action = stringValue(payload.action);
  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    return null;
  }
  const pr = asRecord(payload.pull_request);
  const head = asRecord(pr.head);
  const base = asRecord(pr.base);
  const headRepo = asRecord(head.repo);
  return {
    source: 'github',
    stage: 'push',
    repositoryId,
    ref: stringValue(head.ref),
    branch: stringValue(head.ref),
    baseSha: stringValue(base.sha),
    headSha: stringValue(head.sha),
    prMrNumber: stringValue(payload.number),
    actor: stringValue(asRecord(payload.sender).login),
    blockingExpected: false,
    callbackContext: {
      event: 'pull_request',
      action,
      title: stringValue(pr.title),
      commitDetails: [
        {
          commit: shortSha(stringValue(head.sha)),
          title: stringValue(pr.title) || 'Pull Request',
          author:
            stringValue(asRecord(payload.sender).login) ||
            stringValue(asRecord(pr.user).login),
          message: stringValue(pr.body),
          url: stringValue(pr.html_url || headRepo.html_url),
          timestamp: stringValue(pr.updated_at || pr.created_at),
        },
      ].filter((entry) => entry.commit || entry.title),
      commitSummaryLines: [
        trimMessageLine(
          `PR #${stringValue(payload.number)} ${stringValue(pr.title)}`,
        ),
      ].filter(Boolean),
    },
  };
}

function parseGiteaPullRequestEvent(
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  const action = stringValue(payload.action);
  if (!['opened', 'synchronized', 'reopened'].includes(action)) {
    return null;
  }
  const pr = asRecord(payload.pull_request);
  const head = asRecord(pr.head);
  const base = asRecord(pr.base);
  return {
    source: 'gitea',
    stage: 'push',
    repositoryId,
    ref: stringValue(head.ref),
    branch: stringValue(head.ref),
    baseSha: stringValue(base.sha),
    headSha: stringValue(head.sha),
    prMrNumber: stringValue(pr.number || payload.number),
    actor: stringValue(asRecord(payload.sender).login),
    blockingExpected: false,
    callbackContext: {
      action,
      title: stringValue(pr.title),
      commitDetails: [
        {
          commit: shortSha(stringValue(head.sha)),
          title: stringValue(pr.title) || 'Pull Request',
          author:
            stringValue(asRecord(payload.sender).login) ||
            stringValue(asRecord(pr.user).login),
          message: stringValue(pr.body),
          url: stringValue(pr.html_url),
          timestamp: stringValue(pr.updated_at || pr.created_at),
        },
      ].filter((entry) => entry.commit || entry.title),
      commitSummaryLines: [
        trimMessageLine(
          `PR #${stringValue(pr.number || payload.number)} ${stringValue(pr.title)}`,
        ),
      ].filter(Boolean),
    },
  };
}

function parseGitLabPushEvent(
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  const commits = Array.isArray(payload.commits)
    ? (payload.commits as Array<Record<string, unknown>>)
    : [];
  const commitDetails = commits
    .map((commit) => ({
      commit: shortSha(stringValue(commit.id)),
      title: firstLine(stringValue(commit.title || commit.message)),
      author:
        stringValue(asRecord(commit.author).name) ||
        stringValue(commit.author_name || payload.user_name),
      message: stringValue(commit.message),
      url: stringValue(commit.url),
      timestamp: stringValue(commit.timestamp),
    }))
    .filter((entry) => entry.commit || entry.title);
  return {
    source: 'gitlab',
    stage: 'push',
    repositoryId,
    ref: stringValue(payload.ref),
    branch: normalizeBranchName(stringValue(payload.ref)),
    baseSha: stringValue(payload.before),
    headSha: stringValue(payload.after),
    actor: stringValue(payload.user_username || payload.user_name),
    blockingExpected: false,
    callbackContext: {
      commitDetails,
      commitSummaryLines: commits
        .map((commit) => {
          const sha = shortSha(stringValue(commit.id));
          const title = firstLine(stringValue(commit.title || commit.message));
          return trimMessageLine(`${sha} ${title}`);
        })
        .filter(Boolean)
        .slice(0, 20),
    },
  };
}

function parseGitLabMergeRequestEvent(
  repositoryId: string,
  payload: Record<string, unknown>,
): RepoReviewEvent | null {
  const attrs = asRecord(payload.object_attributes);
  const action = stringValue(attrs.action);
  if (!['open', 'reopen', 'update'].includes(action)) {
    return null;
  }
  const diffRefs = asRecord(attrs.diff_refs);
  const lastCommit = asRecord(attrs.last_commit);
  return {
    source: 'gitlab',
    stage: 'push',
    repositoryId,
    ref: stringValue(attrs.source_branch),
    branch: stringValue(attrs.source_branch),
    baseSha: stringValue(diffRefs.base_sha),
    headSha: stringValue(diffRefs.head_sha) || stringValue(lastCommit.id),
    prMrNumber: stringValue(attrs.iid),
    actor: stringValue(payload.user_username || payload.user_name),
    blockingExpected: false,
    callbackContext: {
      action,
      title: stringValue(attrs.title),
      commitDetails: [
        {
          commit: shortSha(stringValue(lastCommit.id)),
          title: stringValue(attrs.title) || 'Merge Request',
          author:
            stringValue(payload.user_username || payload.user_name) ||
            stringValue(asRecord(lastCommit.author).name),
          message: stringValue(lastCommit.message || attrs.description),
          url: stringValue(attrs.url),
          timestamp: stringValue(lastCommit.timestamp || attrs.updated_at),
        },
      ].filter((entry) => entry.commit || entry.title),
      commitSummaryLines: [
        trimMessageLine(`MR #${stringValue(attrs.iid)} ${stringValue(attrs.title)}`),
      ].filter(Boolean),
    },
  };
}

export function parseRepoReviewWebhookEvent(input: {
  provider: ReviewRemoteProvider;
  repositoryId: string;
  headers: Record<string, string | string[] | undefined>;
  payload: Record<string, unknown>;
}): RepoReviewEvent | null {
  const eventName =
    input.provider === 'github'
      ? normalizeWebhookEventName(input.headers['x-github-event'])
      : input.provider === 'gitlab'
        ? normalizeWebhookEventName(input.headers['x-gitlab-event'])
        : normalizeWebhookEventName(input.headers['x-gitea-event']);
  if (input.provider === 'github') {
    if (eventName === 'push') {
      return parseGitHubPushEvent(input.repositoryId, input.payload);
    }
    if (eventName === 'pull_request') {
      return parseGitHubPullRequestEvent(input.repositoryId, input.payload);
    }
    return null;
  }
  if (input.provider === 'gitlab') {
    const kind = resolveGitLabWebhookKind(input.headers, input.payload);
    if (kind === 'push') {
      return parseGitLabPushEvent(input.repositoryId, input.payload);
    }
    if (kind === 'merge_request') {
      return parseGitLabMergeRequestEvent(input.repositoryId, input.payload);
    }
    return null;
  }
  if (eventName === 'push') {
    return parseGiteaPushEvent(input.repositoryId, input.payload);
  }
  if (eventName === 'pull_request') {
    return parseGiteaPullRequestEvent(input.repositoryId, input.payload);
  }
  return null;
}
