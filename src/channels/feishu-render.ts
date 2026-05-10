import type { OutboundMention } from '../types.js';
import { t } from '../i18n/index.js';

export type FeishuRenderMode = 'auto' | 'text' | 'card';

export function resolveFeishuRenderMode(
  value: string | undefined,
): FeishuRenderMode {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'text' || normalized === 'card') {
    return normalized;
  }
  return 'auto';
}

export function shouldUseFeishuCard(text: string): boolean {
  if (!text) return false;
  return (
    /```[\s\S]*?```/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /__[^_]+__/.test(text) ||
    /\[[^\]]+\]\([^\)]+\)/.test(text) ||
    /^\s{0,3}[-*+]\s+/m.test(text) ||
    /^\s{0,3}\d+\.\s+/m.test(text) ||
    /^#{1,6}\s+/m.test(text) ||
    /^\|.+\|$/m.test(text)
  );
}

export function buildFeishuMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

export function buildFeishuPostMessagePayload(text: string): {
  msgType: 'post';
  content: string;
} {
  return {
    msgType: 'post',
    content: JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: 'md',
              text,
            },
          ],
        ],
      },
    }),
  };
}

export function buildFeishuMentionPostMessagePayload(
  text: string,
  mentions: OutboundMention[],
): {
  msgType: 'post';
  content: string;
} {
  const normalizedMentions = mentions.filter(
    (mention) => mention.channel === 'feishu' && mention.id.trim(),
  );
  const rows: Array<Array<Record<string, unknown>>> = [];
  if (normalizedMentions.length > 0) {
    const header: Array<Record<string, unknown>> = [];
    normalizedMentions.forEach((mention, index) => {
      if (index > 0) {
        header.push({ tag: 'text', text: ' ' });
      }
      header.push({
        tag: 'at',
        user_id: mention.id.trim(),
        user_name: mention.name?.trim() || mention.id.trim(),
      });
    });
    header.push({ tag: 'text', text: t('channels.auto_10a7b1', {}, undefined) });
    rows.push(header);
  }
  if (text) {
    for (const line of text.split('\n')) {
      rows.push([{ tag: 'text', text: line || ' ' }]);
    }
  }
  return {
    msgType: 'post',
    content: JSON.stringify({
      zh_cn: {
        content: rows.length > 0 ? rows : [[{ tag: 'text', text }]],
      },
    }),
  };
}

export function chunkFeishuText(text: string, limit: number): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

export function resolveFeishuReplyInThread(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'on';
}
