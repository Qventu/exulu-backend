import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface SystemDependency {
  /** The binary name probed via `command -v`. */
  binary: string;
  /** Human-readable name surfaced in logs/errors. */
  displayName: string;
  /** Which feature / skill needs this binary, so users know why it matters. */
  purpose: string;
  /** Per-OS install hints, used in warning and error messages. */
  installHints: {
    debian: string;
    macos: string;
  };
}

/**
 * System binaries required by built-in skills (currently: docx). Probed at
 * ExuluApp.create time so missing dependencies surface immediately at server
 * startup rather than at first skill invocation.
 *
 * Adding a new dependency here: append a SystemDependency entry. The check
 * walks this list and the Dockerfiles in example/, demo/, and selise/ are the
 * source of truth for which packages provide each binary on Debian.
 */
export const REQUIRED_SYSTEM_DEPENDENCIES: SystemDependency[] = [
  {
    binary: "pandoc",
    displayName: "Pandoc",
    purpose: "docx skill: text extraction and tracked-changes conversion",
    installHints: {
      debian: "apt-get install -y pandoc",
      macos: "brew install pandoc",
    },
  },
  {
    binary: "soffice",
    displayName: "LibreOffice",
    purpose: "docx skill: converting .docx documents to PDF for visual analysis",
    installHints: {
      debian: "apt-get install -y libreoffice",
      macos: "brew install --cask libreoffice",
    },
  },
  {
    binary: "pdftoppm",
    displayName: "Poppler (pdftoppm)",
    purpose: "docx skill: converting PDF pages to images",
    installHints: {
      debian: "apt-get install -y poppler-utils",
      macos: "brew install poppler",
    },
  },
];

export interface SystemDependencyCheckResult {
  missing: SystemDependency[];
}

/**
 * Returns the list of required system dependencies that are not on PATH.
 * Empty `missing` array means everything is available.
 *
 * Uses `command -v` (POSIX) rather than `which` for portability across
 * Debian-slim base images that may not ship `which` by default.
 */
export async function checkSystemDependencies(): Promise<SystemDependencyCheckResult> {
  const probes = await Promise.all(
    REQUIRED_SYSTEM_DEPENDENCIES.map(async (dep) => {
      try {
        await execAsync(`command -v ${dep.binary}`, { shell: "/bin/sh" });
        return { dep, present: true };
      } catch {
        return { dep, present: false };
      }
    }),
  );

  return {
    missing: probes.filter((p) => !p.present).map((p) => p.dep),
  };
}

function formatMissing(dep: SystemDependency): string {
  return (
    `  - ${dep.displayName} (${dep.binary}) — ${dep.purpose}\n` +
    `      Debian/Ubuntu: ${dep.installHints.debian}\n` +
    `      macOS:        ${dep.installHints.macos}`
  );
}

/**
 * Probes system deps and either logs a warning or throws, depending on
 * `requireSystemDependencies`. Always logs the same diagnostic — the only
 * difference is the final fail-fast.
 */
export async function reportSystemDependencies(opts: {
  requireSystemDependencies: boolean;
}): Promise<void> {
  const { missing } = await checkSystemDependencies();
  if (missing.length === 0) return;

  const body =
    `${missing.length} system dependency check(s) failed:\n` +
    missing.map(formatMissing).join("\n");

  if (opts.requireSystemDependencies) {
    throw new Error(
      `[EXULU] Required system dependencies are missing. ` +
        `Install them and restart, or set requireSystemDependencies=false in ExuluConfig to downgrade to a warning.\n${body}`,
    );
  }

  console.warn(
    `[EXULU] ${body}\n` +
      `        Set requireSystemDependencies=true in ExuluConfig to make this fatal at startup.`,
  );
}
