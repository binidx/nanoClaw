import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from '../group-folder.js';

const CODEX_COMPAT_DIR_NAME = '.nanoclaw-codex';

export function clearCodexConversationState(groupFolder: string): void {
  const compatDir = path.join(
    resolveGroupFolderPath(groupFolder),
    CODEX_COMPAT_DIR_NAME,
  );
  fs.rmSync(compatDir, { recursive: true, force: true });
}
