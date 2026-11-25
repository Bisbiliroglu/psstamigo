/**
 * Session control protocol carried over the PeerJS DataConnection.
 * Every inbound message is untrusted input (PRIV-011) and must pass parseMessage().
 */
import { LIMITS } from "../core/config";

export const PROTOCOL_VERSION = 1;

export type RejectReason = "declined" | "busy" | "timeout" | "full" | "invalid";

export type ProtocolMessage =
  | { t: "join-request"; v: 1; name: string }
  | { t: "join-accept"; v: 1; name: string }
  | { t: "join-reject"; v: 1; reason: RejectReason }
  | { t: "cancel"; v: 1 }
  | { t: "chat"; v: 1; text: string }
  | { t: "leave"; v: 1 };

const REJECT_REASONS: ReadonlySet<string> = new Set<RejectReason>([
  "declined",
  "busy",
  "timeout",
  "full",
  "invalid",
]);

const ALLOWED_KEYS: Record<ProtocolMessage["t"], readonly string[]> = {
  "join-request": ["t", "v", "name"],
  "join-accept": ["t", "v", "name"],
  "join-reject": ["t", "v", "reason"],
  cancel: ["t", "v"],
  chat: ["t", "v", "text"],
  leave: ["t", "v"],
};

/** Removes control characters and trims; returns null if invalid. */
export function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (cleaned.length === 0) return "";
  if ([...cleaned].length > LIMITS.displayNameChars) return null;
  return cleaned;
}

/** Chat text: plain text only, newlines allowed, other control characters removed. */
export function sanitizeChatText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  if (cleaned.length === 0) return null;
  if ([...cleaned].length > LIMITS.chatChars) return null;
  return cleaned;
}

function approximateSize(raw: unknown): number {
  if (typeof raw === "string") return raw.length;
  try {
    return JSON.stringify(raw)?.length ?? Infinity;
  } catch {
    return Infinity;
  }
}

/** Validates an inbound message. Returns null for anything malformed or oversized. */
export function parseMessage(raw: unknown): ProtocolMessage | null {
  if (approximateSize(raw) > LIMITS.messageBytes) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (Object.getPrototypeOf(raw) !== Object.prototype) return null;

  const msg = raw as Record<string, unknown>;
  if (msg["v"] !== PROTOCOL_VERSION) return null;
  const type = msg["t"];
  if (typeof type !== "string" || !Object.hasOwn(ALLOWED_KEYS, type)) return null;

  const allowed = ALLOWED_KEYS[type as ProtocolMessage["t"]];
  for (const key of Object.keys(msg)) {
    if (!allowed.includes(key)) return null;
  }

  switch (type) {
    case "join-request":
    case "join-accept": {
      const name = sanitizeDisplayName(msg["name"]);
      if (name === null) return null;
      return { t: type, v: 1, name };
    }
    case "join-reject": {
      const reason = msg["reason"];
      if (typeof reason !== "string" || !REJECT_REASONS.has(reason)) return null;
      return { t: "join-reject", v: 1, reason: reason as RejectReason };
    }
    case "chat": {
      const text = sanitizeChatText(msg["text"]);
      if (text === null) return null;
      return { t: "chat", v: 1, text };
    }
    case "cancel":
      return { t: "cancel", v: 1 };
    case "leave":
      return { t: "leave", v: 1 };
    default:
      return null;
  }
}
