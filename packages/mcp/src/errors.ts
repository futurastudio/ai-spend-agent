export const MALFORMED_LOCAL_STATE_MESSAGE =
  "Malformed local aibill state was rejected. Re-run the sync or scan that created it; no records, totals, or recommendations were returned.";

export type McpToolErrorCode =
  | "authentication_error"
  | "malformed_state"
  | "unsafe_root"
  | "tool_error";

/** Product-authored error classification carried across the MCP boundary. */
export class McpToolError extends Error {
  readonly code: McpToolErrorCode;

  constructor(code: McpToolErrorCode, message: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

export function isMcpToolError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}

export class MalformedLocalStateError extends Error {
  readonly code = "malformed_state";

  constructor() {
    super(MALFORMED_LOCAL_STATE_MESSAGE);
    this.name = "MalformedLocalStateError";
  }
}

/**
 * JSON parser messages may include attacker-controlled source fragments,
 * secrets, or local paths. Collapse every local-state syntax failure at the
 * parsing boundary so callers never receive the engine's diagnostic context.
 */
export function parseLocalStateJson<T = unknown>(contents: string): T {
  try {
    return JSON.parse(contents) as T;
  } catch {
    throw new MalformedLocalStateError();
  }
}

export function isMalformedLocalStateError(error: unknown): boolean {
  if (error instanceof MalformedLocalStateError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message === MALFORMED_LOCAL_STATE_MESSAGE ||
    /^Invalid local (?:spend state|spend accounting|provider state|source state|source registry)\b/i.test(message);
}
