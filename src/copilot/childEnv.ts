import { registerSecret } from '../core/redact.js';

/**
 * Environment for the Copilot child process.
 *
 * This is an ALLOW-LIST, not a deny-list. The operator's shell is full of
 * credentials (`GITHUB_TOKEN`, `AWS_*`, `NPM_TOKEN`, …) and the agent runs
 * unattended against repositories whose contents may be hostile, so forwarding
 * everything and subtracting a handful of known names fails open. Anything the
 * child genuinely needs must be named here.
 */

/** Exact names always forwarded (platform + toolchain essentials). */
const ALLOWED_EXACT = new Set([
  // POSIX + Windows basics
  'PATH',
  'Path',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'PWD',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'SYSTEMROOT',
  'SystemRoot',
  'SYSTEMDRIVE',
  'SystemDrive',
  'WINDIR',
  'windir',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'TEMP',
  'TMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMFILES(X86)',
  'ProgramFiles(x86)',
  'PROGRAMDATA',
  'ProgramData',
  'PROGRAMW6432',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'PSMODULEPATH',
  'PSModulePath',
  // Copilot's own configuration
  'COPILOT_HOME',
  'GH_HOST',
  'COPILOT_GH_HOST',
  // Proxy settings (needed on corporate networks)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

/** Prefixes forwarded wholesale — toolchain roots that builds need. */
const ALLOWED_PREFIXES = [
  'NODE_',
  'NPM_CONFIG_',
  'PNPM_',
  'YARN_',
  'JAVA_',
  'JDK_',
  'MAVEN_',
  'GRADLE_',
  'DOTNET_',
  'NUGET_',
  'PYTHON',
  'PIP_',
  'VIRTUAL_ENV',
  'CONDA_',
  'CARGO_',
  'RUSTUP_',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'GOMODCACHE',
];

/** Never forwarded even if a rule above would match (credentials). */
const DENIED_SUBSTRINGS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'APIKEY',
  'API_KEY',
  'ACCESS_KEY',
  'PRIVATE_KEY',
  'CREDENTIAL',
  'AUTH',
];

/**
 * Variables that silently inject code into a child process. They match the
 * toolchain prefixes above, so they must be denied explicitly. A build that
 * genuinely needs one (e.g. `NODE_OPTIONS=--max-old-space-size=4096`) can
 * re-enable it with COPILOT_ENV_PASSTHROUGH.
 */
const DENIED_EXACT = new Set([
  // Node
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_PATH',
  'NODE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // npm/yarn/pnpm — these run code or redirect where packages come from
  'NPM_CONFIG_SCRIPT_SHELL',
  'NPM_CONFIG_NODE_OPTIONS',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_GLOBALCONFIG',
  'NPM_CONFIG_REGISTRY',
  'NPM_CONFIG_CAFILE',
  'NPM_CONFIG_STRICT_SSL',
  'NPM_CONFIG_IGNORE_SCRIPTS',
  'YARN_PLUGINS',
  'YARN_RC_FILENAME',
  // Python
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'PYTHONEXECUTABLE',
  'PYTHONBREAKPOINT',
  'PYTHONWARNINGS',
  'PIP_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
  'PIP_CONFIG_FILE',
  'PIP_TARGET',
  'PIP_TRUSTED_HOST',
  // JVM
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'MAVEN_OPTS',
  'MAVEN_ARGS',
  'MAVEN_CONFIG',
  'GRADLE_OPTS',
  'GRADLE_USER_HOME',
  // .NET
  'DOTNET_STARTUP_HOOKS',
  'DOTNET_ADDITIONAL_DEPS',
  'DOTNET_SHARED_STORE',
  // Rust
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'CARGO_BUILD_RUSTC',
  'CARGO_BUILD_RUSTC_WRAPPER',
  'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
  'CARGO_BUILD_TARGET_DIR',
  // Other interpreters and loaders
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'COPILOT_ALLOW_ALL',
]);

/**
 * Suffix rules catch the per-target and per-registry variants that cannot be
 * listed exhaustively, e.g. `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER` or
 * `CARGO_REGISTRIES_MINE_INDEX`.
 */
const DENIED_PATTERNS = [/^CARGO_TARGET_.*_(RUNNER|LINKER|RUSTFLAGS)$/, /^CARGO_REGISTRIES_/, /_STARTUP_HOOKS$/];

function isAllowed(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENIED_EXACT.has(upper)) return false;
  if (DENIED_PATTERNS.some((re) => re.test(upper))) return false;
  if (DENIED_SUBSTRINGS.some((bad) => upper.includes(bad))) return false;
  if (ALLOWED_EXACT.has(name)) return true;
  return ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface ChildEnvOptions {
  /** Extra names to forward (advanced projects that need a specific variable). */
  passthrough?: string[];
  /** Values merged in last. */
  overrides?: NodeJS.ProcessEnv;
}

/**
 * Build the Copilot child environment from scratch, and register any credential
 * we deliberately withhold so `redact()` would still catch it if it leaked by
 * another route.
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: ChildEnvOptions = {},
): NodeJS.ProcessEnv {
  const passthrough = new Set(options.passthrough ?? []);
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isAllowed(name) || passthrough.has(name)) {
      env[name] = value;
      continue;
    }
    // Withheld. If it looks like a credential, make sure it can never be
    // echoed back to Telegram or a log even via some other path.
    const upper = name.toUpperCase();
    if (DENIED_SUBSTRINGS.some((bad) => upper.includes(bad))) registerSecret(value);
  }

  return { ...env, NO_COLOR: '1', CI: '1', ...options.overrides };
}

export const __testing = { isAllowed, ALLOWED_EXACT, ALLOWED_PREFIXES, DENIED_SUBSTRINGS, DENIED_EXACT, DENIED_PATTERNS };
