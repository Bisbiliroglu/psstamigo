/**
 * The only module that imports PeerJS. Wraps Peer / DataConnection / MediaConnection
 * behind the transport interfaces in ./types.
 */
import { Peer, type DataConnection, type MediaConnection, type PeerError } from "peerjs";
import { ICE_SERVERS, LIMITS, TIMEOUTS } from "../core/config";
import { Emitter } from "../core/emitter";
import { generateUid } from "../core/uid";
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
}

/** Reads the remote offer SDP of an incoming call (PeerJS keeps it in options._payload). */
function readOfferSdp(call: MediaConnection): string {
  const options = (call as unknown as { options?: { _payload?: { sdp?: { sdp?: unknown } } } }).options;
  const sdp = options?._payload?.sdp?.sdp;
  return typeof sdp === "string" ? sdp : "";
}

class PeerJsMediaLink implements MediaLink {
  readonly offerHasVideo: boolean;

  constructor(private readonly call: MediaConnection, incoming: boolean) {
    this.offerHasVideo = incoming ? /^m=video/m.test(readOfferSdp(call)) : false;
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

export class PeerJsSignaling implements Signaling {
  private peer: Peer | null = null;
  private readonly events = new Emitter<SignalingEvents>();
  private currentState: SignalingState = "offline";
  private currentUid: string | null = null;
  private attempts = 0;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** True once the UID was registered; afterwards signaling errors never destroy P2P links. */
  private registered = false;

  get uid(): string | null {
    return this.currentUid;
  }

  get state(): SignalingState {
    return this.currentState;
  }

  on<K extends keyof SignalingEvents>(event: K, cb: (payload: SignalingEvents[K]) => void): () => void {
    return this.events.on(event, cb);
  }

  start(): void {
    if (this.destroyed || this.peer) return;
    this.attempts = 0;
    this.createPeer();
  }

  private setState(state: SignalingState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.events.emit("state", state);
  }

  private createPeer(): void {
    this.attempts += 1;
    const uid = generateUid();
    this.currentUid = null;
    this.setState("connecting");

    // Explicit config replaces PeerJS defaults, removing its undocumented TURN server (D-003).
    const peer = new Peer(uid, { config: { iceServers: ICE_SERVERS }, debug: 0 });
    this.peer = peer;

    this.clearOpenTimer();
    this.openTimer = setTimeout(() => {
      if (this.peer !== peer || this.currentState === "online") return;
      this.fail("signaling-timeout", "Sinyal sunucusuna bağlanılamadı (zaman aşımı).");
    }, TIMEOUTS.signalingOpenMs);

    peer.on("open", (id) => {
      if (this.peer !== peer) return;
      this.clearOpenTimer();
      this.currentUid = id;
      this.registered = true;
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
      if (this.peer !== peer || this.destroyed) return;
      // Signaling lost; existing P2P links may still work. One bounded reconnect attempt.
      this.setState("offline");
      setTimeout(() => {
        if (this.peer === peer && !peer.destroyed && peer.disconnected) {
          try {
            peer.reconnect();
          } catch {
            /* reported via error event */
          }
        }
      }, 2_000);
    });

    peer.on("error", (err: PeerError<string>) => {
      if (this.peer !== peer) return;
      const code = String(err.type);
      if (code === "unavailable-id" && !this.registered) {
        // UID collision: regenerate safely, bounded retries.
        peer.destroy();
        this.peer = null;
        if (this.attempts < LIMITS.uidRetries) {
          this.createPeer();
        } else {
          this.fail(code, "Benzersiz UID alınamadı. Sayfayı yenileyin.");
        }
        return;
      }
      const fatal = ["browser-incompatible", "invalid-id", "invalid-key", "ssl-unavailable", "server-error", "socket-error", "socket-closed"].includes(code);
      if (fatal && !this.registered) {
        this.fail(code, describePeerError(code));
        return;
      }
      if (fatal) this.setState("offline");
      this.events.emit("error", { code, message: describePeerError(code), fatal: false });
    });
  }

  private fail(code: string, message: string): void {
    this.clearOpenTimer();
    this.peer?.destroy();
    this.peer = null;
    this.currentUid = null;
    this.setState("failed");
    this.events.emit("error", { code, message, fatal: true });
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
    if (!this.peer) throw new Error("signaling-offline");
    const call = this.peer.call(peerId, stream);
    if (!call) throw new Error("call-failed");
    return new PeerJsMediaLink(call, false);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearOpenTimer();
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
