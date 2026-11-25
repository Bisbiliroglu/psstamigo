/**
 * Central, fail-safe configuration. Changing any value here that affects
 * privacy or external services requires a recorded decision in docs/DECISIONS.md.
 */

export const APP_NAME = "PsstAmigo";
export const APP_VERSION: string = __APP_VERSION__;

/** Maximum participants per session (including self). Mesh is used; see DECISIONS D-004. */
export const MAX_PARTICIPANTS = 6;

/**
 * ICE servers. STUN only. PeerJS ships an undocumented default TURN server
 * (eu-0/us-0.turn.peerjs.com); passing an explicit config replaces that default.
 * See DECISIONS D-003.
 */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export const TIMEOUTS = {
  /** Waiting for the signaling server to register our UID. */
  signalingOpenMs: 15_000,
  /** Waiting for the data channel to the target peer to open. */
  dataOpenMs: 15_000,
  /** Waiting for the remote user to accept or reject our request. */
  requestAnswerMs: 45_000,
  /** Incoming request is auto-rejected if not answered in this time. */
  incomingRequestMs: 45_000,
  /** Media (voice) path must be established within this time after acceptance. */
  mediaSetupMs: 20_000,
} as const;

export const LIMITS = {
  /** Max UID collision retries before reporting a fatal error. */
  uidRetries: 3,
  /** Max incoming data links that have not yet sent a valid join request. */
  unauthenticatedLinks: 5,
  /** Max simultaneous pending incoming requests. Extra requests are rejected as busy. */
  pendingRequests: 3,
  /** Max display name length (characters). */
  displayNameChars: 32,
  /** Max chat message length (characters). */
  chatChars: 500,
  /** Max serialized protocol message size (bytes, approximate via JSON length). */
  messageBytes: 2_048,
  /** Max messages per peer in a rate window. */
  messagesPerWindow: 20,
  rateWindowMs: 5_000,
  /** Max chat entries kept in memory. Older entries are dropped. */
  chatHistory: 200,
} as const;
