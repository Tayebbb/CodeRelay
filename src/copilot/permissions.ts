/**
 * Copilot CLI permission policy.
 *
 * Verified against Copilot CLI 1.0.79 (`copilot help permissions`, `help sandbox`):
 *  - `--deny-tool` ALWAYS wins over `--allow-all-tools`.
 *  - A bare `shell(rm)` DOES match `rm -rf x` — matching is on the command stem,
 *    so argument-bearing invocations are covered.
 *  - We never pass `--allow-all-paths`, `--allow-all-urls`, `--allow-all` or
 *    `--yolo`, so the built-in file tools stay confined to the working directory.
 *
 * HONEST LIMITATION — read this before trusting the deny-list. `copilot help
 * sandbox` states that with sandboxing disabled (the default) "shell commands
 * run directly on your machine with the same access your user account has". The
 * path restriction therefore constrains the built-in FILE tools, not shell
 * commands. A command deny-list is also not a sound boundary: any interpreter
 * (`node -e`, `python -c`, `bash -c`) performs the same syscalls without ever
 * naming a denied command. We deny the interpreters too, but an exhaustive
 * blocklist over a Turing-complete surface is impossible.
 *
 * The real containment boundary is `COPILOT_SANDBOX=true` (the CLI's
 * experimental MXC sandbox). Everything here is defence in depth.
 */

/** Shell commands the agent may never run, regardless of task. */
export const DEFAULT_DENIED_COMMANDS: string[] = [
  // ---- Interpreters and shells -------------------------------------------
  // Without these the rest of the list is decorative: `node -e "fs.rmSync(...)"`
  // performs a denied action without ever invoking a denied command.
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'csh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'node',
  'nodejs',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'py',
  'perl',
  'ruby',
  'php',
  'lua',
  'osascript',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'certutil',
  'bitsadmin',
  'msiexec',
  'Invoke-Expression',
  'iex',
  'Start-Job',
  'env',
  'xargs',
  'eval',
  'source',
  'npx',
  'pnpx',
  'bunx',
  // ---- Nested agent CLIs (permission escalation) --------------------------
  // `copilot -p "..." --yolo` would start a SECOND session with none of the
  // flags on this command line, discarding every restriction below.
  'copilot',
  'claude',
  'gemini',
  'aider',
  'cursor-agent',
  'code',
  'code-insiders',
  'codium',
  // ---- Network fetch (exfiltration / remote code execution) --------------
  'curl',
  'wget',
  'Invoke-WebRequest',
  'Invoke-RestMethod',
  'iwr',
  'irm',
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
  'ri',
  'Clear-Content',
  'Set-Content',
  'Add-Content',
  'Out-File',
  'Move-Item',
  'mi',
  'mv',
  'move',
  'Copy-Item',
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

/** Files the agent may never create or modify (credential material). */
export const DEFAULT_DENIED_WRITES: string[] = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
];

/**
 * Endpoints reachable via an otherwise-allowed domain that an authenticated user
 * can WRITE to — i.e. usable for exfiltration. Deny takes precedence over allow.
 */
export const DEFAULT_DENIED_URLS: string[] = [
  'https://api.github.com',
  'https://gist.github.com',
  'https://gist.githubusercontent.com',
  'https://uploads.github.com',
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
  deniedUrls: string[];
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
  for (const file of DEFAULT_DENIED_WRITES) {
    args.push(`--deny-tool=write(${file})`);
  }

  // Denies first — they take precedence, and the allow-list below deliberately
  // includes broad domains whose writable endpoints must stay unreachable.
  for (const url of DEFAULT_DENIED_URLS) {
    args.push(`--deny-url=${url}`);
  }
  for (const url of input.allowedUrls) {
    args.push(`--allow-url=${url}`);
  }

  for (const dir of input.extraDirs) {
    args.push('--add-dir', dir);
  }

  if (input.disallowTempDir) args.push('--disallow-temp-dir');

  return { args, deniedCommands, allowedUrls: input.allowedUrls, deniedUrls: DEFAULT_DENIED_URLS };
}
