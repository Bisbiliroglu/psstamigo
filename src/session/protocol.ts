/**
 * Session control protocol v2 (group mesh) carried over application DataConnections.
 * Every inbound message is untrusted input (PRIV-011) and must pass parseMessage().
 *
 * v1 (0.0.x, 1:1 only) is not compatible; peers on another version get an explicit
 * rejection (see otherProtocolVersion()).
 */
import { LIMITS, MAX_PARTICIPANTS } from "../core/config";
import { isValidUid } from "../core/uid";

export const PROTOCOL_VERSION = 2;

/** 128-bit session / admission identifiers, 64-bit chat message identifiers (lowercase hex). */
export const SESSION_ID_HEX = 32;
export const MESSAGE_ID_HEX = 16;

export type RejectReason = "declined" | "busy" | "timeout" | "full" | "invalid" | "conflict" | "failed" | "version";
export type Vote = "accept" | "declined" | "busy" | "conflict" | "full";

export interface MemberInfo {
  uid: string;
  name: string;
}

export type ProtocolMessage =
  /** candidate -> contacted member (coordinator): first message on a new link */
  | { t: "join-request"; v: 2; name: string }
  /** coordinator -> candidate: request is waiting for member approvals */
  | { t: "join-pending"; v: 2; aid: string }
  /** coordinator -> candidate: all members approved; who to connect to */
  | { t: "join-accept"; v: 2; sid: string; aid: string; name: string; members: MemberInfo[] }
  | { t: "join-reject"; v: 2; reason: RejectReason }
  /** candidate -> coordinator: withdraw the request */
  | { t: "cancel"; v: 2 }
  /** coordinator -> each member: approve this candidate? members = coordinator's member set incl. itself */
  | { t: "admit-propose"; v: 2; sid: string; aid: string; candidate: string; name: string; members: string[] }
  /** member -> coordinator: this member's own decision */
  | { t: "admit-vote"; v: 2; sid: string; aid: string; vote: Vote }
  /** candidate -> member: first message on a new mesh link after approval */
  | { t: "mesh-hello"; v: 2; sid: string; aid: string }
  /** member -> candidate: mesh link accepted; candidate may place the (silent) call */
  | { t: "mesh-ack"; v: 2; sid: string; aid: string }
  /** member -> coordinator: data + media to the candidate are up */
  | { t: "admit-ready"; v: 2; sid: string; aid: string }
  /** coordinator -> members and candidate: membership commit */
  | { t: "admit-commit"; v: 2; sid: string; aid: string }
  /** coordinator -> members and candidate: admission cancelled */
  | { t: "admit-abort"; v: 2; sid: string; aid: string; reason: RejectReason }
  | { t: "chat"; v: 2; sid: string; id: string; text: string }
  /** PA-011 (additive; ignored by 0.1.x): request a replacement MediaConnection (REC-007) */
  | { t: "media-recover"; v: 2; sid: string; gen: number }
  | { t: "media-recover-ok"; v: 2; sid: string; gen: number }
  /**
   * PA-011 (additive): the sender's own committed member set (incl. itself) after a membership change,
   * plus the candidate it is still connecting (if any). Used only to REMOVE peers (REC-010/011).
   */
  | { t: "member-sync"; v: 2; sid: string; members: string[]; pending: string | null }
  | { t: "leave"; v: 2; sid: string };

export type MessageType = ProtocolMessage["t"];

const REJECT_REASONS: ReadonlySet<string> = new Set<RejectReason>([
  "declined",
  "busy",
  "timeout",
  "full",
  "invalid",
  "conflict",
  "failed",
  "version",
]);
const VOTES: ReadonlySet<string> = new Set<Vote>(["accept", "declined", "busy", "conflict", "full"]);

const ALLOWED_KEYS: Record<MessageType, readonly string[]> = {
  "join-request": ["t", "v", "name"],
  "join-pending": ["t", "v", "aid"],
  "join-accept": ["t", "v", "sid", "aid", "name", "members"],
  "join-reject": ["t", "v", "reason"],
  cancel: ["t", "v"],
  "admit-propose": ["t", "v", "sid", "aid", "candidate", "name", "members"],
  "admit-vote": ["t", "v", "sid", "aid", "vote"],
  "mesh-hello": ["t", "v", "sid", "aid"],
  "mesh-ack": ["t", "v", "sid", "aid"],
  "admit-ready": ["t", "v", "sid", "aid"],
  "admit-commit": ["t", "v", "sid", "aid"],
  "admit-abort": ["t", "v", "sid", "aid", "reason"],
  chat: ["t", "v", "sid", "id", "text"],
  "media-recover": ["t", "v", "sid", "gen"],
  "media-recover-ok": ["t", "v", "sid", "gen"],
  "member-sync": ["t", "v", "sid", "members", "pending"],
  leave: ["t", "v", "sid"],
};

const HEX = /^[0-9a-f]+$/;

export function isHexId(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && HEX.test(value);
}

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

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype;
}

/**
 * Returns the foreign protocol version if `raw` looks like a PsstAmigo message of
 * another version (so the peer can be told explicitly), otherwise null.
 */
