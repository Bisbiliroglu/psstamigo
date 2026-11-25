/**
 * The only module that imports PeerJS. Wraps Peer / DataConnection / MediaConnection
 * behind the transport interfaces in ./types.
 */
import { Peer, type DataConnection, type MediaConnection, type PeerError, type PeerOptions } from "peerjs";
import { ICE_SERVERS, LIMITS, SIGNALING_RECONNECT, TIMEOUTS } from "../core/config";
import { Emitter } from "../core/emitter";
import { generateUid } from "../core/uid";
import { auditOffer, type OfferVerdict } from "./sdpPolicy";
import type { DataLink, MediaLink, Signaling, SignalingEvents, SignalingState } from "./types";

class PeerJsDataLink implements DataLink {
  constructor(private readonly conn: DataConnection) {}

  get peerId(): string {
    return this.conn.peer;
  }

  get isOpen(): boolean {
    return this.conn.open;
  }

  send(message: unknown): void {
    if (this.conn.open) void this.conn.send(message);
  }

  close(): void {
    try {
      // flush: deliver already queued control messages (e.g. "leave") before closing.
      this.conn.close({ flush: true });
    } catch {
      /* already closed */
    }
  }

  onOpen(cb: () => void): void {
    this.conn.on("open", cb);
  }

  onData(cb: (data: unknown) => void): void {
    this.conn.on("data", cb);
  }

  onClose(cb: () => void): void {
    this.conn.on("close", cb);
  }

  onError(cb: (error: Error) => void): void {
    this.conn.on("error", cb);
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.conn.peerConnection ?? null;
  }
}

/**
 * Reads the remote offer description of an incoming call. PeerJS 1.5.5 keeps it in the
 * non-public `options._payload.sdp`. If that internal shape changes, this returns
 * undefined and auditOffer() reports "unreadable", so the call is rejected (fail-closed).
 */
function readOfferDescription(call: MediaConnection): unknown {
  try {
    const options = (call as unknown as { options?: { _payload?: { sdp?: unknown } } }).options;
    return options?._payload?.sdp;
  } catch {
    return undefined;
  }
}

class PeerJsMediaLink implements MediaLink {
  readonly offerVerdict: OfferVerdict;

  constructor(private readonly call: MediaConnection, incoming: boolean) {
    // Outgoing calls are created by us (audio-only silent stream), so they are audio-only by construction.
    this.offerVerdict = incoming ? auditOffer(readOfferDescription(call)) : "audio-only";
  }

  get peerId(): string {
    return this.call.peer;
  }

  answer(stream: MediaStream): void {
    this.call.answer(stream);
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.call.peerConnection ?? null;
  }

  close(): void {
    try {
      this.call.close();
    } catch {
      /* already closed */
    }
  }

  onStream(cb: (stream: MediaStream) => void): void {
    this.call.on("stream", cb);
  }

  onClose(cb: () => void): void {
    this.call.on("close", cb);
  }

  onError(cb: (error: Error) => void): void {
    this.call.on("error", cb);
  }
}

/** Minimal Peer surface used here (lets tests inject a fake Peer). */
export type PeerLike = Pick<Peer, "on" | "destroy" | "reconnect" | "disconnect" | "connect" | "call" | "disconnected" | "destroyed">;
export type PeerFactory = (id: string, options: PeerOptions) => PeerLike;

const defaultFactory: PeerFactory = (id, options) => new Peer(id, options);

export class PeerJsSignaling implements Signaling {
  private peer: PeerLike | null = null;
  private readonly events = new Emitter<SignalingEvents>();
  private currentState: SignalingState = "offline";
  private currentUid: string | null = null;
  private attempts = 0;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** True once the UID was registered; afterwards signaling errors never destroy P2P links. */
  private registered = false;
  /** Bounded reconnect loop (REC-002): at most one timer, generation-checked. */
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private loopGeneration = 0;
  private lostUid = false;

  constructor(
    private readonly createPeerInstance: PeerFactory = defaultFactory,
    private readonly random: () => number = Math.random,
  ) {}

