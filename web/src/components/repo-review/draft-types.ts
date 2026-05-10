import type { RepoReviewProfile, RepoReviewRepository } from '../../app-types';

export type ActorMentionDraftRow = {
  key: string;
  actor: string;
  memberId: string;
};

export type ActorMentionParseIssue = {
  level: 'error' | 'warning';
  line: number;
  message: string;
};

export type ReviewIdentityCandidate = {
  actor: string;
  sources: string[];
  mappedMemberName: string;
};

export type RepositoryDraft = {
  id?: string;
  name: string;
  language: string;
  localRepoPath: string;
  remoteProvider: RepoReviewRepository['remoteProvider'];
  remoteRepoSlug: string;
  remoteBaseUrl: string;
  cloneUrl: string;
  defaultTargetBranch: string;
  reviewChatJid: string;
  webhookSecret: string;
  platformToken: string;
  actorMentionDraftRows: ActorMentionDraftRow[];
  actorMentionMappingsText: string;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  digestDailyEnabled: boolean;
  digestWeeklyEnabled: boolean;
  digestDailyHour: number;
  digestWeeklyDay: number;
  digestWeeklyHour: number;
  enabled: boolean;
  allowAiFix: boolean;
  sshKeyId: string;
};

export type ProfileDraft = {
  id?: string;
  repositoryId: string;
  name: string;
  stage: RepoReviewProfile['stage'];
  sourceMode: RepoReviewProfile['sourceMode'];
  blockingMode: RepoReviewProfile['blockingMode'];
  passDecisionMode: RepoReviewProfile['passDecisionMode'];
  reviewScope: RepoReviewProfile['reviewScope'];
  targetBranches: string[];
  skillIds: string[];
  promptTemplate: string;
  includeGlobsText: string;
  excludeGlobsText: string;
  includeFullFileContext: boolean;
  maxFiles: number;
  maxDiffBytes: number;
  writeToChat: boolean;
  writeToPlatform: boolean;
  reviewOutputMode: 'message' | 'share_link';
  diffSubagentThreshold: number;
  enabled: boolean;
};
