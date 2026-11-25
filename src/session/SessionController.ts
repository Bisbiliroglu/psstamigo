/**
 * Session state machine and connection authorization (FR-003, FR-004, FR-006, PRIV-011).
 *
 * Phases: idle -> requesting -> active -> idle
 *         idle -> (incoming request accepted) -> active -> idle
 *
 * Authorization rules:
 *  - A UID alone grants nothing. Media is only exchanged with a peer whose
 *    join request was explicitly accepted by the local user, or who explicitly
 *    accepted our own request.
 *  - Incoming media from any other peer, a second call, or an offer containing
 *    video is closed without answering.
 *  - All data messages are validated (protocol.ts) and rate limited.
 *
 * TW/PA-001 spike scope: 1:1 sessions only. Group mesh is PA-006.
 */
import { LIMITS, MAX_PARTICIPANTS, TIMEOUTS } from "../core/config";
import { Emitter } from "../core/emitter";
import { RateLimiter } from "../core/rateLimiter";
import { isValidUid, normalizeUid } from "../core/uid";
import { ChatLog, type ChatEntry } from "../messaging/ChatLog";
import type { DataLink, MediaLink, Signaling } from "../signaling/types";
import { parseMessage, sanitizeChatText, type ProtocolMessage, type RejectReason } from "./protocol";

export type SessionPhase = "idle" | "requesting" | "active";
export type MediaStatus = "connecting" | "connected" | "failed";

export interface ParticipantView {
  readonly peerId: string;
  readonly name: string;
  readonly media: MediaStatus;
  readonly iceState: string;
}

export interface IncomingRequestView {
  readonly id: number;
  readonly peerId: string;
  readonly name: string;
}

export interface Notice {
  readonly kind: "info" | "error";
  readonly text: string;
}

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly target: string | null;
  readonly participants: readonly ParticipantView[];
  readonly incoming: readonly IncomingRequestView[];
  readonly chat: readonly ChatEntry[];
  readonly notice: Notice | null;
}

/** Audio side effects, implemented by the app layer (keeps session free of Web Audio). */
export interface SessionMediaHooks {
  /** Synthetic silent stream used only to create the audio m-line (never a microphone). */
  createSilentStream(): MediaStream;
  addSender(peerId: string, sender: RTCRtpSender): void;
  removeSender(peerId: string, sender: RTCRtpSender): void;
  addRemoteStream(peerId: string, stream: MediaStream): void;
  removeRemoteStream(peerId: string): void;
  /** Session fully ended: return to safe defaults (mic off, speaker off). */
  sessionEnded(): void;
}

export interface SessionDeps {
  signaling: Signaling;
  media: SessionMediaHooks;
  getDisplayName(): string;
}

interface Participant {
  peerId: string;
  name: string;
  data: DataLink;
  limiter: RateLimiter;
  /** Who places the media call: the requester calls, the accepter answers. */
  role: "caller" | "answerer";
  media: MediaLink | null;
  mediaStatus: MediaStatus;
  iceState: string;
  sender: RTCRtpSender | null;
  mediaTimer: ReturnType<typeof setTimeout> | null;
  pc: RTCPeerConnection | null;
  pcListener: (() => void) | null;
}

interface PendingIncoming {
  id: number;
  peerId: string;
  name: string;
  link: DataLink;
  limiter: RateLimiter;
  timer: ReturnType<typeof setTimeout>;
}

interface OutgoingRequest {
  peerId: string;
  link: DataLink;
  timer: ReturnType<typeof setTimeout>;
}

const REJECT_TEXT: Record<RejectReason, string> = {
  declined: "Bağlantı isteğiniz reddedildi.",
  busy: "Karşı taraf şu anda başka bir görüşmede veya meşgul.",
  timeout: "Bağlantı isteği yanıtlanmadı (zaman aşımı).",
  full: "Görüşme dolu.",
  invalid: "Bağlantı isteği geçersiz bulundu.",
};

export class SessionController {
  private phase: SessionPhase = "idle";
  private outgoing: OutgoingRequest | null = null;
  private readonly participants = new Map<string, Participant>();
  private readonly pending = new Map<number, PendingIncoming>();
  private readonly chat = new ChatLog();
  private notice: Notice | null = null;
  private nextRequestId = 1;
  private disposed = false;
  private readonly events = new Emitter<{ change: SessionSnapshot }>();
  private readonly unsubscribers: Array<() => void> = [];
  /** Links we are handling but which have not yet sent a valid join request. */
  private readonly unauthenticated = new Set<DataLink>();

