import fs from 'fs';
import path from 'path';

export interface AskUserRequestPayload {
  id: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
  allow_multiple?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AskUserResolvedPayload {
  id: string;
  answer: string;
  answered_by: string;
  resolvedAt: string;
}

interface AskUserResponseFile {
  answer?: string;
  answered_by?: string;
  resolvedAt?: string;
}

type AskUserEmitter = {
  emitAskRequest?: (payload: AskUserRequestPayload) => void;
  emitAskResolved?: (payload: AskUserResolvedPayload) => void;
};

const IPC_BASE_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const IPC_QUESTIONS_DIR = path.join(IPC_BASE_DIR, 'questions');
const IPC_QUESTION_REQUESTS_DIR = path.join(IPC_QUESTIONS_DIR, 'requests');
const IPC_QUESTION_RESPONSES_DIR = path.join(IPC_QUESTIONS_DIR, 'responses');
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_MS = 500;

let askEmitter: AskUserEmitter = {};

function ensureQuestionDirs(): void {
  fs.mkdirSync(IPC_QUESTION_REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(IPC_QUESTION_RESPONSES_DIR, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function setAskUserEventEmitter(emitter: AskUserEmitter | null | undefined): void {
  askEmitter = emitter || {};
}

export async function askUser(input: {
  question: string;
  options?: Array<{ id: string; label: string }>;
  allow_multiple?: boolean;
  timeout_seconds?: number;
}): Promise<string> {
  ensureQuestionDirs();

  const now = Date.now();
  const timeoutMs = (input.timeout_seconds ?? 300) * 1000;
  const clampedTimeout = Math.min(Math.max(timeoutMs, 10_000), DEFAULT_TIMEOUT_MS);

  const request: AskUserRequestPayload = {
    id: `ask_${now}_${Math.random().toString(36).slice(2, 8)}`,
    question: input.question,
    options: input.options,
    allow_multiple: input.allow_multiple,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + clampedTimeout).toISOString(),
  };

  const requestPath = path.join(IPC_QUESTION_REQUESTS_DIR, `${request.id}.json`);
  const tmpPath = requestPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(request));
  fs.renameSync(tmpPath, requestPath);
  askEmitter.emitAskRequest?.(request);

  const expiresAtMs = now + clampedTimeout;
  while (Date.now() < expiresAtMs) {
    const responsePath = path.join(IPC_QUESTION_RESPONSES_DIR, `${request.id}.json`);
    if (fs.existsSync(responsePath)) {
      try {
        const raw = fs.readFileSync(responsePath, 'utf-8');
        const response = JSON.parse(raw) as AskUserResponseFile;
        const answer = typeof response.answer === 'string' ? response.answer : '';

        askEmitter.emitAskResolved?.({
          id: request.id,
          answer,
          answered_by: response.answered_by || 'user',
          resolvedAt: response.resolvedAt || new Date().toISOString(),
        });
        return answer || '(用户未输入内容)';
      } catch {
        askEmitter.emitAskResolved?.({
          id: request.id,
          answer: '',
          answered_by: 'system',
          resolvedAt: new Date().toISOString(),
        });
        return '(读取用户回答失败)';
      }
    }
    await sleep(POLL_MS);
  }

  askEmitter.emitAskResolved?.({
    id: request.id,
    answer: '',
    answered_by: 'system',
    resolvedAt: new Date().toISOString(),
  });
  return '(用户未在规定时间内回答)';
}
