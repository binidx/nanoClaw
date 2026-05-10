import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TerminalLaunchConfig {
  shell: string;
  args: string[];
}

function isUsableUnixShell(
  shell: string | undefined,
  targetPlatform: NodeJS.Platform,
): shell is string {
  const candidate = shell?.trim();
  if (!candidate) return false;
  if (!candidate.startsWith('/')) return true;
  if (targetPlatform !== os.platform()) return true;
  return fs.existsSync(candidate);
}

export function resolveStreamTerminalLaunch(
  launch: TerminalLaunchConfig,
  platform = os.platform(),
): TerminalLaunchConfig {
  if (launch.args.length > 0) return launch;

  const shellName = (launch.shell.split(/[\\/]/).pop() || '').toLowerCase();
  if (platform === 'win32') {
    return launch;
  }

  if (shellName === 'zsh') {
    return {
      shell: launch.shell,
      args: platform === 'darwin' ? ['-f', '-i'] : ['-i'],
    };
  }

  if (shellName === 'bash' || shellName === 'fish' || shellName === 'ksh') {
    return { shell: launch.shell, args: ['-i'] };
  }

  return launch;
}

export function repairNodePtySpawnHelperPermissions(
  options: {
    projectRoot?: string;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): { repaired: boolean; helperPath: string | null } {
  const platform = options.platform || os.platform();
  if (platform === 'win32') {
    return { repaired: false, helperPath: null };
  }

  const projectRoot = options.projectRoot || process.cwd();
  const arch = options.arch || process.arch;
  const helperPath = path.join(
    projectRoot,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${platform}-${arch}`,
    'spawn-helper',
  );

  let stats: fs.Stats;
  try {
    stats = fs.statSync(helperPath);
  } catch {
    return { repaired: false, helperPath: null };
  }

  if (!stats.isFile()) {
    return { repaired: false, helperPath };
  }

  const executableMask = 0o111;
  if ((stats.mode & executableMask) === executableMask) {
    return { repaired: false, helperPath };
  }

  fs.chmodSync(helperPath, stats.mode | executableMask);
  return { repaired: true, helperPath };
}

export function resolveTerminalLaunch(
  platform = os.platform(),
  env: NodeJS.ProcessEnv = process.env,
): TerminalLaunchConfig {
  if (platform === 'win32') {
    const preferredShell = env.PWSH_PATH?.trim();
    if (preferredShell) {
      return { shell: preferredShell, args: ['-NoLogo'] };
    }

    const comspec = env.COMSPEC?.trim();
    if (comspec) {
      if (/powershell|pwsh/i.test(comspec)) {
        return { shell: comspec, args: ['-NoLogo'] };
      }
      return { shell: comspec, args: [] };
    }

    return { shell: 'powershell.exe', args: ['-NoLogo'] };
  }

  if (isUsableUnixShell(env.SHELL, platform)) {
    return { shell: env.SHELL.trim(), args: [] };
  }

  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (isUsableUnixShell(candidate, platform)) {
      return { shell: candidate, args: [] };
    }
  }

  return { shell: '/bin/sh', args: [] };
}
