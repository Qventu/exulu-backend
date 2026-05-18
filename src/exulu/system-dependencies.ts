import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Per-dependency probe descriptor. Two kinds today:
 *   - `binary`:     looked up on PATH via `command -v`. Use for executables.
 *   - `npm-global`: looked up under `npm root -g`. Use for libraries the
 *                   skill scripts `require()` at runtime, like `docx`.
 *
 * Add new kinds (e.g. `python-package` for `defusedxml`) by extending this
 * union and the dispatch in `probeDependency`.
 */
export type DependencyCheck =
  | { kind: "binary"; binary: string }
  | { kind: "npm-global"; packageName: string };

export interface SystemDependency {
  /** How to detect whether this dependency is installed. */
  check: DependencyCheck;
  /** Human-readable name surfaced in logs/errors. */
  displayName: string;
  /** Which feature / skill needs it, so users know why it matters. */
  purpose: string;
  /** Per-OS install hints, used in warning and error messages. */
  installHints: {
    debian: string;
    macos: string;
  };
}

/**
 * System dependencies required by built-in skills (currently: docx). Probed
 * at ExuluApp.create time so missing deps surface at server startup rather
 * than at first skill invocation.
 *
 * Adding a new dependency here: append a SystemDependency entry. The
 * Dockerfiles in example/, demo/, and selise/ are the source of truth for
 * which packages provide each on Debian.
 */
export const REQUIRED_SYSTEM_DEPENDENCIES: SystemDependency[] = [
  {
    check: { kind: "binary", binary: "pandoc" },
    displayName: "Pandoc",
    purpose: "docx skill: text extraction and tracked-changes conversion",
    installHints: {
      debian: "apt-get install -y pandoc",
      macos: "brew install pandoc",
    },
  },
  {
    check: { kind: "binary", binary: "soffice" },
    displayName: "LibreOffice",
    purpose: "docx skill: converting .docx documents to PDF for visual analysis",
    installHints: {
      debian: "apt-get install -y libreoffice",
      macos: "brew install --cask libreoffice",
    },
  },
  {
    check: { kind: "binary", binary: "pdftoppm" },
    displayName: "Poppler (pdftoppm)",
    purpose: "docx skill: converting PDF pages to images",
    installHints: {
      debian: "apt-get install -y poppler-utils",
      macos: "brew install poppler",
    },
  },
  {
    check: { kind: "npm-global", packageName: "docx" },
    displayName: "docx (npm global)",
    purpose: "docx skill: programmatically constructing new .docx documents",
    installHints: {
      debian: "npm install -g docx",
      macos: "npm install -g docx",
    },
  },
];

export interface SystemDependencyCheckResult {
  missing: SystemDependency[];
}

/**
 * Memoized `npm root -g` result. Spawning npm is slow (~200ms+) and
 * idempotent — looking it up once at startup is enough for all npm-global
 * probes that follow.
 */
let cachedNpmGlobalRoot: string | null | undefined;

/**
 * Resolve and memoize the global `node_modules` directory (i.e. the value of
 * `npm root -g`). Exposed so other modules (notably the skill sandbox) can
 * inject this path into NODE_PATH and into the sandbox's allowRead list when
 * running scripts that depend on globally-installed packages like `docx`.
 *
 * Returns `null` if `npm root -g` fails for any reason (npm missing, etc.).
 */
export async function getNpmGlobalRoot(): Promise<string | null> {
  if (cachedNpmGlobalRoot !== undefined) return cachedNpmGlobalRoot;
  try {
    const { stdout } = await execAsync("npm root -g", { shell: "/bin/sh" });
    cachedNpmGlobalRoot = stdout.trim() || null;
  } catch {
    cachedNpmGlobalRoot = null;
  }
  return cachedNpmGlobalRoot;
}

async function probeDependency(dep: SystemDependency): Promise<boolean> {
  switch (dep.check.kind) {
    case "binary": {
      try {
        await execAsync(`command -v ${dep.check.binary}`, { shell: "/bin/sh" });
        return true;
      } catch {
        return false;
      }
    }
    case "npm-global": {
      const root = await getNpmGlobalRoot();
      if (!root) return false;
      // A globally-installed npm package places its package.json at
      // <npm root -g>/<packageName>/package.json. existsSync on the
      // directory is enough — npm always materializes the folder.
      return existsSync(join(root, dep.check.packageName));
    }
  }
}

/**
 * Returns the list of required system dependencies that are not available.
 * Empty `missing` array means everything is present.
 */
export async function checkSystemDependencies(): Promise<SystemDependencyCheckResult> {
  const probes = await Promise.all(
    REQUIRED_SYSTEM_DEPENDENCIES.map(async (dep) => ({
      dep,
      present: await probeDependency(dep),
    })),
  );

  return {
    missing: probes.filter((p) => !p.present).map((p) => p.dep),
  };
}

function formatMissing(dep: SystemDependency): string {
  const probeLabel =
    dep.check.kind === "binary"
      ? dep.check.binary
      : `npm:${dep.check.packageName} (global)`;
  return (
    `  - ${dep.displayName} (${probeLabel}) — ${dep.purpose}\n` +
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
