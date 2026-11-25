/**
 * Fail-closed audit of an incoming media offer (PRIV-008, PRIV-011).
 *
 * Only an offer that can be read AND contains exactly one "audio" m-section is
 * acceptable. PeerJS 1.5.5 also adds one internal data channel to every media
 * connection (used to signal close), so at most one
 * "m=application … webrtc-datachannel" section is allowed. Anything else
 * (missing/unreadable SDP, video, unknown or repeated m-sections, malformed or
 * oversized SDP) must be rejected without answering.
 */

export type OfferVerdict = "audio-only" | "video" | "unreadable" | "invalid";

const MAX_SDP_LENGTH = 64 * 1024;

export function auditOffer(description: unknown): OfferVerdict {
  if (typeof description !== "object" || description === null) return "unreadable";
  const { type, sdp } = description as { type?: unknown; sdp?: unknown };
  if (typeof sdp !== "string" || sdp.length === 0) return "unreadable";
  if (type !== "offer") return "invalid";
  if (sdp.length > MAX_SDP_LENGTH || !sdp.startsWith("v=0")) return "invalid";

  const sections = sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("m="))
    .map((line) => line.slice(2).trim().split(/\s+/));

  const kinds = sections.map((parts) => parts[0] ?? "");
  if (kinds.includes("video")) return "video";

  let audio = 0;
  let dataChannels = 0;
  for (const parts of sections) {
    if (parts[0] === "audio") audio++;
    else if (parts[0] === "application" && parts.at(-1) === "webrtc-datachannel") dataChannels++;
    else return "invalid";
  }
  if (audio !== 1 || dataChannels > 1) return "invalid";
  return "audio-only";
}
