import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeMessage } from '../db.js';
import { savePendingUpload } from '../db/files.js';
import { createUploadedFileSupport } from './uploaded-files.js';

describe('uploaded file support', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves tenant-scoped uploaded files from the shared uploads mount', () => {
    const uploadsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-uploaded-files-'),
    );
    tempRoots.push(uploadsRoot);

    const support = createUploadedFileSupport({
      chatUploadsRoot: uploadsRoot,
      maxUploadFilesPerRequest: 5,
      maxUploadTextExcerptBytes: 1024,
      maxUploadTextExcerptChars: 1024,
    });

    const chatJid = 'feishu:tenant-a:oc_test_chat';
    const userId = 'user-123';
    const relativeRoot = support.resolveUploadRelativeRoot(chatJid, userId);
    const relativePath = path.posix.join(relativeRoot, 'spec.txt');
    const absolutePath = path.join(uploadsRoot, ...relativePath.split('/'));

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, 'hello');

    const parsed = support.parseUploadedFileContexts(
      [
        {
          relativePath,
          name: 'spec.txt',
          mimeType: 'text/plain',
          size: 5,
        },
      ],
      chatJid,
      userId,
    );

    expect(parsed).toEqual([
      expect.objectContaining({
        name: 'spec.txt',
        mimeType: 'text/plain',
        size: 5,
        relativePath,
        absolutePath,
        mountPath: `/workspace/uploads/${relativePath}`,
      }),
    ]);
  });

  it('builds a user-visible upload label instead of leaking the i18n key', () => {
    const support = createUploadedFileSupport({
      chatUploadsRoot: '/tmp/uploads',
      maxUploadFilesPerRequest: 5,
      maxUploadTextExcerptBytes: 1024,
      maxUploadTextExcerptChars: 1024,
    });

    expect(
      support.buildUploadedFilesDisplayContent('', [
        {
          name: 'spec.txt',
          mimeType: 'text/plain',
          size: 5,
          relativePath: 'chat/spec.txt',
          absolutePath: '/tmp/uploads/chat/spec.txt',
          mountPath: '/workspace/uploads/chat/spec.txt',
        },
      ]),
    ).toBe('[上传文件] spec.txt');
  });

  it('deletes old uploaded files not referenced by messages or pending uploads', async () => {
    const uploadsRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-upload-cleanup-'),
    );
    tempRoots.push(uploadsRoot);

    const support = createUploadedFileSupport({
      chatUploadsRoot: uploadsRoot,
      maxUploadFilesPerRequest: 5,
      maxUploadTextExcerptBytes: 1024,
      maxUploadTextExcerptChars: 1024,
    });

    const referenced = 'chat-a/referenced.txt';
    const pending = 'chat-a/pending.txt';
    const orphan = 'chat-a/orphan.txt';
    const young = 'chat-a/young.txt';
    for (const relativePath of [referenced, pending, orphan, young]) {
      const absolutePath = path.join(uploadsRoot, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, relativePath);
    }

    await storeMessage({
      id: 'msg-uploads',
      chat_jid: 'web:test-upload-cleanup',
      sender: 'web_user',
      sender_name: 'Web User',
      content: 'files',
      timestamp: '2026-05-06T10:00:01.000Z',
      is_from_me: false,
      is_bot_message: false,
      uploaded_files: [
        {
          name: 'referenced.txt',
          mimeType: 'text/plain',
          size: 1,
          relativePath: referenced,
        },
      ],
    });
    await savePendingUpload({
      id: 'pending-upload',
      chat_jid: 'web:test-upload-cleanup',
      message_id: 'msg-pending',
      files_json: JSON.stringify([
        {
          name: 'pending.txt',
          mimeType: 'text/plain',
          size: 1,
          relativePath: pending,
        },
      ]),
      upload_timestamp: '2026-05-06T10:00:02.000Z',
      created_at: '2026-05-06T10:00:02.000Z',
    });

    const oldDate = new Date('2026-05-01T00:00:00.000Z');
    for (const relativePath of [referenced, pending, orphan]) {
      fs.utimesSync(
        path.join(uploadsRoot, ...relativePath.split('/')),
        oldDate,
        oldDate,
      );
    }

    const summary = await support.cleanupOrphanUploadedFiles({
      maxAgeMs: 60 * 60 * 1000,
      now: new Date('2026-05-06T12:00:00.000Z'),
    });

    expect(summary.deletedFiles).toEqual([orphan]);
    expect(fs.existsSync(path.join(uploadsRoot, ...orphan.split('/')))).toBe(
      false,
    );
    expect(
      fs.existsSync(path.join(uploadsRoot, ...referenced.split('/'))),
    ).toBe(true);
    expect(fs.existsSync(path.join(uploadsRoot, ...pending.split('/')))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(uploadsRoot, ...young.split('/')))).toBe(
      true,
    );
  });
});
