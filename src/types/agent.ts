import type { AccessPolicy } from '../auth/access-policy.js';
import type { AdditionalMount } from './mount.js';

import type { PromptSegment } from './prompt.js';

export interface AgentConfig {
  additionalMounts?: AdditionalMount[];
  accessPolicy?: AccessPolicy;
  allowedDirectories?: string[];
  strictAllowedDirectories?: boolean;
  projectRoot?: string;
  workingDirectory?: string;
  timeout?: number; // Default: 300000 (5 minutes)
  customInstructions?: string;
  reviewRepositoryIds?: string[];
}

export interface AgentUploadedFile {
  name: string;
  mimeType: string;
  size: number;
  relativePath: string;
}

export interface AgentPromptInput {
  text: string;
  uploadedFiles?: AgentUploadedFile[];
  stableSystemPrompt?: string;
  volatileSystemPrompt?: string;
  userPrompt?: string;
  contextBlocks?: PromptSegment[];
  stablePrefixFingerprint?: string;
  cacheFingerprint?: string;
  historyBridgeNotice?: string;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  assistantId?: string | null;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  providerId?: string | null;
  model?: string | null;
}

export interface ScheduledTask {
  id: string;
  title?: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  retry_limit?: number;
  retry_backoff_ms?: number;
  failure_mode?: 'continue' | 'pause';
  consecutive_failures?: number;
  last_error?: string | null;
  runtime_claimed_at?: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  /** Present on DB rows; used for tenant context when running scheduled tasks. */
  created_by?: string | null;
  updated_by?: string | null;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}
