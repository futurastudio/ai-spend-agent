import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  localAgentFinancialParserVersion,
  localAgentQualitativeParserVersion
} from "./localAgentLogs.js";
import type {
  LocalAgentFinancialIndexAdapter,
  LocalAgentFinancialIndexKey,
  LocalAgentQualitativeIndexAdapter,
  LocalAgentQualitativeIndexKey,
  LocalAgentQualitativeIndexValue,
  LocalAgentStreamCheckpointAdapter,
  LocalAgentStreamCheckpointRecord
} from "./localAgentLogs.js";
import {
  QualitativeIndexCacheError,
  cachedWindowCoversRequest,
  hasPrivatePermissions,
  invocationWindowCanBeNarrowedExactly,
  isNodeError,
  noFollowFlag,
  qualitativeEntryKeySchema,
  qualitativeEntryValueSchema,
  qualitativeKeyFingerprint,
  resolveCacheDirectory,
  sameQualitativeFileKey,
  stripRawPaths,
  syncDirectory,
  withWriterLock,
  type PersistedQualitativeKey,
  type QualitativeIndexCacheOptions
} from "./qualitativeIndexCache.js";

export const projectIndexStoreDirectoryName = "project-index-v2";
export const projectIndexStoreLockFileName = ".project-index-v2.lock";
/** One transcript's derived evidence, all windowed variants included. */
export const projectIndexMaxDocumentBytes = 8 * 1_024 * 1_024;
/** Null-window variant plus the newest bounded windows (BLOCKER-2 option i). */
export const projectIndexMaxWindowedVariants = 4;
export const projectIndexFinancialParserVersion = localAgentFinancialParserVersion;

/**
 * The financial value reuses the strict privacy-reduced v1 value contract.
 * Financial parses never carry invocation evidence; the schema keeps that
 * impossible rather than merely unexpected.
 */
const financialValueSchema = qualitativeEntryValueSchema.refine(
  (value) => value.invocationFile === undefined && value.invocationWindowProof === undefined,
  { message: "financial entries never carry invocation evidence" }
);

const financialKeySchema = z.object({
  schemaVersion: z.literal(2),
  section: z.literal("financial"),
  agent: z.enum(["claude-code", "codex", "gemini-cli"]),
  pathHash: z.string().regex(/^[a-f0-9]{64}$/),
  fileIdentity: z.string().min(11).max(256),
  financialParserVersion: z.literal(projectIndexFinancialParserVersion)
}).strict();

const qualitativeVariantSchema = z.object({
  key: qualitativeEntryKeySchema,
  storedAt: z.string().datetime({ offset: true }),
  value: qualitativeEntryValueSchema
}).strict();

const financialSectionSchema = z.object({
  key: financialKeySchema,
  storedAt: z.string().datetime({ offset: true }),
  value: financialValueSchema
}).strict();

/**
 * Header-pass ownership evidence (A4a consumer). "unknown" is a first-class
 * state: ownership is never guessed from hashes, basenames, or absence.
 */
const ownershipSchema = z.object({
  status: z.enum(["resolved", "no_calls", "unknown"]),
  /** Ownership binds to one exact file identity; rotation supersedes it. */
  fileIdentity: z.string().min(11).max(256),
  projectRefs: z.array(z.string().regex(/^avref_[a-f0-9]{64}$/)).max(64),
  headerAttribution: z.object({
    status: z.enum(["proven", "unknown"]),
    projectRef: z.string().regex(/^avref_[a-f0-9]{64}$/).optional(),
    /** Header subagent marker — a scheduling hint only, never ownership. */
    isSubagent: z.boolean().optional()
  }).strict().optional()
}).strict();

/**
 * Stream checkpoint envelope (design section e). The store validates the
 * envelope strictly and treats the reducer/collector payloads as opaque
 * bounded JSON: the loader owns their structure and re-validates on every
 * resume, so a malformed payload degrades to a restart, never a crash or a
 * reinterpretation. The parser version is pinned as a literal so checkpoints
 * from any other parser contract fail closed as misses.
 *
 * schemaVersion 2: version 1 checkpoints were written before prompt
 * survivors had absolute-path spans stripped, so raw local paths can sit in
 * their reducer state on disk. They are deliberately unreadable AND purged
 * on sight by the read path below — never resumed, never reinterpreted.
 */
