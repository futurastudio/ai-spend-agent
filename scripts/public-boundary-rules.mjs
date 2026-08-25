const namedPrivateDocuments = [
  /(^|\/)ARTIFACT_ROADMAP(?:\.[^/]*)?$/i,
  /(^|\/)AUDIT_PUBLIC_REPO(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)MONETIZATION(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)INVESTOR[-_]?P0[-_]?BUILD(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:GTM|GO[-_]?TO[-_]?MARKET)(?:[-_](?:STRATEGY|PLAN|ROADMAP|REPORT|RESEARCH|LAUNCH))?(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:LAUNCH[-_]?GTM|USER[-_]?RESEARCH|MARKET[-_]?RESEARCH|COMPETITIVE[-_]?INTELLIGENCE|PAIN[-_]?POINTS)(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:PRICING[-_]?(?:STRATEGY|MODEL|PLAN)|REVENUE[-_]?(?:STRATEGY|MODEL|PLAN)|TEAM[-_]?TIERS?|UNIT[-_]?ECONOMICS)(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:(?:[a-z0-9][a-z0-9_-]*[-_])?(?:BUILD|CLOUD)[-_]?SPEC|(?:INTERNAL|PRIVATE)[-_]?(?:BUILD[-_]?)?SPEC)(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:INTERNAL|PRIVATE)[-_]?ROADMAP(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)ROADMAP[-_]?(?:INTERNAL|PRIVATE)(?:_[^/]*)?(?:\.[^/]*)?$/i
];

const privateDirectoryPatterns = [
  /(^|\/)(?:research|gtm|internal|private)(?:\/|$)/i,
  /(^|\/)monetization(?:\/|$)/i,
  /(^|\/)(?:build[-_]?specs?|internal[-_]?specs?|private[-_]?specs?)(?:\/|$)/i,
  /(^|\/)\.(?:codex|claude)(?:\/|$)/i,
  /(^|\/)(?:investors?|investor[-_]?materials?|fundrais(?:e|ing)|pitch[-_]?deck)(?:\/|$)/i
];

const investorMaterialPatterns = [
  /(^|\/)(?:investor|fundrais(?:e|ing)|pitch)[-_ ]*(?:deck|demo|memo|brief|update|materials?|notes?)(?:_[^/]*)?(?:\.[^/]*)?$/i,
  /(^|\/)(?:deck|demo|memo|brief|update|materials?|notes?)[-_ ]*(?:investor|fundrais(?:e|ing)|pitch)(?:_[^/]*)?(?:\.[^/]*)?$/i
];

export const forbiddenPathPatterns = [
  ...namedPrivateDocuments,
  ...privateDirectoryPatterns,
  ...investorMaterialPatterns,
  /(^|\/)\.npmrc$/i
];

// Repo-root directories that hold internal-only working material (QA
// handoffs, GTM plans). They exist in the private repo and must NEVER ride a
// release branch into the public tree — two qa-handoff docs did exactly that
// on 2026-08-24. Checked as exact tree locations, separate from the generic
// name-based patterns above, so the failure names the policy explicitly.
export const internalOnlyTreeDirectories = ["docs/qa-handoff", "docs/gtm"];

/**
 * Return true when a tracked path sits under one of the internal-only tree
 * directories (the directory itself included).
 */
export function isInternalOnlyTreePath(path) {
  return internalOnlyTreeDirectories.some(
    (dir) => path === dir || path.startsWith(`${dir}/`)
  );
}

const genericUserSegments = new Set([
  "dev",
  "private-company",
  "test",
  "testuser",
  "user",
  "username",
  "your-user",
  "your_user",
  "yourusername",
  "you"
]);

/**
 * Return true when a path is private by convention and must not enter the
 * public repository. This is intentionally path-based: public copy may discuss
 * a roadmap or investor audience without becoming private material itself.
 */
export function isForbiddenPublicPath(path) {
  return forbiddenPathPatterns.some((pattern) => pattern.test(path));
}

/**
 * Find concrete developer-machine paths without rejecting generic examples
 * such as /path/to/workspace, ~/projects/ai-spend-agent, or
 * /Users/<username>/project.
 */
export function findDeveloperPathLeaks(content) {
  const leaks = new Set();
  const macHomePattern = /\/Users\/([^/\s"'`<>]+)(?:\/[^\s"'`<>)\]}]*)?/g;
  const linuxHomePattern = /\/home\/([^/\s"'`<>]+)(?:\/[^\s"'`<>)\]}]*)?/g;
  const windowsHomePattern = /[A-Za-z]:\\Users\\([^\\\s"'`<>]+)(?:\\[^\s"'`<>\])}]*)?/g;

  for (const match of content.matchAll(macHomePattern)) {
    const userSegment = match[1];
    if (isGenericUserSegment(userSegment)) continue;
    leaks.add(match[0]);
  }
  for (const match of content.matchAll(linuxHomePattern)) {
    const userSegment = match[1];
    if (isGenericUserSegment(userSegment)) continue;
    leaks.add(match[0]);
  }
  for (const match of content.matchAll(windowsHomePattern)) {
    const userSegment = match[1];
    if (isGenericUserSegment(userSegment)) continue;
    leaks.add(match[0]);
  }

  const checkoutName = ["agent", "finops"].join("-");
  const tildeCheckoutPattern = new RegExp(`~/${checkoutName}(?:/|\\b)`, "g");
  for (const match of content.matchAll(tildeCheckoutPattern)) {
    leaks.add(match[0]);
  }

  const legacyCheckoutComposition = new RegExp(
    `\\.appendingPathComponent\\(\\s*["']${checkoutName}["']\\s*\\)`,
    "g"
  );
  for (const match of content.matchAll(legacyCheckoutComposition)) {
    leaks.add(match[0]);
  }

  return [...leaks];
}

function isGenericUserSegment(segment) {
  if (/^<[^>]+>$/.test(segment)) return true;
  if (/^\$\{?[A-Z_]+\}?$/i.test(segment)) return true;
  return genericUserSegments.has(segment.toLowerCase());
}
