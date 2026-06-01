#!/usr/bin/env node
/**
 * Dispatcher for `npx @exulu/backend <subcommand>`.
 *
 * npx refuses to pick a bin when a package has multiple, unless one matches
 * the package's unscoped name. This dispatcher claims that slot and forwards
 * to the real subcommand scripts.
 */

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const subcommands = {
  'setup-python': path.join(__dirname, 'setup-python.cjs'),
  'exulu-start-whisper': path.join(__dirname, '..', 'dist', 'cli', 'start-whisper.cjs'),
  'start-whisper': path.join(__dirname, '..', 'dist', 'cli', 'start-whisper.cjs'),
};

function printUsage(stream) {
  stream.write('Usage: npx @exulu/backend <subcommand> [args...]\n\n');
  stream.write('Available subcommands:\n');
  for (const name of Object.keys(subcommands)) {
    stream.write(`  ${name}\n`);
  }
  stream.write('\n');
}

const [, , subcommand, ...args] = process.argv;

if (!subcommand || subcommand === '--help' || subcommand === '-h') {
  printUsage(process.stdout);
  process.exit(subcommand ? 0 : 1);
}

const target = subcommands[subcommand];
if (!target) {
  process.stderr.write(`Unknown subcommand: ${subcommand}\n\n`);
  printUsage(process.stderr);
  process.exit(1);
}

if (!existsSync(target)) {
  process.stderr.write(`Subcommand script missing: ${target}\n`);
  process.stderr.write('The @exulu/backend package may not be fully built or installed.\n');
  process.exit(1);
}

const child = spawn(process.execPath, [target, ...args], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  process.stderr.write(`Failed to run subcommand: ${err.message}\n`);
  process.exit(1);
});
