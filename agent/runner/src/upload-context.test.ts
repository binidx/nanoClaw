import { describe, expect, it } from 'vitest';

import {
  buildUploadSystemPromptAppend,
  extractUploadContext,
  getUploadAwareUserPrompt,
} from './upload-context.js';

describe('upload-context helpers', () => {
  it('extracts uploaded files and removes internal context from the prompt', () => {
    const prompt = [
      '<messages>',
      '<message sender="Web User" time="2026-03-11T10:00:00.000Z">@Andy 请帮我总结</message>',
      '</messages>',
      '',
      '<uploaded_file_context source_message_id="msg-1">',
      '用户附带了以下上传文件。请先基于这些路径读取内容，再进行分析：',
      '文件 1: report.txt',
      '- 路径: /workspace/uploads/chat_abc/report.txt',
      '- 类型: text/plain',
      '- 大小: 3KB',
      '- 文本预览:',
      '```text',
      'hello world',
      '```',
      '- 预览已截断，请按路径读取完整文件。',
      '',
      '后端已直接调用模型完成图片初步解析，可结合以下摘要继续回答：',
      '图片 1: cover.png',
      '- 路径: /workspace/uploads/chat_abc/cover.png',
      '- 视觉摘要: 一张封面图',
      '</uploaded_file_context>',
    ].join('\n');

    const extracted = extractUploadContext(prompt);

    expect(extracted.cleanPrompt).toBe(
      '<messages>\n<message sender="Web User" time="2026-03-11T10:00:00.000Z">@Andy 请帮我总结</message>\n</messages>',
    );
    expect(extracted.rawBlocks).toHaveLength(1);
    expect(extracted.files).toEqual([
      {
        name: 'report.txt',
        path: '/workspace/uploads/chat_abc/report.txt',
        mimeType: 'text/plain',
        sizeLabel: '3KB',
        textExcerpt: 'hello world',
        textTruncated: true,
      },
      {
        name: 'cover.png',
        path: '/workspace/uploads/chat_abc/cover.png',
        mimeType: 'application/octet-stream',
        imageSummary: '一张封面图',
      },
    ]);
  });

  it('provides a fallback user prompt when only files were uploaded', () => {
    expect(
      getUploadAwareUserPrompt('', [
        {
          name: 'report.txt',
          path: '/workspace/uploads/chat_abc/report.txt',
          mimeType: 'text/plain',
        },
      ]),
    ).toBe('请查看我刚上传的文件，并根据文件内容回答。');
  });

  it('builds a system prompt appendix for upload metadata', () => {
    const appendix = buildUploadSystemPromptAppend([
      '文件 1: report.txt\n- 路径: /workspace/uploads/chat_abc/report.txt',
    ]);

    expect(appendix).toContain('internal attachment context');
    expect(appendix).toContain('/workspace/uploads/chat_abc/report.txt');
  });
});
