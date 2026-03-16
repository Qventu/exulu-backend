/**
 * Python Script Executor Utility
 *
 * Provides a type-safe interface for executing Python scripts from TypeScript.
 * Automatically handles virtual environment activation and error handling.
 *
 * @example
 * ```typescript
 * import { executePythonScript } from './utils/python-executor';
 *
 * const result = await executePythonScript({
 *   scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
 *   args: ['/path/to/document.pdf', '-o', '/path/to/output.json'],
 *   cwd: process.cwd()
 * });
 * ```
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve, join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { validatePythonEnvironment } from './python-setup';

const execAsync = promisify(exec);

/**
 * Get the package root directory (where this package is installed)
 */
function getPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let currentDir = dirname(currentFile);

  // Walk up the directory tree to find package.json
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const packageJsonPath = join(currentDir, 'package.json');

    if (existsSync(packageJsonPath)) {
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
      break;
    }
    currentDir = parentDir;
    attempts++;
  }

  // Fallback
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

/**
 * Configuration for executing a Python script
 */
export interface PythonScriptConfig {
  /**
   * Path to the Python script (relative to package root or absolute)
   * @example 'ee/python/documents/processing/document_to_markdown.py'
   */
  scriptPath: string;

  /**
   * Command-line arguments to pass to the script
   * @example ['/path/to/file.pdf', '-o', '/output/path']
   */
  args?: string[];

  /**
   * Package root directory (where @exulu/backend is installed)
   * @default Auto-detected from package location
   */
  packageRoot?: string;

  /**
   * Working directory for script execution (for resolving relative paths in args)
   * @default process.cwd()
   */
  cwd?: string;

  /**
   * Timeout in milliseconds (0 for no timeout)
   * @default 300000 (5 minutes)
   */
  timeout?: number;

  /**
   * Environment variables to pass to the script
   */
  env?: Record<string, string>;

  /**
   * Whether to validate the Python environment before execution
   * @default true
   */
  validateEnvironment?: boolean;
}

/**
 * Result of Python script execution
 */
export interface PythonScriptResult {
  /** Standard output from the script */
  stdout: string;

  /** Standard error from the script */
  stderr: string;

  /** Exit code of the script */
  exitCode: number;

  /** Whether the script executed successfully */
  success: boolean;
}

/**
 * Error thrown when Python environment is not set up
 */
export class PythonEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PythonEnvironmentError';
  }
}

/**
 * Error thrown when Python script execution fails
 */
export class PythonExecutionError extends Error {
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number;

  constructor(message: string, stdout: string, stderr: string, exitCode: number) {
    super(message);
    this.name = 'PythonExecutionError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Get the path to the Python virtual environment
 */
function getVenvPath(packageRoot: string): string {
  return resolve(packageRoot, 'ee/python/.venv');
}

/**
 * Get the Python executable path from the virtual environment
 */
function getPythonExecutable(packageRoot: string): string {
  const venvPath = getVenvPath(packageRoot);
  return join(venvPath, 'bin', 'python');
}

/**
 * Validate that the Python environment is set up correctly
 */
async function validatePythonEnvironmentForExecution(packageRoot: string): Promise<void> {
  const validation = await validatePythonEnvironment(packageRoot);

  if (!validation.valid) {
    throw new PythonEnvironmentError(validation.message);
  }
}

/**
 * Execute a Python script with the configured virtual environment
 *
 * @param config - Configuration for script execution
 * @returns Result of the script execution
 * @throws {PythonEnvironmentError} If Python environment is not set up
 * @throws {PythonExecutionError} If script execution fails
 *
 * @example
 * ```typescript
 * // Convert a PDF to markdown
 * const result = await executePythonScript({
 *   scriptPath: 'ee/python/documents/processing/document_to_markdown.py',
 *   args: [
 *     '/path/to/document.pdf',
 *     '-o', '/path/to/output.json',
 *     '--images-dir', '/path/to/images'
 *   ]
 * });
 *
 * if (result.success) {
 *   console.log('Conversion successful!');
 *   const outputData = JSON.parse(result.stdout);
 * }
 * ```
 */
export async function executePythonScript(
  config: PythonScriptConfig
): Promise<PythonScriptResult> {
  const {
    scriptPath,
    args = [],
    packageRoot = getPackageRoot(),
    cwd = process.cwd(),
    timeout = 300000, // 5 minutes default
    env = {},
    validateEnvironment = true,
  } = config;

  // Validate environment if requested
  if (validateEnvironment) {
    await validatePythonEnvironmentForExecution(packageRoot);
  }

  // Resolve script path (relative to package root, not cwd)
  const resolvedScriptPath = resolve(packageRoot, scriptPath);

  // Check if script exists
  if (!existsSync(resolvedScriptPath)) {
    throw new PythonExecutionError(
      `Python script not found: ${resolvedScriptPath}`,
      '',
      '',
      1
    );
  }

  // Get Python executable from package
  const pythonExecutable = getPythonExecutable(packageRoot);

  // Build command
  const quotedArgs = args.map(arg => {
    // Quote arguments that contain spaces
    return arg.includes(' ') ? `"${arg}"` : arg;
  });
  const command = `${pythonExecutable} "${resolvedScriptPath}" ${quotedArgs.join(' ')}`;

  // Execute script
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      env: {
        ...process.env,
        ...env,
        // Ensure Python doesn't write bytecode files
        PYTHONDONTWRITEBYTECODE: '1',
      },
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for output (increased from 10MB)
    });

    return {
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      success: true,
    };
  } catch (error: any) {
    const stdout = error.stdout?.toString() ?? '';
    const stderr = error.stderr?.toString() ?? '';
    const exitCode = error.code ?? 1;

    // Create a detailed error message that includes both stdout and stderr
    let errorMessage = `Python script execution failed: ${error.message}`;

    if (stderr) {
      errorMessage += `\n\nStderr:\n${stderr}`;
    }

    if (stdout) {
      errorMessage += `\n\nStdout:\n${stdout}`;
    }

    // Add the command that was executed for debugging
    errorMessage += `\n\nCommand executed:\n${command}`;

    throw new PythonExecutionError(
      errorMessage,
      stdout,
      stderr,
      exitCode
    );
  }
}

/**
 * Execute a Python script and return only stdout
 * Throws an error if execution fails
 *
 * @param config - Configuration for script execution
 * @returns Standard output from the script
 */
export async function executePythonScriptSimple(
  config: PythonScriptConfig
): Promise<string> {
  const result = await executePythonScript(config);
  return result.stdout;
}

/**
 * Check if Python environment is set up and ready
 *
 * @param packageRoot - Package root directory (auto-detected if not provided)
 * @returns true if environment is ready, false otherwise
 */
export async function isPythonEnvironmentReady(packageRoot?: string): Promise<boolean> {
  const validation = await validatePythonEnvironment(packageRoot);
  return validation.valid;
}
