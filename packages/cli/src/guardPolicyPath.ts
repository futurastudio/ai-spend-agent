/**
 * The policy file's path inside a checkout, duplicated from core's
 * `AIBILL_POLICY_RELATIVE_PATH` so the hook's fast path can stat it without
 * importing the core index. A test pins the two values together.
 */
export const AIBILL_POLICY_RELATIVE_PATH = ".aibill/policy.json";
