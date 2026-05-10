import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname);
const FILES = [
  'channels/web.ts',
  'channels/feishu.ts',
  'channels/telegram.ts',
  'channels/discord.ts',
  'channels/slack.ts',
  'channels/gmail.ts',
  'channels/whatsapp.ts',
  'index.ts',
];

describe('assistant name async usage', () => {
  it('does not interpolate getAssistantName() without await in trigger or content strings', () => {
    const offenders = FILES.filter((relativePath) => {
      const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      return (
        source.includes('@${getAssistantName()}') ||
        source.includes('trigger: `@${getAssistantName()}`')
      );
    });

    expect(offenders).toEqual([]);
  });
});
