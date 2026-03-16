/**
 * Python Environment Setup Utility
 *
 * Provides functions to set up and validate the Python environment for Exulu backend.
 * This can be called manually by package consumers or run automatically on install.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

/**
 * Get the package root directory (where this package is installed)
 */
function getPackageRoot(): string {
  // In ESM, we need to use import.meta.url
  const currentFile = fileURLToPath(import.meta.url);
  let currentDir = dirname(currentFile);

  // Walk up the directory tree to find package.json
  // This handles both development (src/) and production (dist/) scenarios
  // as well as symlinked packages (npm link)
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const packageJsonPath = join(currentDir, 'package.json');

    if (existsSync(packageJsonPath)) {
      // Verify this is the @exulu/backend package
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (packageJson.name === '@exulu/backend') {
          return currentDir;
        }
      } catch {
        // Invalid package.json, continue searching
      }
    }

    // Go up one directory
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
    attempts++;
  }

  // Fallback: assume 2 levels up (dist/utils -> dist -> root or src/utils -> src -> root)
  const fallback = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return fallback;
}

/**
 * Options for Python environment setup
 */
export interface PythonSetupOptions {
  /**
   * Package root directory (where @exulu/backend is installed)
   * @default Auto-detected from package location
   */
  packageRoot?: string;

  /**
   * Whether to force reinstall even if environment exists
   * @default false
   */
  force?: boolean;

  /**
   * Whether to show verbose output
   * @default false
   */
  verbose?: boolean;

  /**
   * Timeout for setup process in milliseconds
   * @default 600000 (10 minutes)
   */
  timeout?: number;
}

/**
 * Result of Python environment setup
 */
export interface PythonSetupResult {
  /** Whether setup was successful */
  success: boolean;

  /** Message describing the result */
  message: string;

  /** Whether the environment already existed */
  alreadyExists: boolean;

  /** Python version installed */
  pythonVersion?: string;

  /** Full output from setup script */
  output?: string;
}

/**
 * Get the path to the Python setup script
 */
function getSetupScriptPath(packageRoot: string): string {
  return resolve(packageRoot, 'ee/python/setup.sh');
}

/**
 * Get the path to the Python virtual environment
 */
function getVenvPath(packageRoot: string): string {
  return resolve(packageRoot, 'ee/python/.venv');
}

/**
 * Check if Python environment is already set up
 */
export function isPythonEnvironmentSetup(packageRoot?: string): boolean {
  const root = packageRoot ?? getPackageRoot();
  const venvPath = getVenvPath(root);
  const pythonPath = join(venvPath, 'bin', 'python');

  return existsSync(venvPath) && existsSync(pythonPath);
}

/**
 * Set up the Python environment by running the setup script
 *
 * @param options - Setup configuration options
 * @returns Result of the setup operation
 *
 * @example
 * ```typescript
 * import { setupPythonEnvironment } from '@exulu/backend';
 *
 * // Basic usage
 * const result = await setupPythonEnvironment();
 * if (result.success) {
 *   console.log('Python environment ready!');
 * }
 *
 * // With options
 * const result = await setupPythonEnvironment({
 *   force: true,
 *   verbose: true
 * });
 * ```
 */
export async function setupPythonEnvironment(
  options: PythonSetupOptions = {}
): Promise<PythonSetupResult> {
  const {
    packageRoot = getPackageRoot(),
    force = false,
    verbose = false,
    timeout = 600000, // 10 minutes
  } = options;

  // Check if already set up (unless force is true)
  if (!force && isPythonEnvironmentSetup(packageRoot)) {
    if (verbose) {
      console.log('✓ Python environment already set up');
    }

    return {
      success: true,
      message: 'Python environment already exists',
      alreadyExists: true,
    };
  }

  // Find setup script
  const setupScriptPath = getSetupScriptPath(packageRoot);

  if (!existsSync(setupScriptPath)) {
    return {
      success: false,
      message: `Setup script not found at: ${setupScriptPath}`,
      alreadyExists: false,
    };
  }

  // Run setup script
  try {
    if (verbose) {
      console.log('Setting up Python environment...');
    }

    const { stdout, stderr } = await execAsync(`bash "${setupScriptPath}"`, {
      cwd: packageRoot,
      timeout,
      env: {
        ...process.env,
        // Ensure script can write to the directory
        PYTHONDONTWRITEBYTECODE: '1',
      },
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const output = stdout + stderr;

    // Extract Python version from output
    const versionMatch = output.match(/Python (\d+\.\d+\.\d+)/);
    const pythonVersion = versionMatch ? versionMatch[1] : undefined;

    if (verbose) {
      console.log(output);
    }

    return {
      success: true,
      message: 'Python environment set up successfully',
      alreadyExists: false,
      pythonVersion,
      output,
    };
  } catch (error: any) {
    const errorOutput = error.stdout + error.stderr;

    return {
      success: false,
      message: `Setup failed: ${error.message}`,
      alreadyExists: false,
      output: errorOutput,
    };
  }
}

/**
 * Get helpful setup instructions for users
 */
export function getPythonSetupInstructions(): string {
  return `
Python environment not set up. Please run one of the following:

Option 1 (Automatic):
  import { setupPythonEnvironment } from '@exulu/backend';
  await setupPythonEnvironment();

Option 2 (Manual - for package consumers):
  npx @exulu/backend setup-python

Option 3 (Manual - for contributors):
  npm run python:setup

Requirements:
  - Python 3.10 or higher must be installed
  - pip must be available

Installing Python:
  - macOS: brew install python@3.12
  - Ubuntu/Debian: sudo apt-get install python3.12
  - Windows: Download from https://www.python.org/downloads/
`.trim();
}

/**
 * Validate Python environment and provide helpful error messages
 *
 * @param packageRoot - Package root directory
 * @returns Object with validation status and message
 */
export async function validatePythonEnvironment(packageRoot?: string): Promise<{
  valid: boolean;
  message: string;
}> {
  const root = packageRoot ?? getPackageRoot();
  const venvPath = getVenvPath(root);
  const pythonPath = join(venvPath, 'bin', 'python');

  // Check if virtual environment exists
  if (!existsSync(venvPath)) {
    return {
      valid: false,
      message: getPythonSetupInstructions(),
    };
  }

  // Check if Python executable exists
  if (!existsSync(pythonPath)) {
    return {
      valid: false,
      message: 'Python virtual environment is corrupted. Please run:\n' +
               '  await setupPythonEnvironment({ force: true })',
    };
  }

  // Verify Python can execute
  try {
    await execAsync(`"${pythonPath}" --version`, { cwd: root });
    return {
      valid: true,
      message: 'Python environment is valid',
    };
  } catch {
    return {
      valid: false,
      message: 'Python executable is not working. Please run:\n' +
               '  await setupPythonEnvironment({ force: true })',
    };
  }
}
