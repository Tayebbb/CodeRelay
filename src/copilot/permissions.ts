/**
 * Copilot CLI permission policy.
 *
 * Design notes (verified against Copilot CLI 1.0.63 `copilot help permissions`):
 *  - `--deny-tool` ALWAYS wins over `--allow-all-tools`, so an allow-all +
 *    explicit deny-list is a supported and enforceable combination.
 *  - We deliberately never pass `--allow-all-paths`, `--allow-all-urls`,
 *    `--allow-all` or `--yolo`. Without `--allow-all-paths` the CLI restricts
 *    file access to the working directory (the project) plus the temp dir.
 *  - URL access is granted per-domain via `--allow-url`; this also governs the
 *    shell tool, so `curl https://evil.example` is blocked by the same rule.
 */

/** Shell commands the agent may never run, regardless of task. */
export const DEFAULT_DENIED_COMMANDS: string[] = [
  // Destructive filesystem
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'format',
  'mkfs',
  'diskpart',
  'fdisk',
  'dd',
  'shred',
  'Remove-Item',
  'Clear-Content',
  // Machine state
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'Restart-Computer',
  'Stop-Computer',
  'systemctl',
  'sc',
  'net',
  'wmic',
  'schtasks',
  'crontab',
  'at',
  // Privilege escalation / ACLs
  'sudo',
  'doas',
  'su',
  'runas',
  'Start-Process',
  'icacls',
  'takeown',
  'chown',
  'setfacl',
  // Registry / firewall / network config
  'reg',
  'regedit',
  'netsh',
  'iptables',
  'nft',
  'ufw',
  'route',
  'Set-NetFirewallRule',
  // Credential stores
  'cmdkey',
  'vaultcmd',
  'security',
  'keyring',
  'gpg',
  'ssh-add',
  'ssh-keygen',
  'pass',
  // Remote access / exfiltration channels
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  // Deployment & cloud (never from an unattended coding task)
  'docker',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'pulumi',
  'ansible',
  'aws',
  'az',
  'gcloud',
  'heroku',
  'flyctl',
  'vercel',
  'netlify',
  'serverless',
  // Publishing / anything that reaches a remote as *us*
  'gh',
  'glab',
  'twine',
  // Package managers that mutate the system rather than the project
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'brew',
  'choco',
  'winget',
  'scoop',
  'snap',
];

/** Git subcommands the agent may never run. Commits/pushes are done by this app. */
export const DEFAULT_DENIED_GIT_SUBCOMMANDS: string[] = [
  'git push',
  'git reset',
  'git clean',
  'git rebase',
  'git filter-branch',
  'git config',
  'git remote',
  'git submodule',
  'git gc',
  'git reflog',
];

export interface PermissionPolicyInput {
  allowedUrls: string[];
  extraDeniedCommands: string[];
  /** Additional read/write roots beyond the project directory. */
  extraDirs: string[];
  /** Deny the system temp directory too (stricter, may break some toolchains). */
  disallowTempDir?: boolean;
}

export interface PermissionPolicy {
  args: string[];
  deniedCommands: string[];
  allowedUrls: string[];
}

/** Build the Copilot CLI permission flags for a task. */
export function buildPermissionPolicy(input: PermissionPolicyInput): PermissionPolicy {
  const deniedCommands = [
    ...new Set([...DEFAULT_DENIED_COMMANDS, ...input.extraDeniedCommands.map((c) => c.trim()).filter(Boolean)]),
  ];

  const args: string[] = [
    // Required for non-interactive operation. Narrowed by the deny-list below.
    '--allow-all-tools',
  ];

  for (const command of deniedCommands) {
    args.push(`--deny-tool=shell(${command})`);
  }
  for (const gitCommand of DEFAULT_DENIED_GIT_SUBCOMMANDS) {
    args.push(`--deny-tool=shell(${gitCommand})`);
  }

  for (const url of input.allowedUrls) {
    args.push(`--allow-url=${url}`);
  }

  for (const dir of input.extraDirs) {
    args.push('--add-dir', dir);
  }

  if (input.disallowTempDir) args.push('--disallow-temp-dir');

  return { args, deniedCommands, allowedUrls: input.allowedUrls };
}
