/**
 * Temporary UID generation (FR-001).
 *
 * Format: "psst-xxxx-xxxx-xxxx" (3 groups of 4) using an alphabet without
 * ambiguous characters (no 0/o, 1/l/i). 12 symbols from a 31-char alphabet ≈ 59 bits of entropy,
 * generated with crypto.getRandomValues (CSPRNG).
 *
 * A UID is an address, not a credential: knowing it never grants access.
 */

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // 31 chars
const GROUPS = 3;
const GROUP_LEN = 4;
const PREFIX = "psst";

const UID_PATTERN = new RegExp(`^${PREFIX}(-[${ALPHABET}]{${GROUP_LEN}}){${GROUPS}}$`);

type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

const defaultRandom: RandomSource = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** Unbiased random symbol using rejection sampling. */
function randomSymbol(random: RandomSource): string {
  const limit = 256 - (256 % ALPHABET.length);
  const buf = new Uint8Array(1);
  for (;;) {
    random(buf);
    const value = buf[0] ?? 255;
    if (value < limit) return ALPHABET.charAt(value % ALPHABET.length);
  }
}

export function generateUid(random: RandomSource = defaultRandom): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LEN; i++) group += randomSymbol(random);
    groups.push(group);
  }
  return `${PREFIX}-${groups.join("-")}`;
}

/** Normalizes user input (trim, lowercase, remove inner whitespace). */
export function normalizeUid(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "");
}

export function isValidUid(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && UID_PATTERN.test(value);
}

/** Exposed for tests only. */
export const UID_ALPHABET = ALPHABET;
