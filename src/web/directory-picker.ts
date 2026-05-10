import { spawn, spawnSync } from 'child_process';
import os from 'os';
import { t } from '../i18n/index.js';

function runCommandForOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `Command failed: ${command}`,
        ),
      );
    });
  });
}

export function buildWindowsDirectoryPickerScript(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$OutputEncoding = [System.Text.Encoding]::UTF8;',
    'if (-not [Environment]::UserInteractive) {',
    t('errors.auto_289ba8', {}, undefined),
    '}',
    'function Show-WinFormsFolderPicker {',
    '  Add-Type -AssemblyName System.Windows.Forms;',
    '  Add-Type -AssemblyName System.Drawing;',
    '  [System.Windows.Forms.Application]::EnableVisualStyles();',
    '  $owner = New-Object System.Windows.Forms.Form;',
    '  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual;',
    '  $owner.Location = New-Object System.Drawing.Point(-32000, -32000);',
    '  $owner.ShowInTaskbar = $false;',
    '  $owner.Opacity = 0;',
    '  $owner.TopMost = $true;',
    '  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
    t('errors.auto_d4bcd0', {}, undefined),
    '  $dialog.ShowNewFolderButton = $true;',
    '  try {',
    '    $null = $owner.Show();',
    '    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '      return $dialog.SelectedPath;',
    '    }',
    "    return '';",
    '  } finally {',
    '    if ($dialog) { $dialog.Dispose() }',
    '    if ($owner) { $owner.Close(); $owner.Dispose() }',
    '  }',
    '}',
    'function Show-ShellFolderPicker {',
    '  $shell = New-Object -ComObject Shell.Application;',
    t('errors.auto_20d110', {}, undefined),
    '  if ($folder -and $folder.Self) {',
    '    return $folder.Self.Path;',
    '  }',
    "  return '';",
    '}',
    'try {',
    '  $selected = Show-WinFormsFolderPicker;',
    '} catch {',
    '  $selected = Show-ShellFolderPicker;',
    '}',
    'if ($selected) {',
    '  Write-Output $selected;',
    '}',
  ].join('\n');
}

export function trimSelectedDirectoryPath(selectedPath: string): string {
  const trimmed = selectedPath.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z]:\\$/.test(trimmed) || trimmed === '/') return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function detectLinuxPicker(): string {
  const detector = spawnSync(
    'sh',
    ['-lc', 'command -v zenity || command -v kdialog || command -v yad'],
    { encoding: 'utf8' },
  );
  return detector.status === 0 ? detector.stdout.trim() : '';
}

export function createNativeDirectoryPicker(
  deps: {
    platform?: () => NodeJS.Platform;
    homedir?: () => string;
    runCommand?: (command: string, args: string[]) => Promise<string>;
    detectPicker?: () => string;
  } = {},
) {
  const platform = deps.platform || (() => process.platform);
  const getHomeDir = deps.homedir || (() => os.homedir());
  const runCommand = deps.runCommand || runCommandForOutput;
  const detectPicker = deps.detectPicker || detectLinuxPicker;

  return async function selectDirectoryNative(): Promise<string | null> {
    if (platform() === 'darwin') {
      const selected = await runCommand('osascript', [
        '-e',
        'try',
        '-e',
        t('errors.auto_689a49', {}, undefined),
        '-e',
        'on error number -128',
        '-e',
        'return ""',
        '-e',
        'end try',
      ]);
      return trimSelectedDirectoryPath(selected) || null;
    }

    if (platform() === 'win32') {
      const selected = await runCommand('powershell.exe', [
        '-NoProfile',
        '-STA',
        '-Command',
        buildWindowsDirectoryPickerScript(),
      ]);
      return trimSelectedDirectoryPath(selected) || null;
    }

    const picker = detectPicker();

    if (picker.endsWith('/zenity')) {
      const selected = await runCommand(picker, [
        '--file-selection',
        '--directory',
        t('errors.auto_8d31f8', {}, undefined),
      ]);
      return trimSelectedDirectoryPath(selected) || null;
    }

    if (picker.endsWith('/kdialog')) {
      const selected = await runCommand(picker, [
        '--getexistingdirectory',
        getHomeDir(),
        t('errors.auto_2567dc', {}, undefined),
      ]);
      return trimSelectedDirectoryPath(selected) || null;
    }

    if (picker.endsWith('/yad')) {
      const selected = await runCommand(picker, [
        '--file-selection',
        '--directory',
        t('errors.auto_8d31f8', {}, undefined),
      ]);
      return trimSelectedDirectoryPath(selected) || null;
    }

    const error = new Error(
      'No supported native directory picker found. Native directory selection is not available in server environments. Please use the web file browser or provide the directory path directly.',
    );
    (error as any).code = 'NO_NATIVE_PICKER';
    throw error;
  };
}

export const selectDirectoryNative = createNativeDirectoryPicker();
