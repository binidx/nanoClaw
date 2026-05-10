import { describe, expect, it } from 'vitest';

import { buildScheduledTaskPrompt } from './scheduled-task-prompt.js';

describe('scheduled task prompt', () => {
  it('frames scheduled runs as direct execution instead of task creation', () => {
    const prompt = buildScheduledTaskPrompt({
      text: '提醒我吃饭',
    });

    expect(prompt.text).toContain('Execute the instruction below now.');
    expect(prompt.text).toContain(
      'not as a request to create or configure a task',
    );
    expect(prompt.text).toContain('Do not mention scheduling, automation');
    expect(prompt.text).toContain('Reply only with the actual reminder');
    expect(prompt.text).toContain('提醒我吃饭');
    expect(prompt.text.toLowerCase()).not.toContain('scheduled task');
  });

  it('preserves uploaded files while wrapping the prompt', () => {
    const prompt = buildScheduledTaskPrompt({
      text: '总结附件内容',
      uploadedFiles: [
        {
          name: 'report.md',
          mimeType: 'text/markdown',
          size: 128,
          relativePath: 'uploads/report.md',
        },
      ],
    });

    expect(prompt.uploadedFiles).toEqual([
      {
        name: 'report.md',
        mimeType: 'text/markdown',
        size: 128,
        relativePath: 'uploads/report.md',
      },
    ]);
    expect(prompt.text).toContain('总结附件内容');
  });

  it('exports a stable dispatch prefix marker other callers can detect', () => {
    const prompt = buildScheduledTaskPrompt({ text: 'x' });
    // This marker is what repo-review opts out of via
    // suppressScheduledTaskPreamble — guard the contract.
    expect(prompt.text.startsWith('[SYSTEM DISPATCH]')).toBe(true);
  });
});
