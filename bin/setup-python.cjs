#!/usr/bin/env node
/**
 * CLI script for setting up the Python environment for @exulu/backend
 *
 * This script can be run standalone using:
 *   npx @exulu/backend setup-python
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const { existsSync } = require('fs');
const { resolve, join } = require('path');

const execAsync = promisify(exec);

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
};

/**
 * Check if Python environment already exists
 */
function pythonEnvironmentExists() {
  const venvPath = resolve(__dirname, '..', 'ee/python/.venv');
  const pythonPath = join(venvPath, 'bin', 'python');
  return existsSync(venvPath) && existsSync(pythonPath);
}

/**
 * Run the Python setup script
 */
async function setupPythonEnvironment(force = false) {
  const setupScriptPath = resolve(__dirname, '..', 'ee/python/setup.sh');

  if (!existsSync(setupScriptPath)) {
    console.error(`${colors.red}✗${colors.reset} Setup script not found: ${setupScriptPath}`);
    console.error('');
    console.error('Make sure the @exulu/backend package is properly installed.');
    process.exit(1);
  }

  try {
    console.log(`${colors.blue}Running Python environment setup...${colors.reset}`);
    console.log('');

    const command = force
      ? `bash "${setupScriptPath}" --force`
      : `bash "${setupScriptPath}"`;

    const { stdout, stderr } = await execAsync(command, {
      cwd: resolve(__dirname, '..'),
      timeout: 600000, // 10 minutes
      maxBuffer: 10 * 1024 * 1024,
    });

    // Show output
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    return true;
  } catch (error) {
    console.error(`${colors.red}✗${colors.reset} Python setup failed:`, error.message);
    if (error.stdout) console.log(error.stdout);
    if (error.stderr) console.error(error.stderr);

    console.log('');
    console.log('Requirements:');
    console.log('  - Python 3.10 or higher must be installed');
    console.log('  - pip must be available');
    console.log('  - venv module must be available');
    console.log('');
    console.log('Installation instructions:');
    console.log('  macOS:           brew install python@3.12');
    console.log('  Ubuntu/Debian:   sudo apt-get install python3.12 python3-pip python3-venv');
    console.log('  Alpine Linux:    apk add python3 py3-pip python3-dev');
    console.log('  Windows:         Download from https://www.python.org/downloads/');
    console.log('');

    return false;
  }
}

/**
 * Main CLI function
 */
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force') || args.includes('-f');

  console.log('');
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.blue}  @exulu/backend - Python Setup${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  // Check if already exists (and not forcing)
  if (pythonEnvironmentExists() && !force) {
    console.log(`${colors.green}✓${colors.reset} Python environment already set up`);
    console.log('');
    console.log('To rebuild the environment, run:');
    console.log(`  ${colors.green}npx @exulu/backend setup-python --force${colors.reset}`);
    console.log('');
    console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log('');
    return;
  }

  if (force && pythonEnvironmentExists()) {
    console.log(`${colors.yellow}⚠${colors.reset} Rebuilding Python environment (--force flag detected)`);
    console.log('');
  }

  // Run setup
  const success = await setupPythonEnvironment(force);

  if (success) {
    console.log('');
    console.log(`${colors.green}✓${colors.reset} Python environment ready!`);
    console.log('');
  } else {
    console.log('');
    console.log(`${colors.red}✗${colors.reset} Setup failed`);
    console.log('');
    process.exit(1);
  }

  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
}

// Run CLI
main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
