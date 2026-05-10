import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _buildAgentPromptInputForTest,
  _clearPendingUploadedFilesForTest,
  _queueUploadedFilesForTest,
} from './index.js';
import { _initTestDatabase } from './db.js';
import type { NewMessage } from './types.js';

describe('uploaded file prompt payload', () => {
  const chatJid = 'chat-upload-1';

  beforeEach(() => {
    _initTestDatabase();
    _clearPendingUploadedFilesForTest(chatJid);
  });

  afterEach(() => {
    _clearPendingUploadedFilesForTest(chatJid);
  });

  it('keeps uploaded files structured instead of appending internal upload prompt text', async () => {
    const message: NewMessage = {
      id: 'msg-1',
      chat_jid: chatJid,
      sender: 'web_user',
      sender_name: 'Web User',
      content: '@Andy 请看这个文件\n\n[上传文件] spec.txt',
      timestamp: '2026-03-11T10:00:00.000Z',
      is_from_me: false,
      uploaded_files: [
        {
          name: 'spec.txt',
          mimeType: 'text/plain',
          size: 321,
          relativePath: 'chat_abc/spec.txt',
        },
      ],
    };

    _queueUploadedFilesForTest(chatJid, message);
    const prompt = await _buildAgentPromptInputForTest(chatJid, [message]);

    expect(prompt.uploadedFiles).toEqual([
      {
        name: 'spec.txt',
        mimeType: 'text/plain',
        size: 321,
        relativePath: 'chat_abc/spec.txt',
      },
    ]);
    expect(prompt.text).toContain('<messages>');
    expect(prompt.text).toContain('[上传文件] spec.txt');
    expect(prompt.text).not.toContain('<uploaded_file_context');
    expect(prompt.text).not.toContain('用户附带了以下上传文件');
  });
});
