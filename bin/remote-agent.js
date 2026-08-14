#!/usr/bin/env node
// Thin launcher so `remote-agent` works before/after a build, on Windows and POSIX.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Checked here, before anything touches node:sqlite, so an old Node gets one
// clear sentence instead of a module-not-found stack trace.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`\nCodeRelay needs Node.js 22.5 or newer (for the built-in SQLite module).\nYou are running ${process.versions.node}. Get a current version from https://nodejs.org\n`);
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'src', 'cli.js');

if (!existsSync(built)) {
  console.error('\nThe agent has not been built yet. Run:\n\n  npm install\n  npm run build\n');
  process.exit(1);
}

const { runCli } = await import(pathToFileURL(built).href);
process.exitCode = await runCli(process.argv.slice(2));