const checkpointDocumentSchema = z.object({
  kind: z.literal("aibill.project_index_checkpoint"),
  schemaVersion: z.literal(2),
  agent: z.enum(["claude-code", "codex", "gemini-cli"]),
  pathHash: z.string().regex(/^[a-f0-9]{64}$/),
  storedAt: z.string().datetime({ offset: true }),
  checkpoint: z.object({
    pin: z.object({
      dev: z.number().finite(),
      ino: z.number().finite(),
      birthtimeMs: z.number().finite()
    }).strict(),
    parserVersion: z.literal(localAgentQualitativeParserVersion),
    collectInvocationEvidence: z.boolean(),
    sinceIso: z.string().datetime({ offset: true }).nullable(),
    offset: z.number().int().nonnegative(),
    prefixProbe: z.object({
      bytes: z.number().int().nonnegative().max(64 * 1_024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict(),
    reducerState: z.unknown(),
    collectorState: z.unknown().optional()
  }).strict()
}).strict();

const documentSchema = z.object({
  kind: z.literal("aibill.project_index_file"),
  schemaVersion: z.literal(2),
  agent: z.enum(["claude-code", "codex", "gemini-cli"]),
  pathHash: z.string().regex(/^[a-f0-9]{64}$/),
  qualitative: z.array(qualitativeVariantSchema).max(projectIndexMaxWindowedVariants),
  financial: financialSectionSchema.optional(),
  ownership: ownershipSchema.optional()
}).strict();

export type ProjectIndexDocument = z.infer<typeof documentSchema>;
export type ProjectIndexFinancialKey = z.infer<typeof financialKeySchema>;
export type ProjectIndexOwnership = z.infer<typeof ownershipSchema>;

export type ProjectIndexFinancialAdapter = LocalAgentFinancialIndexAdapter;

export type ProjectIndexAdapters = LocalAgentStreamCheckpointAdapter & {
  qualitative: LocalAgentQualitativeIndexAdapter;
  financial: ProjectIndexFinancialAdapter;
  readOwnership: (agent: ProjectIndexDocument["agent"], pathHash: string) => Promise<ProjectIndexOwnership | undefined>;
  writeOwnership: (
    agent: ProjectIndexDocument["agent"],
    pathHash: string,
    ownership: Readonly<ProjectIndexOwnership>
  ) => Promise<void>;
  /**
   * Orphan sweep with a freshness grace window. Full liveness-aware GC
   * priorities arrive with the coverage ledger.
   */
  collectGarbage: (options?: {
    retainPathHashes?: ReadonlySet<string>;
    graceMs?: number;
  }) => Promise<{ removed: number }>;
};

export const projectIndexGcGraceMs = 10 * 60 * 1_000;

/**
 * Sharded per-transcript store. Entry documents are lock-free: writes are
 * private O_EXCL temp files atomically renamed over the shard path, so readers
 * observe either complete version and concurrent same-key writers converge on
 * semantically identical content (storedAt may differ; last writer wins).
 * The writer lock guards only cross-document operations (GC).
 */
export function createProjectIndexAdapters(
  options: QualitativeIndexCacheOptions & {
    /**
     * Long-lived read-only consumers (the MCP server) must disable the
     * in-process document memo: they never write, so nothing would ever
     * invalidate a stale memoized document.
     */
    memoizeDocuments?: boolean;
  } = {}
): ProjectIndexAdapters {
  const memoize = options.memoizeDocuments !== false;
  const documents = new Map<string, Promise<ProjectIndexDocument | undefined>>();
  const invalidate = (cachePath: string) => documents.delete(cachePath);
  const document = (cachePath: string, storeRoot: string) => {
    if (!memoize) return readDocument(join(storeRoot, cachePath));
    let loaded = documents.get(cachePath);
    if (!loaded) {
      loaded = readDocument(join(storeRoot, cachePath)).catch((error: unknown) => {
        documents.delete(cachePath);
        throw error;
      });
      documents.set(cachePath, loaded);
    }
    return loaded;
  };

  // Resolve and validate the private cache directory once per adapter
  // instance, exactly like v1's memoized index load: the validation includes
  // git-privacy probes that spawn subprocesses, and repeating them for every
  // sharded document read multiplies a ~40 ms check into whole seconds.
  const resolvedRoots = new Map<"read" | "create", Promise<string>>();
  const storeRootFor = (create: boolean): Promise<string> => {
    const mode = create ? "create" : "read";
    let resolved = resolvedRoots.get(mode) ??
      (create ? resolvedRoots.get("read") : undefined);
    if (!resolved) {
      resolved = resolveCacheDirectory(create, options).then(async (cacheDirectory) => {
        const storeRoot = join(cacheDirectory, projectIndexStoreDirectoryName);
        if (create) await mkdir(join(storeRoot, "entries"), { recursive: true, mode: 0o700 });
        return storeRoot;
      }).catch((error: unknown) => {
        resolvedRoots.delete(mode);
        throw error;
      });
      resolvedRoots.set(mode, resolved);
      // A successful create-mode resolution satisfies read mode too.
      if (create) resolvedRoots.set("read", resolved);
    }
    return resolved;
  };
  const withStoreRoot = async <T>(
    create: boolean,
    operation: (storeRoot: string) => Promise<T>
  ): Promise<T> => operation(await storeRootFor(create));

  return {
    qualitative: {
      read: async (key) => {
        const parsedKey = parseQualitativeKey(key);
        return withStoreRoot(false, async (storeRoot) => {
          const doc = await document(shardPath(parsedKey.pathHash), storeRoot);
          if (!doc || doc.agent !== parsedKey.agent) return undefined;
          return selectQualitativeVariant(doc, parsedKey);
        }).catch(swallowMissingStore);
      },
      write: async (key, value) => {
        const parsedKey = parseQualitativeKey(key);
        const parsedValue = qualitativeEntryValueSchema.parse(stripRawPaths(value));
        assertQualitativeOwnershipInvariant(parsedKey, parsedValue);
        await withStoreRoot(true, async (storeRoot) => {
          const cachePath = shardPath(parsedKey.pathHash);
          // Read-modify-write must start from disk, not the in-process memo: a
          // concurrent process may have merged a variant since this process
          // last read. The residual race is one whole-document rename losing
          // to another (one variant lost, self-healed on the loser's next
          // parse) — the same accepted loss as concurrent v1 writers.
          const current = await readDocument(join(storeRoot, cachePath));
          const next = upsertQualitativeVariant(
            dropSupersededOwnership(
              baseDocument(current, parsedKey.agent, parsedKey.pathHash),
              parsedKey.fileIdentity
            ),
            { key: parsedKey, storedAt: new Date().toISOString(), value: parsedValue }
          );
          await writeDocument(join(storeRoot, cachePath), next);
          invalidate(cachePath);
        });
      }
    },
    financial: {
      read: async (key: Readonly<LocalAgentFinancialIndexKey>) => {
        const parsedKey = financialKeySchema.parse(key);
        return withStoreRoot(false, async (storeRoot) => {
          const doc = await document(shardPath(parsedKey.pathHash), storeRoot);
          if (!doc || doc.agent !== parsedKey.agent || !doc.financial) return undefined;
          const stored = doc.financial.key;
          if (stored.fileIdentity !== parsedKey.fileIdentity ||
              stored.financialParserVersion !== parsedKey.financialParserVersion) {
            return undefined;
          }
          // Deep-clone: callers may re-attach probed context to their copy;
          // the in-process memo must never observe those mutations.
          return structuredClone(doc.financial.value) as LocalAgentQualitativeIndexValue;
        }).catch(swallowMissingStore);
      },
      write: async (key: Readonly<LocalAgentFinancialIndexKey>, value) => {
        const parsedKey = financialKeySchema.parse(key);
        const parsedValue = financialValueSchema.parse(stripRawPaths(value));
        await withStoreRoot(true, async (storeRoot) => {
          const cachePath = shardPath(parsedKey.pathHash);
          const current = await readDocument(join(storeRoot, cachePath));
          const next: ProjectIndexDocument = {
            ...dropSupersededOwnership(
              baseDocument(current, parsedKey.agent, parsedKey.pathHash),
              parsedKey.fileIdentity
            ),
            financial: { key: parsedKey, storedAt: new Date().toISOString(), value: parsedValue }
          };
          await writeDocument(join(storeRoot, cachePath), documentSchema.parse(next));
          invalidate(cachePath);
        });
      }
    },
    readOwnership: async (agent, pathHash) =>
      withStoreRoot(false, async (storeRoot) => {
        const doc = await document(shardPath(assertPathHash(pathHash)), storeRoot);
        return doc && doc.agent === agent ? doc.ownership : undefined;
      }).catch(swallowMissingStore),
    writeOwnership: async (agent, pathHash, ownership) => {
      const parsedOwnership = ownershipSchema.parse(ownership);
      await withStoreRoot(true, async (storeRoot) => {
        const cachePath = shardPath(assertPathHash(pathHash));
        const current = await readDocument(join(storeRoot, cachePath));
        const next: ProjectIndexDocument = {
          ...baseDocument(current, agent, pathHash),
          ownership: parsedOwnership
        };
        await writeDocument(join(storeRoot, cachePath), documentSchema.parse(next));
        invalidate(cachePath);
      });
    },
    readStreamCheckpoint: async (agent, pathHash) =>
      withStoreRoot(false, async (storeRoot) => {
        const target = join(storeRoot, checkpointPath(assertPathHash(pathHash)));
        const outcome = await readCheckpointDocument(target);
        if (outcome.status === "invalid") {
          // Superseded (pre-sanitization) or corrupt checkpoints may hold
          // un-sanitized text: purge on sight. The stream restarts from byte
          // zero and rewrites its state under the current contract.
          await unlink(target).catch(() => undefined);
          return undefined;
        }
        if (outcome.status !== "valid") return undefined;
        const doc = outcome.doc;
        if (doc.agent !== agent || doc.pathHash !== pathHash) return undefined;
        return doc.checkpoint as LocalAgentStreamCheckpointRecord;
      }).catch(swallowMissingStore),
    writeStreamCheckpoint: async (agent, pathHash, checkpoint) => {
      const document = checkpointDocumentSchema.parse({
        kind: "aibill.project_index_checkpoint",
        schemaVersion: 2,
        agent,
        pathHash: assertPathHash(pathHash),
        storedAt: new Date().toISOString(),
        checkpoint
      });
      const contents = `${JSON.stringify(document)}\n`;
      if (Buffer.byteLength(contents, "utf8") > projectIndexMaxDocumentBytes) {
        throw new QualitativeIndexCacheError(
          "oversized",
          "Project index checkpoint exceeds its private bound."
        );
      }
      await withStoreRoot(true, async (storeRoot) => {
        const target = join(storeRoot, checkpointPath(pathHash));
        // Mirror readDocument's future-version guard: a newer process's
        // checkpoint is never clobbered by this writer (fail closed).
        if ((await readCheckpointDocument(target)).status === "future") {
          throw new QualitativeIndexCacheError(
            "unsupported_version",
            "Project index checkpoint was written by a newer aibill version."
          );
        }
        await writeJsonFileAtomically(target, contents);
      });
    },
    deleteStreamCheckpoint: async (agent, pathHash) => {
      void agent;
      await withStoreRoot(false, async (storeRoot) => {
        await unlink(join(storeRoot, checkpointPath(assertPathHash(pathHash))))
          .catch((error: unknown) => {
            if (!isNodeError(error, "ENOENT")) throw error;
          });
      }).catch(swallowMissingStore);
    },
    collectGarbage: async (gcOptions = {}) =>
      withWriterLock(options, async (cacheDirectory) => {
        // Orphan sweep with a freshness grace window: an unretained entry is
        // removed only when its last write is older than the grace period, so
        // a concurrent process's seconds-old work is never collected. Crash-
        // orphaned temp files are swept on the same aging rule; unexpected
        // litter is skipped, never fatal.
        const storeRoot = join(cacheDirectory, projectIndexStoreDirectoryName);
        const retain = gcOptions.retainPathHashes;
        if (!retain) return { removed: 0 };
        const graceMs = gcOptions.graceMs ?? projectIndexGcGraceMs;
        const cutoff = Date.now() - Math.max(0, graceMs);
        let removed = 0;
        const entriesRoot = join(storeRoot, "entries");
        const shards = await readdir(entriesRoot).catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) return [] as string[];
          throw error;
        });
        for (const shard of shards) {
          const shardDirectory = join(entriesRoot, shard);
          const files = await readdir(shardDirectory).catch(() => [] as string[]);
          for (const file of files) {
            const target = join(shardDirectory, file);
            const info = await lstat(target).catch(() => undefined);
            if (!info || !info.isFile() || info.mtimeMs > cutoff) continue;
            const isEntry = file.endsWith(".json");
            const isTemp = file.includes(".json.") && file.endsWith(".tmp");
            if (isEntry) {
              const pathHash = file.slice(0, -5);
              if (retain.has(pathHash)) continue;
            } else if (!isTemp) {
              continue;
            }
            const gone = await unlink(target).then(() => true).catch(() => false);
            if (!gone) continue;
            if (isEntry) {
              documents.delete(join("entries", shard, file));
              removed += 1;
            }
          }
        }
        // Checkpoints age out on the same retain/grace rule: an orphaned
        // checkpoint is a restart at worst, never lost complete evidence.
        const checkpointsRoot = join(storeRoot, "checkpoints");
        const checkpointFiles = await readdir(checkpointsRoot).catch(() => [] as string[]);
        for (const file of checkpointFiles) {
          const target = join(checkpointsRoot, file);
          const info = await lstat(target).catch(() => undefined);
          if (!info || !info.isFile() || info.mtimeMs > cutoff) continue;
          const isCheckpoint = file.endsWith(".json");
          const isTemp = file.includes(".json.") && file.endsWith(".tmp");
          if (isCheckpoint) {
            if (retain.has(file.slice(0, -5))) continue;
          } else if (!isTemp) {
            continue;
          }
          const gone = await unlink(target).then(() => true).catch(() => false);
          if (gone && isCheckpoint) removed += 1;
        }
        return { removed };
      }, projectIndexStoreLockFileName)
  };
}

