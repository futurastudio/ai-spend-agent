import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export type UsageSignalKind = "dependency" | "config" | "environment" | "source_code" | "provider_export" | "invoice";

export type UsageSignal = {
  provider: string;
  kind: UsageSignalKind;
  filePath: string;
  evidence: string;
  confidence: number;
};

export type LocalDiscoveryResult = {
  rootPath: string;
  scannedFiles: number;
  skippedDirectories: string[];
  /** Paths that could not be read (permissions, dangling symlinks, non-UTF8) — skipped, never fatal. */
  unreadablePaths: string[];
  signals: UsageSignal[];
  secretsDetected: string[];
  redactedEvidence: string[];
};

const skippedDirectoryNames = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".ssh",
  "Keychains"
]);

const maxFileBytes = 512_000;

const providerRules: Array<{
  provider: string;
  kind: UsageSignalKind;
  patterns: RegExp[];
  confidence: number;
}> = [
  { provider: "anthropic", kind: "dependency", patterns: [/@anthropic-ai\/sdk/, /anthropic/i], confidence: 0.9 },
  { provider: "langfuse", kind: "dependency", patterns: [/langfuse/i], confidence: 0.82 },
  { provider: "openai", kind: "dependency", patterns: [/"openai"\s*:/, /from\s+["']openai["']/, /OPENAI_API_KEY/], confidence: 0.9 },
  { provider: "vercel-ai-sdk", kind: "dependency", patterns: [/"ai"\s*:/, /from\s+["']ai["']/], confidence: 0.78 },
  { provider: "litellm", kind: "config", patterns: [/litellm/i, /model_list:/], confidence: 0.84 },
  { provider: "helicone", kind: "environment", patterns: [/HELICONE_API_KEY/, /helicone/i], confidence: 0.8 },
  { provider: "cursor", kind: "invoice", patterns: [/cursor/i], confidence: 0.76 },
  { provider: "replit", kind: "invoice", patterns: [/replit/i], confidence: 0.72 }
];

// Name-based redaction: any UPPER_SNAKE env-style assignment whose name ends
// in a secret-ish suffix. `KEY` deliberately subsumes API_KEY/ADMIN_KEY/etc —
// over-redacting a public key is harmless; leaking a private one is not.
const secretAssignmentPattern = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))\s*=\s*([^\s#"']+)/g;
// Value-based redaction: known secret shapes regardless of how they're named.
const providerSecretPatterns = [
  /sk-proj-[A-Za-z0-9_-]{20,}/g,
  /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /helicone_[A-Za-z0-9_-]{16,}/gi,
  // GitHub tokens: classic PATs, OAuth, server/user/refresh, fine-grained.
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // JWTs (three base64url segments).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key IDs.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitLab PATs and npm tokens.
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g
];

export async function scanLocalUsageSignals(rootPath: string): Promise<LocalDiscoveryResult> {
  const result: LocalDiscoveryResult = {
    rootPath,
    scannedFiles: 0,
    skippedDirectories: [],
    unreadablePaths: [],
    signals: [],
    secretsDetected: [],
    redactedEvidence: []
  };
  const secrets = new Set<string>();
  const skipped = new Set<string>();
  const unreadable = new Set<string>();

  await walk(rootPath, async (path) => {
    // A dangling symlink, permission-denied entry, or unreadable file must
    // never reject the whole scan — real machines are messy. Skip and report.
    let fileInfo;
    try {
      fileInfo = await stat(path);
    } catch {
      unreadable.add(path);
      return;
    }
    if (fileInfo.size > maxFileBytes || !isInterestingFile(path)) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      unreadable.add(path);
      return;
    }
    const redacted = redactSecrets(raw);
    const relativePath = relative(rootPath, path) || basename(path);
    result.scannedFiles += 1;

    for (const name of detectSecretNames(raw)) {
      secrets.add(name);
      result.redactedEvidence.push(`${relativePath}: ${name}=[REDACTED]`);
    }

    for (const signal of detectExportSignals(relativePath, redacted)) {
      result.signals.push(signal);
    }

    for (const rule of providerRules) {
      const matchedPattern = rule.patterns.find((pattern) => pattern.test(redacted));
      if (!matchedPattern) {
        continue;
      }

      const evidence = buildEvidence(relativePath, rule.provider, redacted);
      result.signals.push({
        provider: rule.provider,
        kind: inferKind(path, rule.kind),
        filePath: relativePath,
        evidence,
        confidence: rule.confidence
      });
    }
  }, skipped, unreadable);

  result.skippedDirectories = Array.from(skipped).sort();
  result.unreadablePaths = Array.from(unreadable)
    .map((path) => relative(rootPath, path) || basename(path))
    .sort();
  result.secretsDetected = Array.from(secrets).sort();
  result.signals = dedupeSignals(result.signals).sort((left, right) => {
    const provider = left.provider.localeCompare(right.provider);
    return provider === 0 ? left.filePath.localeCompare(right.filePath) : provider;
  });
  result.redactedEvidence = Array.from(new Set(result.redactedEvidence)).sort();
  return result;
}

export function redactSecrets(text: string): string {
  let redacted = text.replace(secretAssignmentPattern, (_match, key: string) => `${key}=[REDACTED]`);
  for (const pattern of providerSecretPatterns) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

function detectSecretNames(text: string): string[] {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(secretAssignmentPattern.source, secretAssignmentPattern.flags);
  while ((match = pattern.exec(text)) !== null) {
    names.add(match[1]!);
  }
  return Array.from(names);
}

async function walk(
  rootPath: string,
  visit: (path: string) => Promise<void>,
  skipped: Set<string>,
  unreadable: Set<string>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    // Permission-denied or vanished directory: skip it, keep scanning.
    unreadable.add(rootPath);
    return;
  }
  for (const entry of entries) {
    const path = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) {
        skipped.add(entry.name);
        continue;
      }
      await walk(path, visit, skipped, unreadable);
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      await visit(path);
    }
  }
}

function isInterestingFile(path: string): boolean {
  const name = basename(path);
  return (
    name === "package.json" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(ts|tsx|js|jsx|mjs|cjs|json|csv|ya?ml|toml|py|md|txt)$/i.test(name)
  );
}

function inferKind(path: string, fallback: UsageSignalKind): UsageSignalKind {
  const name = basename(path);
  if (name === ".env" || name.startsWith(".env.")) {
    return "environment";
  }
  if (/\.(ya?ml|toml)$/i.test(name)) {
    return "config";
  }
  if (/invoice|receipt|billing/i.test(name)) {
    return "invoice";
  }
  if (/usage|export|cost|spend/i.test(name) && /\.(csv|json)$/i.test(name)) {
    return "provider_export";
  }
  return fallback;
}

function detectExportSignals(filePath: string, redacted: string): UsageSignal[] {
  const lowerPath = filePath.toLowerCase();
  const lowerText = redacted.toLowerCase();
  const providers = ["openai", "anthropic", "cursor", "helicone", "langfuse", "gemini", "google", "replit"];
  const provider = providers.find((candidate) => lowerPath.includes(candidate) || lowerText.includes(candidate));
  if (!provider) {
    return [];
  }

  const isExport = /usage|export|cost|spend/.test(lowerPath) || /cost_usd|amount_usd|total_usd|input_tokens|output_tokens/.test(lowerText);
  const isInvoice = /invoice|receipt|billing/.test(lowerPath) || /total due|amount due|invoice/.test(lowerText);
  if (!isExport && !isInvoice) {
    return [];
  }

  const normalizedProvider = provider === "google" ? "gemini" : provider;
  const kind: UsageSignalKind = isInvoice ? "invoice" : "provider_export";
  return [{
    provider: normalizedProvider,
    kind,
    filePath,
    evidence: `${filePath}: detected ${normalizedProvider} ${kind.replace("_", " ")}`,
    confidence: isInvoice ? 0.82 : 0.88
  }];
}

function buildEvidence(filePath: string, provider: string, redacted: string): string {
  const line = redacted.split(/\r?\n/).find((candidate) => candidate.toLowerCase().includes(provider.split("-")[0]!));
  return line ? `${filePath}: ${line.trim()}` : `${filePath}: detected ${provider} usage signal`;
}

function dedupeSignals(signals: UsageSignal[]): UsageSignal[] {
  const byKey = new Map<string, UsageSignal>();
  for (const signal of signals) {
    const key = `${signal.provider}:${signal.filePath}:${signal.kind}`;
    if (!byKey.has(key)) {
      byKey.set(key, signal);
    }
  }
  return Array.from(byKey.values());
}
