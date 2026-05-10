import { describe, expect, it } from 'vitest';

import {
  deriveTaskTitle,
  generateAiTaskDraft,
  normalizeTaskExecutionPrompt,
} from './task-draft.js';

describe('task-draft', () => {
  it('derives a stable title from prompt fallback', () => {
    expect(deriveTaskTitle('', '  每天 汇总   昨日进展  ')).toBe(
      '每天 汇总 昨日进展',
    );
    expect(deriveTaskTitle(undefined, undefined)).toBe('未命名任务');
  });

  it('normalizes quoted reminder prompts', () => {
    expect(
      normalizeTaskExecutionPrompt(
        '每天早上9点，通过飞书提醒我“交日报”',
        '每天早上9点，通过飞书提醒我“交日报”',
      ),
    ).toBe('提醒我：交日报');
  });

  it('builds task draft from AI json and strips schedule metadata from prompt', async () => {
    const draft = await generateAiTaskDraft(
      '每天凌晨0点57分，通过飞书给我发送“hello world！”',
      {
        generateText: async () =>
          JSON.stringify({
            title: '日报提醒',
            prompt: '每天凌晨0点57分，通过飞书给我发送“hello world！”',
            scheduleType: 'cron',
            scheduleValue: '57 0 * * *',
            contextMode: 'group',
            summary: '按用户请求创建',
          }),
      },
    );

    expect(draft).toEqual({
      title: '日报提醒',
      prompt: '给我发送“hello world！”',
      scheduleType: 'cron',
      scheduleValue: '57 0 * * *',
      contextMode: 'group',
      summary: '按用户请求创建',
    });
  });
});
