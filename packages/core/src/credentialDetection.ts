import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local credential auto-detection.
 *
 * CRITICAL SAFETY CONTRACT: this module NEVER returns, stores, or prints a raw
 * secret value. It returns only:
 *   - the environment-variable NAME a key lives in (so callers can use the
 *     existing `env:NAME` reference pattern from sync-provider), and
 *   - a redacted last-4 hint for human recognition.
 * Raw values are read transiently to classify them and are never surfaced.
 */
export type DetectedCredential = {
  provider: "openai" | "anthropic";
  /** Reference usable with sync-provider, e.g. "env:OPENAI_API_KEY". */
  reference: string;
  /** The env var name the key was found in. */
  envName: string;
  /** Where we found it. */
  origin: "process_env" | "dotenv" | "shell_rc";
  /** Path of the file it was found in (for dotenv/shell_rc), redacted-safe. */
  filePath?: string;
  /** Redacted recognition hint, e.g. "sk-...­a1b2". Never the full key. */
  hint: string;
  /**
   * Whether this looks like it CAN return cost data. Regular API keys cannot:
   * all four providers gate cost/usage behind admin/owner credentials.
   */
  isLikelyAdminKey: boolean;
};

export type CredentialDetectionResult = {
  credentials: DetectedCredential[];
  /** Files scanned (paths only), for transparency / audit. */
  scannedFiles: string[];
};

type ProviderRule = {
  provider: DetectedCredential["provider"];
  /** Env var names that hold this provider's key. */
  envNames: string[];
  /** Pattern a value must match to count as this provider's key. */
  valuePattern: RegExp;
  /** Env var names that strongly imply an admin/owner key. */
  adminEnvHints: RegExp;
};

const providerRules: ProviderRule[] = [
  {
    provider: "openai",
    envNames: ["OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPENAI_KEY"],
    valuePattern: /^sk-[A-Za-z0-9_-]{16,}$/,
    adminEnvHints: /ADMIN|ORG|OWNER/i
  },
  {
    provider: "anthropic",
    envNames: ["ANTHROPIC_API_KEY", "ANTHROPIC_ADMIN_KEY", "ANTHROPIC_KEY"],
    valuePattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/,
    adminEnvHints: /ADMIN|ORG|OWNER/i
  }
];

const defaultShellRcFiles = [".zshrc", ".bashrc", ".bash_profile", ".profile"];

export type DetectCredentialsOptions = {
  /** Working directory to look for .env files in. */
  cwd?: string;
  /** Override process.env (used in tests). */
  env?: Record<string, string | undefined>;
  /** Home directory override (used in tests). */
  home?: string;
  /** Skip reading shell rc files (faster / sandbox-safe). */
  skipShellRc?: boolean;
};

export async function detectLocalCredentials(
  options: DetectCredentialsOptions = {}
): Promise<CredentialDetectionResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const scannedFiles: string[] = [];
  const byReference = new Map<string, DetectedCredential>();

  // 1) process.env (highest signal; already loaded in the user's shell).
  for (const rule of providerRules) {
    for (const envName of rule.envNames) {
      const value = env[envName];
      if (value && rule.valuePattern.test(value.trim())) {
        addCredential(byReference, {
          provider: rule.provider,
          reference: `env:${envName}`,
          envName,
          origin: "process_env",
          hint: redactHint(value.trim()),
          isLikelyAdminKey: rule.adminEnvHints.test(envName)
        });
      }
    }
  }

  // 2) .env files in the working directory.
  const dotenvCandidates = [".env", ".env.local"];
  for (const fileName of dotenvCandidates) {
    const filePath = join(cwd, fileName);
    const parsed = await readEnvFile(filePath);
    if (parsed) {
      scannedFiles.push(filePath);
      collectFromAssignments(byReference, parsed, "dotenv", filePath);
    }
  }

  // 3) Shell rc files (export FOO=bar lines).
  if (!options.skipShellRc) {
    for (const fileName of defaultShellRcFiles) {
      const filePath = join(home, fileName);
      const parsed = await readEnvFile(filePath);
      if (parsed) {
        scannedFiles.push(filePath);
        collectFromAssignments(byReference, parsed, "shell_rc", filePath);
      }
    }
  }

  return {
    credentials: [...byReference.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.reference.localeCompare(right.reference)
    ),
    scannedFiles
  };
}

function collectFromAssignments(
  byReference: Map<string, DetectedCredential>,
  assignments: Map<string, string>,
  origin: DetectedCredential["origin"],
  filePath: string
): void {
  for (const rule of providerRules) {
    for (const envName of rule.envNames) {
      const value = assignments.get(envName);
      if (value && rule.valuePattern.test(value)) {
        addCredential(byReference, {
          provider: rule.provider,
          reference: `env:${envName}`,
          envName,
          origin,
          filePath,
          hint: redactHint(value),
          isLikelyAdminKey: rule.adminEnvHints.test(envName)
        });
      }
    }
  }
}

/** Prefer the highest-signal origin (process_env) when the same ref appears twice. */
function addCredential(map: Map<string, DetectedCredential>, credential: DetectedCredential): void {
  const existing = map.get(credential.reference);
  if (!existing || originRank(credential.origin) < originRank(existing.origin)) {
    map.set(credential.reference, credential);
  }
}

function originRank(origin: DetectedCredential["origin"]): number {
  return origin === "process_env" ? 0 : origin === "dotenv" ? 1 : 2;
}

async function readEnvFile(path: string): Promise<Map<string, string> | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const assignments = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    // Handles `FOO=bar`, `export FOO=bar`, and quoted values.
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const name = match[1]!;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Strip inline comments on unquoted values.
    value = value.replace(/\s+#.*$/, "").trim();
    if (value) {
      assignments.set(name, value);
    }
  }
  return assignments;
}

/** Returns a recognition hint that never exposes the secret, e.g. "sk-...­f0a2". */
function redactHint(value: string): string {
  const prefix = value.slice(0, 3);
  const suffix = value.length >= 4 ? value.slice(-4) : "";
  return `${prefix}...${suffix}`;
}