export function otherProtocolVersion(raw: unknown): number | null {
  if (!isPlainObject(raw) || approximateSize(raw) > LIMITS.messageBytes) return null;
  const v = raw["v"];
  return typeof v === "number" && Number.isInteger(v) && v !== PROTOCOL_VERSION && v > 0 && v < 100 ? v : null;
}

function parseUidList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const uid of value) {
    if (!isValidUid(uid) || out.includes(uid)) return null;
    out.push(uid);
  }
  return out;
}

function parseMembers(value: unknown, max: number): MemberInfo[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: MemberInfo[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes("uid") || !keys.includes("name")) return null;
    const uid = item["uid"];
    const name = sanitizeDisplayName(item["name"]);
    if (!isValidUid(uid) || name === null || out.some((m) => m.uid === uid)) return null;
    out.push({ uid, name });
  }
  return out;
}

/** Validates an inbound message. Returns null for anything malformed, oversized or of another version. */
export function parseMessage(raw: unknown): ProtocolMessage | null {
  if (approximateSize(raw) > LIMITS.messageBytes) return null;
  if (!isPlainObject(raw)) return null;
  if (raw["v"] !== PROTOCOL_VERSION) return null;
  const type = raw["t"];
  if (typeof type !== "string" || !Object.hasOwn(ALLOWED_KEYS, type)) return null;
  const t = type as MessageType;
  const allowed = ALLOWED_KEYS[t];
  const keys = Object.keys(raw);
  if (keys.length !== allowed.length || !keys.every((k) => allowed.includes(k))) return null;

  const sid = raw["sid"];
  const aid = raw["aid"];
  const hasSid = (): boolean => isHexId(sid, SESSION_ID_HEX);
  const hasAid = (): boolean => isHexId(aid, SESSION_ID_HEX);

  switch (t) {
    case "join-request": {
      const name = sanitizeDisplayName(raw["name"]);
      return name === null ? null : { t, v: 2, name };
    }
    case "join-pending":
      return hasAid() ? { t, v: 2, aid: aid as string } : null;
    case "join-accept": {
      const name = sanitizeDisplayName(raw["name"]);
      // Candidate connects to at most MAX_PARTICIPANTS - 2 others besides the coordinator.
      const members = parseMembers(raw["members"], MAX_PARTICIPANTS - 2);
      if (!hasSid() || !hasAid() || name === null || members === null) return null;
      return { t, v: 2, sid: sid as string, aid: aid as string, name, members };
    }
    case "join-reject": {
      const reason = raw["reason"];
      return typeof reason === "string" && REJECT_REASONS.has(reason) ? { t, v: 2, reason: reason as RejectReason } : null;
    }
    case "cancel":
      return { t, v: 2 };
    case "admit-propose": {
      const candidate = raw["candidate"];
      const name = sanitizeDisplayName(raw["name"]);
      const members = parseUidList(raw["members"], MAX_PARTICIPANTS - 1);
      if (!hasSid() || !hasAid() || !isValidUid(candidate) || name === null || members === null || members.length < 2) {
        return null;
      }
      if (members.includes(candidate)) return null;
      return { t, v: 2, sid: sid as string, aid: aid as string, candidate, name, members };
    }
    case "admit-vote": {
      const vote = raw["vote"];
      if (!hasSid() || !hasAid() || typeof vote !== "string" || !VOTES.has(vote)) return null;
      return { t, v: 2, sid: sid as string, aid: aid as string, vote: vote as Vote };
    }
    case "mesh-hello":
    case "mesh-ack":
    case "admit-ready":
    case "admit-commit":
      return hasSid() && hasAid() ? { t, v: 2, sid: sid as string, aid: aid as string } : null;
    case "admit-abort": {
      const reason = raw["reason"];
      if (!hasSid() || !hasAid() || typeof reason !== "string" || !REJECT_REASONS.has(reason)) return null;
      return { t, v: 2, sid: sid as string, aid: aid as string, reason: reason as RejectReason };
    }
    case "chat": {
      const text = sanitizeChatText(raw["text"]);
      const id = raw["id"];
      if (!hasSid() || !isHexId(id, MESSAGE_ID_HEX) || text === null) return null;
      return { t, v: 2, sid: sid as string, id, text };
    }
    case "leave":
      return hasSid() ? { t, v: 2, sid: sid as string } : null;
    case "media-recover":
    case "media-recover-ok": {
      const gen = raw["gen"];
      if (!hasSid() || typeof gen !== "number" || !Number.isInteger(gen) || gen < 1 || gen > 1_000_000) return null;
      return { t, v: 2, sid: sid as string, gen };
    }
    case "member-sync": {
      const members = parseUidList(raw["members"], MAX_PARTICIPANTS);
      const pending = raw["pending"];
      if (!hasSid() || members === null || members.length < 1) return null;
      if (pending !== null && (!isValidUid(pending) || members.includes(pending))) return null;
      return { t, v: 2, sid: sid as string, members, pending };
    }
    default:
      return null;
  }
}
