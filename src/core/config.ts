/**
 * Central, fail-safe configuration. Changing any value here that affects
 * privacy or external services requires a recorded decision in docs/DECISIONS.md.
 */

export const APP_NAME = "PsstAmigo";
export const APP_VERSION: string = __APP_VERSION__;

/** Maximum participants per session (including self). Full mesh; see DECISIONS D-004 / D-019. */
export const MAX_PARTICIPANTS = 10;

/**
 * Low-bandwidth mode (D-020): above this group size every outbound voice stream is capped
 * to LOW_BANDWIDTH_BITRATE_BPS via RTCRtpSender.setParameters (no renegotiation).
 * At or below it the browser default Opus bitrate is used.
 */
export const LOW_BANDWIDTH_THRESHOLD = 5;
export const LOW_BANDWIDTH_BITRATE_BPS = 16_000;

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
  /** Coordinator: all members must vote within this time, otherwise the admission is aborted. */
  admissionVoteMs: 45_000,
  /** Coordinator: all mesh links (data + media) to the candidate must be up within this time. */
  meshSetupMs: 25_000,
  /**
   * Extra slack for local safety timers on members and the candidate, so that the
   * coordinator's own timeout normally fires first and everyone sees the same outcome.
   */
  localSlackMs: 8_000,
  /** Committed member whose voice path is still not connected after this time is marked failed. */
  mediaSetupMs: 20_000,
  /**
   * A committed member whose application data link stays ICE-"disconnected" this long is treated as
   * gone (crashed tab / lost network). PeerJS only closes on "failed", which Chrome may never reach.
   */
  peerLostMs: 30_000,
} as const;

export const LIMITS = {
  /** Max UID collision retries before reporting a fatal error. */
  uidRetries: 3,
  /** Max incoming data links that have not yet sent a valid join request. */
  unauthenticatedLinks: 5,
  /** Remembered finished admission ids (replay protection). */
  finishedAdmissions: 32,
  /** Remembered chat message ids per sender (de-duplication). */
  chatDedup: 64,
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
