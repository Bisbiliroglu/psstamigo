/**
 * Transport abstractions. The session layer depends only on these interfaces;
 * PeerJS is confined to PeerJsSignaling.ts (dependency inversion, see ARCHITECTURE.md).
 */

export type SignalingState = "connecting" | "online" | "offline" | "failed";

export interface DataLink {
  readonly peerId: string;
  readonly isOpen: boolean;
  send(message: unknown): void;
  close(): void;
  onOpen(cb: () => void): void;
  onData(cb: (data: unknown) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (error: Error) => void): void;
}

export interface MediaLink {
  readonly peerId: string;
  /** True if the remote offer contained a video m-line (audio-only policy, PRIV-008). */
  readonly offerHasVideo: boolean;
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
  error: { code: string; message: string; fatal: boolean };
}

export interface Signaling {
  readonly uid: string | null;
  readonly state: SignalingState;
  start(): void;
  connect(peerId: string): DataLink;
  call(peerId: string, stream: MediaStream): MediaLink;
  on<K extends keyof SignalingEvents>(event: K, cb: (payload: SignalingEvents[K]) => void): () => void;
  /** Destroys the Peer and releases the UID. Idempotent. */
  destroy(): void;
}