/**
 * Ownership binds to one exact file identity; any write that observes a newer
 * identity drops the stale attribution rather than serving it (rotation-safe).
 */
function dropSupersededOwnership(
  doc: ProjectIndexDocument,
  fileIdentity: string
): ProjectIndexDocument {
  if (!doc.ownership || doc.ownership.fileIdentity === fileIdentity) return doc;
  const { ownership: _superseded, ...rest } = doc;
  return rest as ProjectIndexDocument;
}

/** Mirror v1's assertOwnership write guard: calls must belong to the keyed agent. */
function assertQualitativeOwnershipInvariant(
  key: PersistedQualitativeKey,
  value: z.infer<typeof qualitativeEntryValueSchema>
): void {
  if (value.calls.some((call) => call.agent !== key.agent)) {
    throw new QualitativeIndexCacheError(
      "invalid_value",
      "Project index calls do not belong to the keyed parser."
    );
  }
  if (value.invocationFile && (
    !key.collectInvocationEvidence || key.agent !== "codex" ||
    value.invocationFile.contextSignal.agent !== key.agent
  )) {
    throw new QualitativeIndexCacheError(
      "invalid_value",
      "Project index invocation evidence does not belong to the keyed parser window."
    );
  }
}

function baseDocument(
  current: ProjectIndexDocument | undefined,
  agent: ProjectIndexDocument["agent"],
  pathHash: string
): ProjectIndexDocument {
  if (current && current.agent === agent && current.pathHash === pathHash) return current;
  return {
    kind: "aibill.project_index_file",
    schemaVersion: 2,
    agent,
    pathHash,
    qualitative: []
  };
}