  get uid(): string | null {
    return this.currentUid;
  }

  get state(): SignalingState {
    return this.currentState;
  }

  get reconnectAttempt(): number {
    return this.currentState === "reconnecting" ? this.attempt : 0;
  }

  get uidLost(): boolean {
    return this.lostUid;
  }

  on<K extends keyof SignalingEvents>(event: K, cb: (payload: SignalingEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  start(): void {
    if (this.destroyed || this.peer) return;
    this.attempts = 0;
    this.createPeer();
  }

  private setState(state: SignalingState, force = false): void {
    if (this.currentState === state && !force) return;
    this.currentState = state;
    this.events.emit("state", state);
  }

  private createPeer(): void {
    this.attempts += 1;
    const uid = generateUid();
    this.currentUid = null;
    this.setState("connecting");

    // Explicit config replaces PeerJS defaults, removing its undocumented TURN server (D-003).
    const peer = this.createPeerInstance(uid, { config: { iceServers: ICE_SERVERS }, debug: 0 });
    this.peer = peer;

    this.clearOpenTimer();
    this.openTimer = setTimeout(() => {
      if (this.peer !== peer || this.currentState === "online") return;
      this.fail("signaling-timeout", "Sinyal sunucusuna bağlanılamadı (zaman aşımı).");
    }, TIMEOUTS.signalingOpenMs);

    peer.on("open", (id) => {
      if (this.peer !== peer) return;
      this.clearOpenTimer();
      this.stopLoop();
      this.currentUid = id;
      this.registered = true;
      this.lostUid = false;
      this.setState("online");
      this.events.emit("open", id);
    });

    peer.on("connection", (conn) => {
      if (this.peer !== peer) {
        conn.close();
        return;
      }
      this.events.emit("incomingData", new PeerJsDataLink(conn));
    });

    peer.on("call", (call) => {
      if (this.peer !== peer) {
        call.close();
        return;
      }
      this.events.emit("incomingMedia", new PeerJsMediaLink(call, true));
    });

    peer.on("disconnected", () => {
      if (this.peer !== peer || this.destroyed || !this.registered) return;
      // Signaling lost; existing P2P links keep working (REC-001). Bounded reconnect loop.
      this.clearAttemptTimer();
      if (!this.lostUid) this.scheduleReconnect(peer);
    });

    peer.on("error", (err: PeerError<string>) => {
      if (this.peer !== peer) return;
      const code = String(err.type);
      if (code === "unavailable-id" && !this.registered) {
        // UID collision at first registration: regenerate safely, bounded retries.
        peer.destroy();
        this.peer = null;
        if (this.attempts < LIMITS.uidRetries) {
          this.createPeer();
        } else {
          this.fail(code, "Benzersiz UID alınamadı. Sayfayı yenileyin.");
        }
        return;
      }
      if (code === "unavailable-id") {
        // REC-003: our UID was taken while we were away. Never switch UID silently: a new Peer would
        // close every P2P link. Stop retrying; the user decides (only possible outside a session).
        this.lostUid = true;
        this.stopLoop();
        this.setState("unavailable", true);
        this.events.emit("error", { code: "uid-lost", message: "Geçici UID'n başka biri tarafından alındı.", fatal: false, peerId: null });
        return;
      }
      const fatal = ["browser-incompatible", "invalid-id", "invalid-key", "ssl-unavailable", "server-error", "socket-error", "socket-closed"].includes(code);
      if (fatal && !this.registered) {
        this.fail(code, describePeerError(code));
        return;
      }
      // After registration, server problems only affect signaling; the reconnect loop handles them.
      this.events.emit("error", {
        code,
        message: describePeerError(code),
        fatal: false,
        peerId: code === "peer-unavailable" ? extractPeerId(err.message) : null,
      });
    });
  }

  private scheduleReconnect(peer: PeerLike): void {
    if (this.reconnectTimer !== null || this.destroyed) return; // never two loops
    const delays = SIGNALING_RECONNECT.delaysMs;
    if (this.attempt >= delays.length) {
      this.setState("unavailable", true);
      return;
    }
    const base = delays[this.attempt] ?? delays[delays.length - 1] ?? 30_000;
    const jitter = 1 + (this.random() * 2 - 1) * SIGNALING_RECONNECT.jitter;
    const gen = this.loopGeneration;
    this.setState("reconnecting", true);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.loopGeneration) return;
      this.attemptReconnect(peer);
    }, Math.round(base * jitter));
  }

  private attemptReconnect(peer: PeerLike): void {
    if (this.peer !== peer || this.destroyed || peer.destroyed || !peer.disconnected) return;
    this.attempt += 1;
    this.setState("reconnecting", true);
    try {
      peer.reconnect(); // same UID and token (REC-003)
    } catch {
      this.scheduleReconnect(peer);
      return;
    }
    const gen = this.loopGeneration;
    this.clearAttemptTimer();
    this.attemptTimer = setTimeout(() => {
      this.attemptTimer = null;
      if (gen !== this.loopGeneration || this.peer !== peer || this.currentState === "online") return;
      try {
        peer.disconnect(); // abandon a hanging attempt; emits "disconnected" ⇒ next attempt
      } catch {
        /* ignore */
      }
      this.scheduleReconnect(peer);
    }, SIGNALING_RECONNECT.attemptTimeoutMs);
  }

  retryNow(): void {
    if (this.destroyed || this.currentState === "online" || this.currentState === "connecting") return;
    const peer = this.peer;
    if (!this.registered || !peer) {
      // First registration failed: start over (new temporary UID; nothing depends on it yet).
      this.peer = null;
      this.start();
      return;
    }
    if (this.lostUid) return; // needs renewIdentity(), decided by the user
    this.stopLoop();
    this.attempt = 0;
    if (!peer.disconnected) return;
    this.attemptReconnect(peer);
  }

  renewIdentity(): void {
    if (this.destroyed) return;
    this.stopLoop();
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.registered = false;
    this.lostUid = false;
    this.attempts = 0;
    this.createPeer();
  }

  private stopLoop(): void {
    this.loopGeneration++;
    this.attempt = 0;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearAttemptTimer();
  }

  private clearAttemptTimer(): void {
    if (this.attemptTimer !== null) clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
  }

  private fail(code: string, message: string): void {
    this.clearOpenTimer();
    this.stopLoop();
    this.peer?.destroy();
    this.peer = null;
    this.currentUid = null;
    this.setState("failed");
    this.events.emit("error", { code, message, fatal: true, peerId: null });
  }

  private clearOpenTimer(): void {
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  connect(peerId: string): DataLink {
    if (!this.peer || this.currentState !== "online") throw new Error("signaling-offline");
    const conn = this.peer.connect(peerId, { reliable: true, serialization: "json" });
    return new PeerJsDataLink(conn);
  }

  call(peerId: string, stream: MediaStream): MediaLink {
    if (!this.peer || this.currentState !== "online") throw new Error("signaling-offline");
    const call = this.peer.call(peerId, stream);
    if (!call) throw new Error("call-failed");
    return new PeerJsMediaLink(call, false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearOpenTimer();
    this.stopLoop();
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.currentUid = null;
    this.setState("offline");
    this.events.clear();
  }
}

/** PeerJS reports "Could not connect to peer <id>"; returns the id if it is present. */
function extractPeerId(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = /peer\s+(\S+)\s*$/.exec(message);
  return match?.[1] ?? null;
}

function describePeerError(code: string): string {
  switch (code) {
    case "peer-unavailable":
      return "Bu UID şu anda çevrimiçi değil veya mevcut değil.";
    case "network":
      return "Sinyal sunucusuyla bağlantı kurulamadı.";
    case "browser-incompatible":
      return "Tarayıcınız WebRTC desteklemiyor.";
    case "webrtc":
      return "WebRTC bağlantı hatası.";
    case "disconnected":
      return "Sinyal sunucusu bağlantısı kesildi.";
    default:
      return `Bağlantı hatası (${code}).`;
  }
}
