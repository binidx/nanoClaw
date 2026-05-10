import { describe, expect, it, vi } from 'vitest';

import {
  buildWindowsDirectoryPickerScript,
  createNativeDirectoryPicker,
  trimSelectedDirectoryPath,
} from './web/directory-picker.js';

describe('directory-picker', () => {
  it('trims trailing separators but preserves roots', () => {
    expect(trimSelectedDirectoryPath('C:\\temp\\')).toBe('C:\\temp');
    expect(trimSelectedDirectoryPath('C:\\')).toBe('C:\\');
    expect(trimSelectedDirectoryPath('/')).toBe('/');
  });

  it('builds the windows picker script with both picker strategies', () => {
    const script = buildWindowsDirectoryPickerScript();
    expect(script).toContain('Show-WinFormsFolderPicker');
    expect(script).toContain('Show-ShellFolderPicker');
  });

  it('uses the injected linux picker and normalizes the chosen path', async () => {
    const runCommand = vi.fn(async () => '/tmp/workspace/\n');
    const picker = createNativeDirectoryPicker({
      platform: () => 'linux',
      detectPicker: () => '/usr/bin/zenity',
      runCommand,
    });

    await expect(picker()).resolves.toBe('/tmp/workspace');
    expect(runCommand).toHaveBeenCalledWith('/usr/bin/zenity', [
      '--file-selection',
      '--directory',
      '--title=选择目录授权文件夹',
    ]);
  });

  it('uses kdialog with the injected home directory', async () => {
    const runCommand = vi.fn(async () => '/home/demo/project\n');
    const picker = createNativeDirectoryPicker({
      platform: () => 'linux',
      detectPicker: () => '/usr/bin/kdialog',
      homedir: () => '/home/demo',
      runCommand,
    });

    await expect(picker()).resolves.toBe('/home/demo/project');
    expect(runCommand).toHaveBeenCalledWith('/usr/bin/kdialog', [
      '--getexistingdirectory',
      '/home/demo',
      '选择目录授权文件夹',
    ]);
  });
});