function selectQualitativeVariant(
  doc: ProjectIndexDocument,
  requestedKey: PersistedQualitativeKey
): LocalAgentQualitativeIndexValue | undefined {
  const fingerprint = qualitativeKeyFingerprint(requestedKey);
  const exact = doc.qualitative.find(
    (variant) => qualitativeKeyFingerprint(variant.key) === fingerprint
  );
  if (exact) return exact.value as LocalAgentQualitativeIndexValue;
  const compatible = doc.qualitative
    .filter((variant) => sameQualitativeFileKey(variant.key, requestedKey))
    .filter((variant) => cachedWindowCoversRequest(variant.key.sinceIso, requestedKey.sinceIso))
    .filter((variant) => invocationWindowCanBeNarrowedExactly(variant.key, variant.value, requestedKey))
    .sort((left, right) => (
      sinceSortValue(right.key.sinceIso) - sinceSortValue(left.key.sinceIso) ||
      right.storedAt.localeCompare(left.storedAt)
    ))[0];
  return compatible?.value as LocalAgentQualitativeIndexValue | undefined;
}

function upsertQualitativeVariant(
  current: ProjectIndexDocument,
  variant: z.infer<typeof qualitativeVariantSchema>
): ProjectIndexDocument {
  const fingerprint = qualitativeKeyFingerprint(variant.key);
  const retained = current.qualitative.filter((candidate) => {
    if (qualitativeKeyFingerprint(candidate.key) === fingerprint) return false;
    // A new file identity supersedes every variant of the old identity: the
    // transcript changed, so stale windows must never satisfy a future read.
    // Variants of the other invocation-evidence family are preserved
    // (superset-merge: one caller's write never clobbers the other's).
    return candidate.key.fileIdentity === variant.key.fileIdentity &&
      candidate.key.parserVersion === variant.key.parserVersion;
  });
  const bounded = [...retained, variant]
    .sort((left, right) => {
      // Deterministic retention: the null (widest) window outranks everything,
      // then newer windows outrank older ones.
      const leftNull = left.key.sinceIso === null ? 0 : 1;
      const rightNull = right.key.sinceIso === null ? 0 : 1;
      return leftNull - rightNull ||
        sinceSortValue(right.key.sinceIso) - sinceSortValue(left.key.sinceIso);
    })
    .slice(0, projectIndexMaxWindowedVariants);
  const preserved = bounded.some((candidate) =>
    qualitativeKeyFingerprint(candidate.key) === fingerprint
  )
    ? bounded
    : [variant, ...bounded.slice(0, projectIndexMaxWindowedVariants - 1)];
  return documentSchema.parse({ ...current, qualitative: preserved });
}