  constructor(private readonly deps: SessionDeps) {
    const s = deps.signaling;
    this.unsubscribers.push(
      s.on("incomingData", (link) => this.handleIncomingData(link)),
      s.on("incomingMedia", (link) => this.handleIncomingMedia(link)),
      s.on("error", (e) => {
        if (e.code === "peer-unavailable" && this.outgoing) {
          this.failOutgoing("Bu UID şu anda çevrimiçi değil veya mevcut değil.");
        }
      }),
    );
  }

  onChange(cb: (s: SessionSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): SessionSnapshot {
    return {
      phase: this.phase,
      target: this.outgoing?.peerId ?? null,
      participants: [...this.participants.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        media: p.mediaStatus,
        iceState: p.iceState,
      })),
      incoming: [...this.pending.values()].map((r) => ({ id: r.id, peerId: r.peerId, name: r.name })),
      chat: this.chat.list(),
      notice: this.notice,
    };
  }

  /** Underlying peer connection of a participant, for diagnostics only. */
  getPeerConnection(peerId: string): RTCPeerConnection | null {
    return this.participants.get(peerId)?.pc ?? null;
  }

  dismissNotice(): void {
    if (this.notice) {
      this.notice = null;
      this.emit();
    }
  }

  // ---------------------------------------------------------------- outgoing

  requestJoin(rawTarget: string): void {
    if (this.disposed) return;
    const target = normalizeUid(rawTarget);
    if (!isValidUid(target)) return this.setNotice("error", "Geçersiz UID. Örnek biçim: psst-abcd-efgh-jkmn");
    if (target === this.deps.signaling.uid) return this.setNotice("error", "Kendinize bağlanamazsınız.");
    if (this.deps.signaling.state !== "online") return this.setNotice("error", "Sinyal sunucusuna bağlı değilsiniz.");
    if (this.phase === "requesting") return this.setNotice("info", "Zaten bekleyen bir isteğiniz var.");
    if (this.phase === "active") {
      return this.setNotice("info", "Grup görüşmesi henüz desteklenmiyor (PA-006). Önce görüşmeden ayrılın.");
    }

    let link: DataLink;
    try {
      link = this.deps.signaling.connect(target);
    } catch {
      return this.setNotice("error", "Bağlantı başlatılamadı.");
    }

    const timer = setTimeout(() => {
      if (this.outgoing?.link === link) this.failOutgoing("Karşı tarafa ulaşılamadı veya istek yanıtlanmadı (zaman aşımı).");
    }, TIMEOUTS.dataOpenMs);

    this.outgoing = { peerId: target, link, timer };
    this.phase = "requesting";
    this.notice = null;
    this.emit();

    link.onOpen(() => {
      if (this.outgoing?.link !== link) return link.close();
      link.send({ t: "join-request", v: 1, name: this.deps.getDisplayName() } satisfies ProtocolMessage);
      clearTimeout(this.outgoing.timer);
      this.outgoing.timer = setTimeout(() => {
        if (this.outgoing?.link === link) {
          link.send({ t: "cancel", v: 1 } satisfies ProtocolMessage);
          this.failOutgoing("Bağlantı isteği yanıtlanmadı (zaman aşımı).");
        }
      }, TIMEOUTS.requestAnswerMs);
    });
    link.onData((raw) => this.handleOutgoingData(link, raw));
    link.onClose(() => {
      if (this.outgoing?.link === link) this.failOutgoing("Bağlantı kapandı.");
    });
    link.onError(() => {
      if (this.outgoing?.link === link) this.failOutgoing("Bağlantı kurulamadı.");
    });
  }

  cancelRequest(): void {
    const out = this.outgoing;
    if (!out) return;
    out.link.send({ t: "cancel", v: 1 } satisfies ProtocolMessage);
    this.clearOutgoing();
    this.phase = "idle";
    this.setNotice("info", "İstek iptal edildi.");
  }

  private handleOutgoingData(link: DataLink, raw: unknown): void {
    const out = this.outgoing;
    if (!out || out.link !== link) return;
    const msg = parseMessage(raw);
    if (!msg) return this.failOutgoing("Karşı taraftan geçersiz yanıt alındı.");
    if (msg.t === "join-reject") return this.failOutgoing(REJECT_TEXT[msg.reason]);
    if (msg.t !== "join-accept") return; // ignore anything else before acceptance

    clearTimeout(out.timer);
    this.outgoing = null;
    const participant = this.addParticipant(out.peerId, msg.name, link, "caller");
    this.phase = "active";
    this.notice = { kind: "info", text: `${displayLabel(participant)} isteğinizi kabul etti.` };
    this.emit();
    this.startOutgoingCall(participant);
  }

  private failOutgoing(text: string): void {
    this.clearOutgoing();
    if (this.phase === "requesting") this.phase = "idle";
    this.setNotice("error", text);
  }

  private clearOutgoing(): void {
    const out = this.outgoing;
    if (!out) return;
    this.outgoing = null;
    clearTimeout(out.timer);
    out.link.close();
  }

  // ---------------------------------------------------------------- incoming

  private handleIncomingData(link: DataLink): void {
    if (this.disposed) return link.close();
    const peerId = link.peerId;
    if (!isValidUid(peerId) || peerId === this.deps.signaling.uid) return link.close();

    this.unauthenticated.add(link);
    const limiter = new RateLimiter(LIMITS.messagesPerWindow, LIMITS.rateWindowMs);
    const handshakeTimer = setTimeout(() => {
      if (this.unauthenticated.delete(link)) link.close();
    }, TIMEOUTS.dataOpenMs);

    link.onData((raw) => {
      if (!this.unauthenticated.has(link)) return;
      this.unauthenticated.delete(link);
      clearTimeout(handshakeTimer);
      const msg = parseMessage(raw);
      if (!msg || msg.t !== "join-request") {
        link.send({ t: "join-reject", v: 1, reason: "invalid" } satisfies ProtocolMessage);
        return link.close();
      }
      this.handleJoinRequest(link, msg.name, limiter);
    });
    link.onClose(() => {
      if (this.unauthenticated.delete(link)) clearTimeout(handshakeTimer);
    });
  }

  private handleJoinRequest(link: DataLink, name: string, limiter: RateLimiter): void {
    const peerId = link.peerId;
    const reject = (reason: RejectReason): void => {
      link.send({ t: "join-reject", v: 1, reason } satisfies ProtocolMessage);
      link.close();
    };

    // Duplicate request from the same peer, or peer already in the session: drop silently.
    if (this.participants.has(peerId) || [...this.pending.values()].some((r) => r.peerId === peerId)) {
      return link.close();
    }
    if (this.phase !== "idle") return reject("busy");
    if (this.participants.size + 1 >= MAX_PARTICIPANTS) return reject("full");
    if (this.pending.size >= LIMITS.pendingRequests) return reject("busy");

    const id = this.nextRequestId++;
    const timer = setTimeout(() => {
      const req = this.pending.get(id);
      if (!req) return;
      this.pending.delete(id);
      reject("timeout");
      this.emit();
    }, TIMEOUTS.incomingRequestMs);

    this.pending.set(id, { id, peerId, name, link, limiter, timer });

    link.onData((raw) => {
      const req = this.pending.get(id);
      if (!req || req.link !== link) return;
      if (!limiter.tryConsume()) return this.dropPending(id);
      const msg = parseMessage(raw);
      if (msg?.t === "cancel") this.dropPending(id, `${name || peerId} isteğini iptal etti.`);
    });
    link.onClose(() => {
      if (this.pending.get(id)?.link === link) this.dropPending(id);
    });
    this.emit();
  }

  private dropPending(id: number, info?: string): void {
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    clearTimeout(req.timer);
    req.link.close();
    if (info) this.notice = { kind: "info", text: info };
    this.emit();
  }

  acceptRequest(id: number): void {
    const req = this.pending.get(id);
    if (!req || this.disposed) return;
    if (this.phase !== "idle" || !req.link.isOpen) {
      this.dropPending(id);
      return;
    }
    this.pending.delete(id);
    clearTimeout(req.timer);

    // 1:1 spike: any other pending request is now busy.
    for (const other of [...this.pending.keys()]) this.rejectRequest(other, "busy");

    req.link.send({ t: "join-accept", v: 1, name: this.deps.getDisplayName() } satisfies ProtocolMessage);
    const participant = this.addParticipant(req.peerId, req.name, req.link, "answerer", req.limiter);
    this.phase = "active";
    this.notice = null;
    this.armMediaTimer(participant);
    this.emit();
  }

  rejectRequest(id: number, reason: RejectReason = "declined"): void {
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    clearTimeout(req.timer);
    req.link.send({ t: "join-reject", v: 1, reason } satisfies ProtocolMessage);
    req.link.close();
    this.emit();
  }

  // ---------------------------------------------------------------- participants

  private addParticipant(
    peerId: string,
    name: string,
    data: DataLink,
    role: Participant["role"],
    limiter = new RateLimiter(LIMITS.messagesPerWindow, LIMITS.rateWindowMs),
  ): Participant {
    const p: Participant = {
      peerId,
      name,
      data,
      limiter,
      role,
      media: null,
      mediaStatus: "connecting",
      iceState: "new",
      sender: null,
      mediaTimer: null,
      pc: null,
      pcListener: null,
    };
    this.participants.set(peerId, p);

    data.onData((raw) => {
      if (this.participants.get(peerId) !== p) return;
      if (!p.limiter.tryConsume()) return; // excess messages are dropped
      const msg = parseMessage(raw);
      if (!msg) return;
      if (msg.t === "chat") {
        this.chat.add(false, displayLabel(p), msg.text);
        this.emit();
      } else if (msg.t === "leave") {
        this.removeParticipant(peerId, `${displayLabel(p)} görüşmeden ayrıldı.`);
      }
    });
    data.onClose(() => {
      if (this.participants.get(peerId) === p) this.removeParticipant(peerId, `${displayLabel(p)} ile bağlantı kesildi.`);
    });
    return p;
  }

  private removeParticipant(peerId: string, info: string | null): void {
    const p = this.participants.get(peerId);
    if (!p) return;
    this.participants.delete(peerId);
    this.teardownParticipant(p);
    if (info) this.notice = { kind: "info", text: info };
    if (this.participants.size === 0) this.endSession();
    else this.emit();
  }

  private teardownParticipant(p: Participant): void {
    if (p.mediaTimer) clearTimeout(p.mediaTimer);
    p.mediaTimer = null;
    if (p.pc && p.pcListener) {
      p.pc.removeEventListener("iceconnectionstatechange", p.pcListener);
      p.pc.removeEventListener("connectionstatechange", p.pcListener);
    }
    if (p.sender) this.deps.media.removeSender(p.peerId, p.sender);
    p.sender = null;
    this.deps.media.removeRemoteStream(p.peerId);
    p.media?.close();
    p.media = null;
    p.pc = null;
    p.data.close();
  }

  private endSession(): void {
    this.phase = "idle";
    this.chat.clear(); // ephemeral: history is gone when the session ends
    this.deps.media.sessionEnded();
    this.emit();
  }

  // ---------------------------------------------------------------- media

  private startOutgoingCall(p: Participant): void {
    let silent: MediaStream;
    let link: MediaLink;
    try {
      silent = this.deps.media.createSilentStream();
      link = this.deps.signaling.call(p.peerId, silent);
    } catch {
      this.markMediaFailed(p, "Ses bağlantısı başlatılamadı.");
      return;
    }
    p.media = link;
    this.armMediaTimer(p);
    this.attachMedia(p, link, silent);
  }

  private handleIncomingMedia(link: MediaLink): void {
    const p = this.participants.get(link.peerId);
    // Only the accepted peer, only once, only audio. Everything else is closed unanswered.
    if (this.disposed || this.phase !== "active" || !p || p.role !== "answerer" || p.media || link.offerHasVideo) {
      link.close();
      return;
    }
    let silent: MediaStream;
    try {
      silent = this.deps.media.createSilentStream();
      link.answer(silent);
    } catch {
      link.close();
      this.markMediaFailed(p, "Ses bağlantısı kurulamadı.");
      return;
    }
    p.media = link;
    this.attachMedia(p, link, silent);
  }

  private attachMedia(p: Participant, link: MediaLink, silent: MediaStream): void {
    const pc = link.getPeerConnection();
    if (pc) {
      p.pc = pc;
      const sender = pc.getSenders().find((s) => s.track?.kind === "audio") ?? null;
      if (sender) {
        p.sender = sender;
        // Mic controller decides: live mic track if mic is on, otherwise null (nothing is sent).
        this.deps.media.addSender(p.peerId, sender);
      }
      const update = (): void => {
        if (this.participants.get(p.peerId) !== p) return;
        p.iceState = pc.iceConnectionState;
        if (pc.connectionState === "failed" || pc.iceConnectionState === "failed") {
          this.markMediaFailed(p, "Ses bağlantısı koptu veya kurulamadı (NAT/ağ kısıtı olabilir).");
          return;
        }
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          if (p.mediaStatus !== "connected") {
            p.mediaStatus = "connected";
            if (p.mediaTimer) clearTimeout(p.mediaTimer);
            p.mediaTimer = null;
          }
        }
        this.emit();
      };
      p.pcListener = update;
      pc.addEventListener("iceconnectionstatechange", update);
      pc.addEventListener("connectionstatechange", update);
    }
    // The synthetic silent track is no longer needed once the sender is registered.
    for (const t of silent.getTracks()) t.stop();

    link.onStream((stream) => {
      if (this.participants.get(p.peerId) !== p || p.media !== link) return;
      if (stream.getVideoTracks().length > 0) {
        this.markMediaFailed(p, "Video içeren bağlantı reddedildi.");
        return;
      }
      this.deps.media.addRemoteStream(p.peerId, stream);
    });
    link.onClose(() => {
      if (this.participants.get(p.peerId) === p && p.media === link) {
        this.markMediaFailed(p, "Ses bağlantısı kapandı.");
      }
    });
    link.onError(() => {
      if (this.participants.get(p.peerId) === p && p.media === link) {
        this.markMediaFailed(p, "Ses bağlantısı hatası.");
      }
    });
  }

  private armMediaTimer(p: Participant): void {
    if (p.mediaTimer) clearTimeout(p.mediaTimer);
    p.mediaTimer = setTimeout(() => {
      p.mediaTimer = null;
      if (this.participants.get(p.peerId) === p && p.mediaStatus === "connecting") {
        this.markMediaFailed(p, "Ses bağlantısı zamanında kurulamadı (NAT/ağ kısıtı olabilir).");
      }
    }, TIMEOUTS.mediaSetupMs);
  }

  /** Media failure: stop sending/playing for this peer; text chat may still work. */
  private markMediaFailed(p: Participant, text: string): void {
    if (p.mediaStatus === "failed") return;
    p.mediaStatus = "failed";
    if (p.mediaTimer) clearTimeout(p.mediaTimer);
    p.mediaTimer = null;
    if (p.sender) this.deps.media.removeSender(p.peerId, p.sender);
    p.sender = null;
    this.deps.media.removeRemoteStream(p.peerId);
    const media = p.media;
    p.media = null;
    media?.close();
    this.notice = { kind: "error", text };
    this.emit();
  }

  // ---------------------------------------------------------------- chat & leave

  sendChat(raw: string): boolean {
    if (this.phase !== "active") return false;
    const text = sanitizeChatText(raw);
    if (text === null) return false;
    const msg: ProtocolMessage = { t: "chat", v: 1, text };
    for (const p of this.participants.values()) p.data.send(msg);
    this.chat.add(true, this.deps.getDisplayName() || "Ben", text);
    this.emit();
    return true;
  }

  /** Leave the active session. The UID / signaling connection stays available. */
  leave(): void {
    if (this.outgoing) this.cancelRequest();
    if (this.participants.size === 0) {
      if (this.phase !== "idle") this.endSession();
      return;
    }
    for (const p of this.participants.values()) {
      p.data.send({ t: "leave", v: 1 } satisfies ProtocolMessage);
    }
    for (const p of [...this.participants.values()]) {
      this.participants.delete(p.peerId);
      this.teardownParticipant(p);
    }
    this.notice = { kind: "info", text: "Görüşmeden ayrıldınız." };
    this.endSession();
  }

  /** Full teardown (page termination). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.leave();
    for (const id of [...this.pending.keys()]) this.rejectRequest(id, "busy");
    for (const link of this.unauthenticated) link.close();
    this.unauthenticated.clear();
    this.disposed = true;
    for (const u of this.unsubscribers) u();
    this.events.clear();
  }

  private setNotice(kind: Notice["kind"], text: string): void {
    this.notice = { kind, text };
    this.emit();
  }

  private emit(): void {
    if (!this.disposed) this.events.emit("change", this.snapshot());
  }
}

function displayLabel(p: { name: string; peerId: string }): string {
  return p.name || p.peerId;
}
