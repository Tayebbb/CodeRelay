/**
 * Safe command-line construction for cmd.exe.
 *
 * Node's `spawn(cmd, args, { shell: true })` on Windows joins the command and
 * arguments with spaces and performs NO quoting, so a project path such as
 * `C:\dev\R&D\app` — or an operator-configured test command — turns into command
 * injection. Package-manager entry points on Windows are `.cmd` shims, which
 * Node refuses to spawn without a shell, so we cannot simply drop the shell.
 *
 * We therefore build the command line ourselves and quote every token. Inside
 * double quotes cmd.exe treats `&`, `|`, `<`, `>` and spaces literally, so
 * quoting is sufficient — provided the token cannot terminate the quoted region
 * or trigger expansion. Tokens containing `"` or `%` are rejected outright.
 */

export class UnsafeCommandError extends Error {}

const UNSAFE_TOKEN = /["%\r\n\0]/;

export function assertSafeToken(token: string): void {
  if (UNSAFE_TOKEN.test(token)) {
    throw new UnsafeCommandError(
      `Refusing to run a command containing a quote, percent sign, or control character: ${JSON.stringify(token)}`,
    );
  }
}

/** Quote a single token for cmd.exe. */
export function quoteForCmd(token: string): string {
  assertSafeToken(token);
  // A trailing backslash would escape the closing quote.
  const escaped = token.replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Tokens made only of these characters cannot change how cmd.exe parses the
 * line, so they may be passed through bare. Everything else gets quoted.
 * Deliberately excludes space and every cmd metacharacter (`& | < > ^ ( ) , ; !`).
 */
const SAFE_BARE_TOKEN = /^[A-Za-z0-9_\-.\\/:=+@]+$/;

/**
 * Quote a token only when it needs it.
 *
 * Quoting is not free on Windows: `cmd /c ""npm" "test""` sets `%0` to the bare
 * quoted name `"npm"`, so `%~dp0` inside a `.cmd` shim expands to the CURRENT
 * DIRECTORY instead of the shim's own directory. npm.cmd then looks for
 * `<cwd>\node_modules\npm\bin\npm-prefix.js`, fails, and the caller sees a
 * bogus test failure. Leaving a token that needs no quoting bare lets cmd do a
 * normal PATH lookup and set `%0` to the resolved script path.
 */
export function quoteForCmdIfNeeded(token: string): string {
  assertSafeToken(token);
  if (token.length > 0 && SAFE_BARE_TOKEN.test(token)) return token;
  return quoteForCmd(token);
}

/** Build a cmd.exe command line, quoting only the tokens that require it. */
export function buildCmdLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteForCmdIfNeeded).join(' ');
}

/** Arguments for spawning cmd.exe with a pre-quoted command line. */
export function cmdExeInvocation(command: string, args: string[]): { file: string; args: string[] } {
  // `/s` makes cmd strip exactly the first and last quote of the command line,
  // so the whole already-quoted line is wrapped in one more pair. Without the
  // wrapper cmd would eat the quotes around the executable itself.
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    // /d skips AutoRun, /s controls quote handling, /c runs and exits.
    args: ['/d', '/s', '/c', `"${buildCmdLine(command, args)}"`],
  };
}