async function readDocument(filePath: string): Promise<ProjectIndexDocument | undefined> {
  // O_NOFOLLOW is 0 on win32; the explicit lstat keeps symlink fail-closed
  // behavior identical on every platform.
  const linkInfo = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!linkInfo) return undefined;
  if (linkInfo.isSymbolicLink()) {
    throw new QualitativeIndexCacheError("unsafe_file", "Project index entry is a symbolic link.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const opened = await handle.stat();
    if (!opened.isFile() || !hasPrivatePermissions(opened.mode)) {
      throw new QualitativeIndexCacheError("unsafe_file", "Project index entry is not a private regular file.");
    }
    if (opened.size > projectIndexMaxDocumentBytes) {
      throw new QualitativeIndexCacheError("oversized", "Project index entry exceeds its private bound.");
    }
    const bounded = Buffer.allocUnsafe(Number(opened.size));
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let value: unknown;
    try {
      value = JSON.parse(bounded.subarray(0, bytesRead).toString("utf8"));
    } catch {
      // Crash artifacts (zero-length or torn temp promoted by an interrupted
      // rename implementation) read as a miss, never as poison.
      return undefined;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const version = (value as Record<string, unknown>).schemaVersion;
      if (typeof version === "number" && version > 2) {
        // A newer store wrote this document. Fail closed instead of silently
        // clobbering a future format with a v2 rewrite.
        throw new QualitativeIndexCacheError(
          "unsupported_version",
          "Project index entry was written by a newer aibill version."
        );
      }
    }
    const parsed = documentSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    if (isNodeError(error, "ELOOP")) {
      throw new QualitativeIndexCacheError("unsafe_file", "Project index entry is a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDocument(filePath: string, doc: ProjectIndexDocument): Promise<void> {
  // Evict-to-fit: an oversized document sheds its oldest bounded windows
  // rather than becoming permanently uncacheable (v1 fitIndex semantics).
  let fitted = doc;
  let contents = `${JSON.stringify(fitted)}\n`;
  while (
    Buffer.byteLength(contents, "utf8") > projectIndexMaxDocumentBytes &&
    fitted.qualitative.length > 0
  ) {
    fitted = { ...fitted, qualitative: fitted.qualitative.slice(0, -1) };
    contents = `${JSON.stringify(fitted)}\n`;
  }
  if (Buffer.byteLength(contents, "utf8") > projectIndexMaxDocumentBytes) {
    throw new QualitativeIndexCacheError("oversized", "Project index entry exceeds its private bound.");
  }
  await writeJsonFileAtomically(filePath, contents);
}

/** fsync-before-rename atomic JSON write shared by entries and checkpoints. */
async function writeJsonFileAtomically(filePath: string, contents: string): Promise<void> {
  const directory = join(filePath, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    );
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Bounded, fail-closed checkpoint read. Crash artifacts (zero-length or torn
 * files) and schema/version mismatches read as a miss, forcing a restart —
 * never a partial or cross-version resume.
 */
type CheckpointReadOutcome =
  | { status: "missing" | "invalid" | "future" }
  | { status: "valid"; doc: z.infer<typeof checkpointDocumentSchema> };

async function readCheckpointDocument(filePath: string): Promise<CheckpointReadOutcome> {
  const linkInfo = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!linkInfo) return { status: "missing" };
  if (linkInfo.isSymbolicLink()) {
    throw new QualitativeIndexCacheError("unsafe_file", "Project index checkpoint is a symbolic link.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag());
    const opened = await handle.stat();
    if (!opened.isFile() || !hasPrivatePermissions(opened.mode)) {
      throw new QualitativeIndexCacheError("unsafe_file", "Project index checkpoint is not a private regular file.");
    }
    if (opened.size > projectIndexMaxDocumentBytes) {
      throw new QualitativeIndexCacheError("oversized", "Project index checkpoint exceeds its private bound.");
    }
    const bounded = Buffer.allocUnsafe(Number(opened.size));
    let bytesRead = 0;
    while (bytesRead < bounded.length) {
      const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let value: unknown;
    try {
      value = JSON.parse(bounded.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return { status: "invalid" };
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.kind === "aibill.project_index_checkpoint" &&
          typeof record.schemaVersion === "number" && record.schemaVersion > 2) {
        // A newer process owns this checkpoint: fail closed as a miss, but
        // never purge or clobber it.
        return { status: "future" };
      }
    }
    const parsed = checkpointDocumentSchema.safeParse(value);
    return parsed.success ? { status: "valid", doc: parsed.data } : { status: "invalid" };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    if (isNodeError(error, "ELOOP")) {
      throw new QualitativeIndexCacheError("unsafe_file", "Project index checkpoint is a symbolic link.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function checkpointPath(pathHash: string): string {
  return join("checkpoints", `${pathHash}.json`);
}

function shardPath(pathHash: string): string {
  return join("entries", pathHash.slice(0, 2), `${pathHash}.json`);
}

function parseQualitativeKey(key: Readonly<LocalAgentQualitativeIndexKey>): PersistedQualitativeKey {
  return qualitativeEntryKeySchema.parse(key);
}

function assertPathHash(pathHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(pathHash)) {
    throw new QualitativeIndexCacheError("invalid_key", "Project index path hash is not a sha256 hex digest.");
  }
  return pathHash;
}

function swallowMissingStore(error: unknown): undefined {
  if (isNodeError(error, "ENOENT")) return undefined;
  throw error;
}

function sinceSortValue(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}
