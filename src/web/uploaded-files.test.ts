import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createUploadedFileSupport } from './uploaded-files.js';

describe('uploaded file support', () => {
  const tempRoots: string[] = [];

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
});
