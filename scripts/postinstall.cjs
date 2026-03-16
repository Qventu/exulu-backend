#!/usr/bin/env node
/**
 * Postinstall script for @exulu/backend
 *
 * Automatically sets up the Python environment when the package is installed.
 * Can be skipped by setting SKIP_PYTHON_SETUP=1 environment variable.
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
 * Check if we should skip Python setup
 */
function shouldSkipSetup() {
  // Skip if environment variable is set
  if (process.env.SKIP_PYTHON_SETUP === '1' || process.env.SKIP_PYTHON_SETUP === 'true') {
    return true;
  }

  // Skip in CI environments by default (unless explicitly enabled)
  if (process.env.CI && !process.env.SETUP_PYTHON_IN_CI) {
    return true;
  }

  return false;
}

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
async function setupPythonEnvironment() {
  const setupScriptPath = resolve(__dirname, '..', 'ee/python/setup.sh');

  if (!existsSync(setupScriptPath)) {
    console.error(`${colors.red}✗${colors.reset} Setup script not found: ${setupScriptPath}`);
    return false;
  }

  try {
    console.log(`${colors.blue}Running Python environment setup...${colors.reset}`);
    console.log('');

    const { stdout, stderr } = await execAsync(`bash "${setupScriptPath}"`, {
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
    return false;
  }
}

/**
 * Main postinstall function
 */
async function main() {
  console.log('');
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.blue}  @exulu/backend - Post-install Setup${colors.reset}`);
  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');

  // Check if we should skip setup
  if (shouldSkipSetup()) {
    console.log(`${colors.yellow}⊘${colors.reset} Skipping Python setup (SKIP_PYTHON_SETUP=1)`);
    console.log('');
    console.log('To set up Python later, run:');
    console.log(`  ${colors.green}npx @exulu/backend setup-python${colors.reset}`);
    console.log('  or in your code:');
    console.log(`  ${colors.green}import { setupPythonEnvironment } from '@exulu/backend';${colors.reset}`);
    console.log(`  ${colors.green}await setupPythonEnvironment();${colors.reset}`);
    console.log('');
    return;
  }

  // Check if already exists
  if (pythonEnvironmentExists()) {
    console.log(`${colors.green}✓${colors.reset} Python environment already set up`);
    console.log('');
    console.log('To rebuild, run:');
    console.log(`  ${colors.green}import { setupPythonEnvironment } from '@exulu/backend';${colors.reset}`);
    console.log(`  ${colors.green}await setupPythonEnvironment({ force: true });${colors.reset}`);
    console.log('');
    return;
  }

  // Run setup
  const success = await setupPythonEnvironment();

  if (success) {
    console.log('');
    console.log(`${colors.green}✓${colors.reset} Python environment ready!`);
    console.log('');
  } else {
    console.log('');
    console.log(`${colors.yellow}!${colors.reset} Python setup failed or was skipped`);
    console.log('');
    console.log('This is not critical - you can set up Python later by running:');
    console.log(`  ${colors.green}import { setupPythonEnvironment } from '@exulu/backend';${colors.reset}`);
    console.log(`  ${colors.green}await setupPythonEnvironment();${colors.reset}`);
    console.log('');
    console.log('Requirements:');
    console.log('  - Python 3.10 or higher');
    console.log('  - pip package manager');
    console.log('');
  }

  console.log(`${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log('');
}

// Run postinstall
main().catch((error) => {
  console.error('Postinstall error:', error);
  // Don't exit with error code - postinstall failures shouldn't block npm install
  process.exit(0);
});
