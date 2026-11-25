/**
 * Transport abstractions. The session layer depends only on these interfaces;
 * PeerJS is confined to PeerJsSignaling.ts (dependency inversion, see ARCHITECTURE.md).
 */

import type { OfferVerdict } from "./sdpPolicy";

/**
 * connecting: first registration · online · reconnecting: bounded loop running (P2P calls unaffected) ·
 * unavailable: loop exhausted or UID lost (manual retry) · failed: first registration failed · offline: destroyed
 */
export type SignalingState = "connecting" | "online" | "reconnecting" | "unavailable" | "failed" | "offline";

export interface DataLink {
  readonly peerId: string;
  readonly isOpen: boolean;
  send(message: unknown): void;
  close(): void;
  onOpen(cb: () => void): void;
  onData(cb: (data: unknown) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (error: Error) => void): void;
  /** Underlying peer connection of this data link (for liveness of committed members only). */
  getPeerConnection(): RTCPeerConnection | null;
}

export interface MediaLink {
  readonly peerId: string;
  /**
   * Fail-closed audit of the remote offer (PRIV-008, PRIV-011). Only "audio-only"
   * may be answered; video, unreadable or invalid offers must be closed unanswered.
   */
  readonly offerVerdict: OfferVerdict;
  /** Answer an incoming call. Only called after session authorization. */
  answer(stream: MediaStream): void;
  /** Underlying peer connection; available after call()/answer(). */
  getPeerConnection(): RTCPeerConnection | null;
  close(): void;
  onStream(cb: (stream: MediaStream) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (error: Error) => void): void;
}

export interface SignalingEvents {
  state: SignalingState;
  /** Our UID was registered with the signaling server. */
  open: string;
  incomingData: DataLink;
  incomingMedia: MediaLink;
  /** peerId is set when the error concerns a specific remote peer (e.g. peer-unavailable). */
  error: { code: string; message: string; fatal: boolean; peerId: string | null };
}

export interface Signaling {
  readonly uid: string | null;
  readonly state: SignalingState;
  start(): void;
  /** Current reconnect attempt number (0 when not reconnecting). */
  readonly reconnectAttempt: number;
  /** True if the server gave our UID to someone else while we were away (REC-003). */
  readonly uidLost: boolean;
  /** User-initiated retry: resets the bounded loop and tries now. No-op when online. */
  retryNow(): void;
  /** Gets a NEW temporary UID (only allowed when no session uses the old one; caller checks). */
  renewIdentity(): void;
  connect(peerId: string): DataLink;
  call(peerId: string, stream: MediaStream): MediaLink;
  on<K extends keyof SignalingEvents>(event: K, cb: (payload: SignalingEvents[K]) => void): () => void;
  /** Destroys the Peer and releases the UID. Idempotent. */
  destroy(): void;
}
