import { createModuleLogger } from '../logger.js';
import { extractText, isImageFile, isSupportedFile } from '../knowledge/file-extractors.js';
import type { AgentUploadedFile } from '../types/agent.js';
import fs from 'fs';
import path from 'path';

const logger = createModuleLogger('sdlc-trigger');

export interface SdlcInput {
  textContent: string;
  extractedFiles: string[];
  imageFiles: string[];
}

export async function buildSdlcInput(
  rawMessage: string,
  uploadedFiles: AgentUploadedFile[] | undefined,
  chatUploadsRoot: string,
): Promise<SdlcInput> {
  const extractedParts: string[] = [];
  const imageFiles: string[] = [];
  const extractedFileNames: string[] = [];

  if (uploadedFiles?.length) {
    for (const file of uploadedFiles) {
      const filePath = path.resolve(chatUploadsRoot, file.relativePath);
      const rel = path.relative(path.resolve(chatUploadsRoot), filePath);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn({ file: file.name }, 'sdlc-trigger: path traversal blocked');
        continue;
      }
      if (!fs.existsSync(filePath)) {
        logger.warn({ file: file.name }, 'sdlc-trigger: uploaded file not found');
        continue;
      }

      if (isImageFile(file.name)) {
        imageFiles.push(filePath);
        extractedFileNames.push(file.name);
        continue;
      }

      if (!isSupportedFile(file.name)) {
        logger.debug({ file: file.name }, 'sdlc-trigger: unsupported file type, skipping');
        continue;
      }

      try {
        const buffer = await fs.promises.readFile(filePath);
        const text = await extractText(buffer, file.name);
        if (text.trim()) {
          extractedParts.push(`--- ${file.name} ---\n${text}`);
          extractedFileNames.push(file.name);
        }
      } catch (err) {
        logger.warn({ file: file.name, err }, 'sdlc-trigger: file extraction failed');
      }
    }
  }

  const combinedText = [
    rawMessage.trim(),
    ...extractedParts,
  ].filter(Boolean).join('\n\n');

  return {
    textContent: combinedText,
    extractedFiles: extractedFileNames,
    imageFiles,
  };
}
