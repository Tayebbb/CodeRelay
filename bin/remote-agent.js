#!/usr/bin/env node
// Thin launcher so `remote-agent` works before/after a build, on Windows and POSIX.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, '..', 'dist', 'src', 'cli.js');

if (!existsSync(built)) {
  console.error('\nThe agent has not been built yet. Run:\n\n  npm install\n  npm run build\n');
  process.exit(1);
}

const { runCli } = await import(pathToFileURL(built).href);
process.exitCode = await runCli(process.argv.slice(2));
