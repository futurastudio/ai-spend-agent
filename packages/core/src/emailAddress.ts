const controlCharacters = /[\u0000-\u001F\u007F]/u;
const pragmaticEmailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * One intentionally pragmatic normalizer for waitlist and receipt-email
 * boundaries. It prevents header/control injection without pretending to be
 * a mailbox-verification system; ownership still requires an explicit flow.
 */
export function normalizeAibillEmailAddress(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 254) return undefined;
  if (controlCharacters.test(normalized)) return undefined;
  return pragmaticEmailAddress.test(normalized) ? normalized : undefined;
}
