import { normalizeScheduleValue } from './task-schedule.js';
import { generateTextWithDefaultProvider } from '../provider/provider-api.js';
import { t } from '../i18n/index.js';

export interface AiTaskDraftResult {
  title: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  contextMode: 'group' | 'isolated';
  summary: string;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI did not return JSON');
  }
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

export function deriveTaskTitle(title: unknown, prompt: unknown): string {
  const preferred = typeof title === 'string' ? title.trim() : '';
  if (preferred) return preferred.slice(0, 80);
  const promptText = typeof prompt === 'string' ? prompt.trim() : '';
  if (!promptText) return t('tasks.unnamedTask', {}, undefined);
  return promptText.replace(/\s+/g, ' ').slice(0, 80);
}

export function normalizeTaskExecutionPrompt(
  request: string,
  prompt: unknown,
): string {
  const preferred = typeof prompt === 'string' ? prompt.trim() : '';
  const source = preferred || request.trim();
  if (!source) return '';

  const quotedMatch = source.match(
    /(?:发送|发给我|给我发|提醒我|通知我|告诉我)[^“”"']{0,20}[“"']([^”"']+)[”"']/,
  );
  if (quotedMatch?.[1]?.trim()) {
    const content = quotedMatch[1].trim();
    if (/提醒我/.test(source)) return t('errors.remindMe', { content }, undefined);
    if (/通知我/.test(source)) return t('errors.notifyMe', { content }, undefined);
    if (/告诉我/.test(source)) return t('errors.tellMe', { content }, undefined);
    return t('errors.sendMe', { content }, undefined);
  }

  const normalized = source
    .replace(
      /^(每天|每日|每晚|每早|每晨|每周|每月|每隔|工作日|周末|今天|明天|今晚|明早|凌晨|早上|上午|中午|下午|晚上)[^，。,；;]*[，。,；;]\s*/u,
      '',
    )
    .replace(
      /^(通过|用)(飞书|Feishu|Lark|Telegram|telegraph|web|网页|浏览器)[^，。,；;]*[，。,；;]\s*/u,
      '',
    )
    .replace(/^(在)?[^，。,；;]*(发送给我|发给我|提醒我|通知我|告诉我)/u, '$2')
    .trim();

  if (normalized && normalized !== source) return normalized;
  return source;
}

export async function generateAiTaskDraft(
  request: string,
  deps: {
    generateText?: (prompt: string) => Promise<string>;
  } = {},
): Promise<AiTaskDraftResult> {
  const normalizedRequest = request.trim();
  if (!normalizedRequest) {
    throw new Error('request is required');
  }

  const prompt = [
    'You are a task scheduler assistant.',
    'Convert the user request into JSON only with keys: title, prompt, scheduleType, scheduleValue, contextMode, summary.',
    'title must be a short Chinese task name, ideally 4 to 12 characters, and should summarize the task clearly.',
    'prompt must describe only what the task should do when it runs.',
    'prompt must NOT repeat schedule, time, frequency, channel, or task-creation metadata.',
    t('errors.auto_5962ad', {}, undefined),
    'scheduleType must be one of: cron, interval, once.',
    'scheduleValue rules:',
    '- cron: standard 5-field cron like 0 9 * * *',
    '- interval: positive integer milliseconds',
    '- once: local time without timezone suffix, format YYYY-MM-DDTHH:mm:ss',
    'contextMode must be group or isolated.',
    'If the request is ambiguous, choose the safest reasonable interpretation and explain it in summary.',
    `User request: ${normalizedRequest}`,
  ].join('\n');
  const raw = await (deps.generateText || generateTextWithDefaultProvider)(
    prompt,
  );
  const parsed = extractJsonObject(raw);
  const scheduleType = parsed.scheduleType as 'cron' | 'interval' | 'once';
  const scheduleValue = normalizeScheduleValue(
    scheduleType,
    String(parsed.scheduleValue || ''),
  );
  const normalizedPrompt = normalizeTaskExecutionPrompt(
    normalizedRequest,
    parsed.prompt,
  );
  return {
    title: deriveTaskTitle(parsed.title, normalizedPrompt),
    prompt: normalizedPrompt,
    scheduleType,
    scheduleValue,
    contextMode: parsed.contextMode === 'isolated' ? 'isolated' : 'group',
    summary: String(parsed.summary || '').trim(),
  };
}
