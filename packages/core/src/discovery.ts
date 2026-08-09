import { lstat, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";
import { resolveSafeScanRoot } from "./scanGuard.js";

export type UsageSignalKind = "dependency" | "config" | "environment" | "source_code" | "provider_export" | "invoice";

export type UsageSignal = {
  provider: string;
  kind: UsageSignalKind;
  /** Deterministic opaque reference; never a repository-controlled filename. */
  filePath: string;
  /** Stable rule identity; present on scanner-produced signals. */
  ruleId?: string;
  /** Structured, non-content evidence; present on scanner-produced signals. */
  evidenceMeta?: UsageSignalEvidence;
  /** JSON encoding of evidenceMeta retained for registry/backward compatibility. */
  evidence: string;
  confidence: number;
};

export type UsageSignalEvidence = {
  /** Same deterministic opaque reference as UsageSignal.filePath. */
  file: string;
  provider: string;
  signal: UsageSignalKind;
  ruleId: string;
};

export type LocalDiscoveryResult = {
  rootPath: string;
  scannedFiles: number;
  /** Deterministic opaque references for denied/heavy descendant directories. */
  skippedDirectories: string[];
  /** Opaque references for symbolic links below the approved root. They are never followed. */
  skippedSymlinks: string[];
  /** Opaque references for unreadable descendants — skipped, never fatal. */
  unreadablePaths: string[];
  signals: UsageSignal[];
  /** Deterministic opaque references for detected secret assignments. */
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
  ".ai-spend-agent",
  ".ssh",
  "Keychains"
]);

const maxFileBytes = 512_000;

const providerRules: Array<{
  id: string;
  provider: string;
  kind: UsageSignalKind;
  patterns: RegExp[];
  confidence: number;
}> = [
  { id: "provider.anthropic.dependency", provider: "anthropic", kind: "dependency", patterns: [/@anthropic-ai\/sdk/, /anthropic/i], confidence: 0.9 },
  { id: "provider.langfuse.dependency", provider: "langfuse", kind: "dependency", patterns: [/langfuse/i], confidence: 0.82 },
  { id: "provider.openai.dependency", provider: "openai", kind: "dependency", patterns: [/"openai"\s*:/, /from\s+["']openai["']/, /OPENAI_API_KEY/], confidence: 0.9 },
  { id: "provider.vercel-ai-sdk.dependency", provider: "vercel-ai-sdk", kind: "dependency", patterns: [/"ai"\s*:/, /from\s+["']ai["']/], confidence: 0.78 },
  { id: "provider.litellm.config", provider: "litellm", kind: "config", patterns: [/litellm/i, /model_list:/], confidence: 0.84 },
  { id: "provider.helicone.environment", provider: "helicone", kind: "environment", patterns: [/HELICONE_API_KEY/, /helicone/i], confidence: 0.8 },
  { id: "provider.cursor.invoice", provider: "cursor", kind: "invoice", patterns: [/cursor/i], confidence: 0.76 },
  { id: "provider.replit.invoice", provider: "replit", kind: "invoice", patterns: [/replit/i], confidence: 0.72 }
];

// Name-based redaction: any UPPER_SNAKE env-style assignment whose name ends
// in a secret-ish suffix. `KEY` deliberately subsumes API_KEY/ADMIN_KEY/etc —
// over-redacting a public key is harmless; leaking a private one is not.
const secretAssignmentPattern = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))\s*(?:=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s#]+)/g;
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
  const canonicalRoot = await resolveSafeScanRoot(rootPath);
  const result: LocalDiscoveryResult = {
    rootPath: canonicalRoot,
    scannedFiles: 0,
    skippedDirectories: [],
    skippedSymlinks: [],
    unreadablePaths: [],
    signals: [],
    secretsDetected: [],
    redactedEvidence: []
  };
  const secrets = new Set<string>();
  const skipped = new Set<string>();
  const symlinks = new Set<string>();
  const unreadable = new Set<string>();

  await walk(canonicalRoot, async (path) => {
    // A permission-denied, vanished, or unreadable file must never reject the
    // whole scan — real machines are messy. Symlinks are handled by walk and
    // never reach this callback.
    let fileInfo;
    try {
      fileInfo = await lstat(path);
    } catch {
      unreadable.add(path);
      return;
    }
    if (fileInfo.isSymbolicLink()) {
      symlinks.add(path);
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
    const relativePath = relative(canonicalRoot, path) || ".";
    const pathReference = opaquePathReference(relativePath);
    result.scannedFiles += 1;

    for (const name of detectSecretNames(raw)) {
      const secretReference = opaqueSecretReference(name);
      secrets.add(secretReference);
      result.redactedEvidence.push(`${pathReference}: ${secretReference}=[REDACTED]`);
    }

    for (const signal of detectExportSignals(relativePath, redacted, pathReference)) {
      result.signals.push(signal);
    }

    for (const rule of providerRules) {
      const matchedPattern = rule.patterns.find((pattern) => pattern.test(redacted));
      if (!matchedPattern) {
        continue;
      }

      const kind = inferKind(path, rule.kind);
      const evidenceMeta = buildEvidence(pathReference, rule.provider, kind, rule.id);
      result.signals.push({
        provider: rule.provider,
        kind,
        filePath: pathReference,
        ruleId: rule.id,
        evidenceMeta,
        evidence: encodeEvidence(evidenceMeta),
        confidence: rule.confidence
      });
    }
  }, skipped, symlinks, unreadable);

  result.skippedDirectories = Array.from(skipped)
    .map((path) => opaquePathReference(relative(canonicalRoot, path) || "."))
    .sort();
  result.skippedSymlinks = Array.from(symlinks)
    .map((path) => opaquePathReference(relative(canonicalRoot, path) || "."))
    .sort();
  result.unreadablePaths = Array.from(unreadable)
    .map((path) => opaquePathReference(relative(canonicalRoot, path) || "."))
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
  symlinks: Set<string>,
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
    if (entry.isSymbolicLink()) {
      symlinks.add(path);
      continue;
    }
    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) {
        skipped.add(path);
        continue;
      }
      await walk(path, visit, skipped, symlinks, unreadable);
      continue;
    }

    if (entry.isFile()) {
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

function detectExportSignals(
  filePath: string,
  redacted: string,
  pathReference: string
): UsageSignal[] {
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
  const ruleId = `export.${normalizedProvider}.${kind}`;
  const evidenceMeta = buildEvidence(pathReference, normalizedProvider, kind, ruleId);
  return [{
    provider: normalizedProvider,
    kind,
    filePath: pathReference,
    ruleId,
    evidenceMeta,
    evidence: encodeEvidence(evidenceMeta),
    confidence: isInvoice ? 0.82 : 0.88
  }];
}

function buildEvidence(
  file: string,
  provider: string,
  signal: UsageSignalKind,
  ruleId: string
): UsageSignalEvidence {
  return { file, provider, signal, ruleId };
}

function encodeEvidence(evidence: UsageSignalEvidence): string {
  return JSON.stringify(evidence);
}

/**
 * Repository-controlled descendant names are untrusted metadata. Discovery may
 * use the real relative path internally for classification, but persisted and
 * agent-facing output receives only this stable, non-semantic reference.
 */
function opaquePathReference(relativePath: string): string {
  // Normalize only the current platform's separator. A literal backslash is
  // a valid POSIX filename character and must not alias a nested POSIX path.
  const normalized = (relativePath || ".").split(sep).join("/");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `path-${digest}`;
}

/** Repository-controlled environment names are untrusted metadata too. */
function opaqueSecretReference(name: string): string {
  const digest = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16);
  return `secret-${digest}`;
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
