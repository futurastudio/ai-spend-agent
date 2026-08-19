import {
  parseClaudeCodeTranscript,
  parseCodexRollout,
  readClaudeCodeFinancialFileForRegistry,
  readCodexFinancialFileForRegistry,
  readGeminiFinancialFileForRegistry
} from "../localAgentLogs.js";
import { createCodexInvocationCollector } from "../toolInvocations.js";
import { localAgentFormatDescriptors, validateLocalAgentFormatDescriptors } from "./registry.js";
import type { LocalAgentFormatRuntime } from "./types.js";
import { parseGeminiSession } from "./gemini.js";

const byId = new Map(localAgentFormatDescriptors.map((descriptor) => [descriptor.id, descriptor]));
const claudeCode = byId.get("claude-code");
const codex = byId.get("codex");
const geminiCli = byId.get("gemini-cli");
if (!claudeCode || !codex || !geminiCli) {
  throw new Error("Built-in local-agent format descriptors are incomplete.");
}

validateLocalAgentFormatDescriptors();

const runtimes: LocalAgentFormatRuntime[] = [
  {
    descriptor: claudeCode,
    parseFull: ({ content, filePath, sinceMs, onDiagnostic }) => ({
      calls: parseClaudeCodeTranscript(content, filePath, sinceMs, onDiagnostic)
    }),
    parseFinancialFile: readClaudeCodeFinancialFileForRegistry
  },
  {
    descriptor: codex,
    parseFull: ({
      content,
      sinceMs,
      collectInvocationEvidence,
      onDiagnostic
    }) => {
      const collector = collectInvocationEvidence
        ? createCodexInvocationCollector(sinceMs)
        : undefined;
      const calls = parseCodexRollout(content, collector?.consume, onDiagnostic);
      const invocationFile = collector?.finish();
      return {
        calls,
        ...(invocationFile ? { invocationFile } : {}),
        ...(collector ? { invocationWindowProof: collector.windowProof() } : {})
      };
    },
    parseFinancialFile: readCodexFinancialFileForRegistry
  },
  {
    descriptor: geminiCli,
    parseFull: ({ content, filePath, sinceMs, onDiagnostic }) => {
      const parsed = parseGeminiSession(content, {
        filePath,
        ...(sinceMs !== undefined ? { sinceMs } : {})
      });
      for (const diagnostic of parsed.diagnostics) {
        onDiagnostic({
          code: diagnostic.code === "malformed_jsonl"
            ? "malformed_jsonl"
            : diagnostic.code === "unsupported_token_shape"
              ? "unsupported_token_shape"
              : "malformed_session_file",
          count: diagnostic.count
        });
      }
      return { calls: parsed.calls };
    },
    parseFinancialFile: readGeminiFinancialFileForRegistry
  }
];

export const localAgentFormatRuntimeRegistry: readonly LocalAgentFormatRuntime[] =
  Object.freeze(runtimes.map((runtime) => Object.freeze(runtime)));

export function validateLocalAgentFormatRuntimeRegistry(
  registry: readonly LocalAgentFormatRuntime[] = localAgentFormatRuntimeRegistry,
  descriptors = localAgentFormatDescriptors
): void {
  validateLocalAgentFormatDescriptors(registry.map((entry) => entry.descriptor));
  const expected = [...registry].sort((left, right) => (
    left.descriptor.order - right.descriptor.order
  ));
  if (expected.some((entry, index) => entry !== registry[index])) {
    throw new Error("Local-agent runtime registry must be ordered by descriptor order.");
  }
  for (const entry of registry) {
    if (typeof entry.parseFull !== "function" || typeof entry.parseFinancialFile !== "function") {
      throw new Error(`Local-agent format ${entry.descriptor.id} is missing a runtime parser.`);
    }
  }
  const runtimeIds = registry.map((entry) => entry.descriptor.id);
  const descriptorIds = descriptors.map((descriptor) => descriptor.id);
  if (JSON.stringify(runtimeIds) !== JSON.stringify(descriptorIds)) {
    throw new Error(
      `Local-agent runtime registry must exactly match descriptor order: ${descriptorIds.join(", ")}.`
    );
  }
  if (registry.some((entry, index) => entry.descriptor !== descriptors[index])) {
    throw new Error("Local-agent runtime entries must use the canonical descriptor objects.");
  }
}

validateLocalAgentFormatRuntimeRegistry();
