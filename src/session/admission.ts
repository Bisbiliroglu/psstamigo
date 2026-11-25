/**
 * Small, pure helpers for group membership and admission (PA-006).
 * No consensus framework: see ARCHITECTURE.md "Group admission".
 */
import { MESSAGE_ID_HEX, SESSION_ID_HEX } from "./protocol";

type RandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;
const defaultRandom: RandomSource = (bytes) => {
  crypto.getRandomValues(bytes);
};

function randomHex(hexLength: number, random: RandomSource): string {
  const bytes = new Uint8Array(hexLength / 2);
  random(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 128-bit identifier for sessions and admissions (CSPRNG). Not a credential. */
export function newSessionId(random: RandomSource = defaultRandom): string {
  return randomHex(SESSION_ID_HEX, random);
}

/** 64-bit chat message identifier used for de-duplication only. */
export function newMessageId(random: RandomSource = defaultRandom): string {
  return randomHex(MESSAGE_ID_HEX, random);
}

/** Canonical member-set snapshot: sorted unique UIDs. */
export function memberSnapshot(uids: Iterable<string>): string[] {
  return [...new Set(uids)].sort();
}

/** True if both lists describe exactly the same member set. */
export function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const x = memberSnapshot(a);
  const y = memberSnapshot(b);
  return x.length === y.length && x.every((uid, i) => uid === y[i]);
}

/** Insertion-ordered set with a fixed capacity (oldest entries are evicted). */
export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly capacity: number) {}

  has(value: T): boolean {
    return this.items.has(value);
  }

  /** Adds the value; returns false if it was already present. */
  add(value: T): boolean {
    if (this.items.has(value)) return false;
    this.items.add(value);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value as T;
      this.items.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}
