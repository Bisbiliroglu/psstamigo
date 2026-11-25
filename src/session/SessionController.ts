/**
 * Group session state machine, admission and connection authorization
 * (FR-003…FR-006, GR-001…GR-010, PRIV-011). Full P2P mesh, max MAX_PARTICIPANTS.
 *
 * Each peer keeps its own local membership. Nothing a peer says about other peers is
 * trusted: every member authorizes a newcomer with its OWN explicit approval, and only
 * accepts the newcomer's mesh link / media offer if it approved that admission itself.
 *
 * Admission (candidate C contacts member B, B is the temporary coordinator):
 *   C→B join-request · B→C join-pending · B→members admit-propose(member snapshot)
 *   members→B admit-vote (own link only) · B→C join-accept(member list, only after ALL accepted)
 *   C→each member: data link + mesh-hello → mesh-ack → C calls (silent)
 *   members→B admit-ready · B→all admit-commit  ⇒ only now: sender attached, playback allowed
 * Any reject / timeout / cancel / coordinator departure / membership change ⇒ abort, rollback.
 *
 * The joining party always initiates data + media links, so each pair has exactly one
 * application DataConnection and one MediaConnection (no duplicates, no glare).
 */
import { LIMITS, LOW_BANDWIDTH_BITRATE_BPS, LOW_BANDWIDTH_THRESHOLD, MAX_PARTICIPANTS, TIMEOUTS } from "../core/config";
import { Emitter } from "../core/emitter";
import { RateLimiter } from "../core/rateLimiter";
import { isValidUid, normalizeUid } from "../core/uid";
import { ChatLog, type ChatEntry } from "../messaging/ChatLog";
import type { DataLink, MediaLink, Signaling } from "../signaling/types";
import { BoundedSet, memberSnapshot, newMessageId, newSessionId, sameMembers } from "./admission";
import {
  otherProtocolVersion,
  parseMessage,
  sanitizeChatText,
  type MemberInfo,
  type ProtocolMessage,
  type RejectReason,
  type Vote,
} from "./protocol";

export type SessionPhase = "idle" | "requesting" | "active";
export type JoinStage = "contacting" | "approval" | "connecting";
export type MediaStatus = "connecting" | "connected" | "interrupted" | "failed";

export interface ParticipantView {
  readonly peerId: string;
  readonly name: string;
  readonly media: MediaStatus;
  readonly iceState: string;
}

export interface AdmissionView {
  /** Local UI id (not a protocol id). */
  readonly id: number;
  readonly peerId: string;
  readonly name: string;
  /** Member who forwarded the request (null if the candidate contacted us). */
  readonly via: { readonly peerId: string; readonly name: string } | null;
  readonly stage: "voting" | "connecting";
  readonly myVote: "pending" | "accept";
  /** Only known to the coordinator. */
  readonly approvals: number | null;
  readonly required: number | null;
}

export interface Notice {
  readonly kind: "info" | "error";
  readonly text: string;
}

export interface SessionSnapshot {
  readonly phase: SessionPhase;
  readonly target: string | null;
  readonly joinStage: JoinStage | null;
  readonly participants: readonly ParticipantView[];
  readonly incoming: readonly AdmissionView[];
  readonly chat: readonly ChatEntry[];
  readonly notice: Notice | null;
  readonly capacity: { readonly count: number; readonly max: number };
  /** True while outbound voice bitrate is capped because the group is large (D-020). */
  readonly lowBandwidth: boolean;
  /** True if the bitrate cap could not be applied to at least one sender (UI must not claim success). */
  readonly bandwidthLimitFailed: boolean;
}

/** Audio side effects, implemented by the app layer (keeps session free of Web Audio). */
export interface SessionMediaHooks {
  /** Synthetic silent stream used only to create the audio m-line (never a microphone). */
  createSilentStream(): MediaStream;
  /** Called only for COMMITTED members. */
  addSender(peerId: string, sender: RTCRtpSender): void;
  removeSender(peerId: string, sender: RTCRtpSender): void;
  /** Called only for COMMITTED members. */
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

type Timer = ReturnType<typeof setTimeout>;

/** One application DataConnection (+ at most one MediaConnection) with one peer. */
interface PeerLink {
  peerId: string;
  name: string;
  data: DataLink;
  media: MediaLink | null;
  pc: RTCPeerConnection | null;
  pcListener: (() => void) | null;
  sender: RTCRtpSender | null;
  remoteStream: MediaStream | null;
  mediaStatus: MediaStatus;
  iceState: string;
  mediaTimer: Timer | null;
  /** True once membership is committed: only then audio may be sent or played. */
  committed: boolean;
  chatIds: BoundedSet<string>;
  /** Fired once when the voice path of an uncommitted link connects. */
  onReady: (() => void) | null;
  /** Liveness watch of the data link's peer connection (committed members only). */
  dataPc: RTCPeerConnection | null;
  dataListener: (() => void) | null;
  lostTimer: Timer | null;
}

interface Admission {
  uiId: number;
  aid: string;
  candidate: string;
  candidateName: string;
  /** Coordinator UID (equals our own UID if we coordinate). */
  coordinator: string;
  /** Member set (incl. us and the coordinator) this admission was approved for. */
  snapshot: string[];
  myVote: "pending" | "accept";
  stage: "voting" | "connecting";
  /** Coordinator only: members that accepted (incl. itself). */
  votes: Set<string>;
  /** Coordinator only: members whose link to the candidate is up (incl. itself). */
  ready: Set<string>;
  /** Coordinator only: the candidate's original link until all members accepted. */
  requestLink: DataLink | null;
  /** Our own link with the candidate once connecting. */
  candidateLink: PeerLink | null;
  /**
   * Messages the candidate sent on its link before WE committed it (it may have received the
   * coordinator's commit earlier over another channel). Replayed after our own commit, dropped on abort.
   */
  early: ProtocolMessage[];
  timer: Timer;
}

interface Joining {
  target: string;
  stage: JoinStage;
  aid: string | null;
  sid: string | null;
  coordinatorLink: DataLink;
  expected: MemberInfo[];
  links: Map<string, PeerLink>;
  pendingMesh: Map<string, DataLink>;
  /** Member messages that overtook the coordinator's commit; replayed after commitJoin(). */
  early: Array<{ from: string; msg: ProtocolMessage }>;
  timer: Timer;
}

/** Max messages kept from a peer whose membership we have not committed yet. */
const EARLY_LIMIT = 16;

const REJECT_TEXT: Record<RejectReason, string> = {
  declined: "Katılım isteği reddedildi.",
  busy: "Karşı tarafta şu anda başka bir bağlantı veya katılım işlemi sürüyor. Biraz sonra tekrar deneyin.",
  timeout: "Katılım isteği zamanında yanıtlanmadı.",
  full: "Görüşme kapasitesi dolu.",
  invalid: "Bağlantı isteği geçersiz bulundu.",
  conflict: "Görüşme üyeliği değiştiği için katılım tamamlanamadı. Biraz sonra tekrar deneyin.",
  failed: "Katılımcılarla bağlantı kurulamadı (NAT/ağ kısıtı olabilir).",
  version: "Karşı taraf farklı bir PsstAmigo sürümü kullanıyor. İki taraf da sayfayı yenilesin.",
};

function admissionAbortText(reason: RejectReason, name: string): string {
  switch (reason) {
    case "declined":
      return `${name} için katılım isteği reddedildi.`;
    case "timeout":
      return `${name} için katılım isteği zaman aşımına uğradı.`;
    case "failed":
      return `${name} ile bağlantı kurulamadı.`;
    case "busy":
      return `${name} için katılım, başka bir işlem sürdüğü için iptal edildi.`;
    case "conflict":
      return `${name} için katılım, üyelik değiştiği için iptal edildi.`;
    case "full":
      return "Görüşme kapasitesi dolu.";
    case "invalid":
      return `${name} bağlantısı güvenlik denetiminden geçmedi.`;
    case "version":
      return `${name} farklı bir sürüm kullanıyor.`;
  }
}

/** Sets (or clears, with null) the max bitrate of every encoding of an audio sender. Errors are ignored. */
/** Returns true if the sender now has the requested cap (or nothing had to change). */
async function setVoiceBitrate(sender: RTCRtpSender, bps: number | null): Promise<boolean> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) return bps === null; // not negotiated: cap not applied
    let changed = false;
    for (const enc of params.encodings) {
      if (bps === null) {
        if (enc.maxBitrate !== undefined) {
          delete enc.maxBitrate;
          changed = true;
        }
      } else if (enc.maxBitrate !== bps) {
        enc.maxBitrate = bps;
        changed = true;
      }
    }
    if (changed) await sender.setParameters(params);
    return true;
  } catch {
    return false; // sender closed or parameters not settable: default bitrate stays, reported to the UI
  }
}

function label(p: { name: string; peerId: string }): string {
  return p.name || p.peerId;
}

export class SessionController {
  private sid: string | null = null;
  private readonly members = new Map<string, PeerLink>();
  private admission: Admission | null = null;
  private joining: Joining | null = null;
  private readonly finished = new BoundedSet<string>(LIMITS.finishedAdmissions);
  private readonly limiters = new Map<DataLink, RateLimiter>();
  /** Incoming links that have not sent a valid first message yet. */
  private readonly unauthenticated = new Map<DataLink, Timer>();
  private readonly chat = new ChatLog();
  private notice: Notice | null = null;
  private nextUiId = 1;
  private disposed = false;
  private readonly events = new Emitter<{ change: SessionSnapshot }>();
  private readonly unsubscribers: Array<() => void> = [];
  private lowBandwidth = false;
  private bandwidthLimitFailed = false;
  private bandwidthGeneration = 0;
  /**
   * A proposal received while our own admission was still connecting; it can only be judged
   * after that admission commits or aborts (cross-channel ordering, PA-006B).
   */
  private deferredProposal: { from: string; msg: Extract<ProtocolMessage, { t: "admit-propose" }> } | null = null;

  constructor(private readonly deps: SessionDeps) {
    const s = deps.signaling;
    this.unsubscribers.push(
      s.on("incomingData", (link) => this.handleIncomingData(link)),
      s.on("incomingMedia", (link) => this.handleIncomingMedia(link)),
      s.on("error", (e) => {
        const j = this.joining;
        if (e.code !== "peer-unavailable" || !j) return;
        if (j.stage === "contacting" && (e.peerId === null || e.peerId === j.target)) {
          this.failJoining("Bu UID şu anda çevrimiçi değil veya mevcut değil.", false);
        } else if (e.peerId !== null && j.pendingMesh.has(e.peerId)) {
          this.failJoining(REJECT_TEXT.failed, true);
        }
      }),
    );
  }

  // ================================================================ views

  onChange(cb: (s: SessionSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): SessionSnapshot {
    const adm = this.admission;
    const me = this.selfUid();
    return {
      phase: this.joining ? "requesting" : this.members.size > 0 ? "active" : "idle",
      target: this.joining?.target ?? null,
      joinStage: this.joining?.stage ?? null,
      participants: [...this.members.values()].map((p) => ({
        peerId: p.peerId,
        name: p.name,
        media: p.mediaStatus,
        iceState: p.iceState,
      })),
      incoming: adm
        ? [
            {
              id: adm.uiId,
              peerId: adm.candidate,
              name: adm.candidateName,
              via:
                adm.coordinator === me
                  ? null
                  : { peerId: adm.coordinator, name: this.members.get(adm.coordinator)?.name ?? "" },
              stage: adm.stage,
              myVote: adm.myVote,
              approvals: adm.coordinator === me ? adm.votes.size : null,
              required: adm.coordinator === me ? adm.snapshot.length : null,
            },
          ]
        : [],
      chat: this.chat.list(),
      notice: this.notice,
      capacity: { count: this.members.size + 1, max: MAX_PARTICIPANTS },
      lowBandwidth: this.lowBandwidth,
      bandwidthLimitFailed: this.bandwidthLimitFailed,
    };
  }

  /** Underlying peer connection of a committed participant, for diagnostics only. */
  getPeerConnection(peerId: string): RTCPeerConnection | null {
    return this.members.get(peerId)?.pc ?? null;
  }

  dismissNotice(): void {
    if (this.notice) {
      this.notice = null;
      this.emit();
    }
  }

  // ================================================================ link plumbing

  private selfUid(): string {
    return this.deps.signaling.uid ?? "";
  }

  /** Every DataLink gets exactly one data router and one close handler. */
  private register(link: DataLink): void {
    this.limiters.set(link, new RateLimiter(LIMITS.messagesPerWindow, LIMITS.rateWindowMs));
    link.onData((raw) => this.route(link, raw));
    link.onClose(() => this.onLinkClosed(link));
    link.onError(() => {
      if (this.joining && this.isJoiningLink(this.joining, link)) this.failJoining(REJECT_TEXT.failed, true);
    });
  }

  /** Forget a link (no further routing) and close it. */
  private dropLink(link: DataLink): void {
    this.limiters.delete(link);
    const t = this.unauthenticated.get(link);
    if (t !== undefined) clearTimeout(t);
    this.unauthenticated.delete(link);
    link.close();
  }

  private newPeerLink(peerId: string, name: string, data: DataLink): PeerLink {
    return {
      peerId,
      name,
      data,
      media: null,
      pc: null,
      pcListener: null,
      sender: null,
      remoteStream: null,
      mediaStatus: "connecting",
      iceState: "new",
      mediaTimer: null,
      committed: false,
      chatIds: new BoundedSet<string>(LIMITS.chatDedup),
      onReady: null,
      dataPc: null,
      dataListener: null,
      lostTimer: null,
    };
  }

  private isTracked(p: PeerLink): boolean {
    return (
      this.members.get(p.peerId) === p ||
      this.admission?.candidateLink === p ||
      this.joining?.links.get(p.peerId) === p
    );
  }

  private isJoiningLink(j: Joining, link: DataLink): boolean {
    return (
      j.coordinatorLink === link ||
      j.links.get(link.peerId)?.data === link ||
      j.pendingMesh.get(link.peerId) === link
    );
  }

  private route(link: DataLink, raw: unknown): void {
    if (this.disposed) return;
    const limiter = this.limiters.get(link);
    if (!limiter) return; // forgotten link
    if (!limiter.tryConsume()) {
      // Excess input is dropped; a flooding unidentified link is closed.
      if (this.unauthenticated.has(link)) this.dropLink(link);
      return;
    }
    const msg = parseMessage(raw);

    if (this.unauthenticated.has(link)) return this.handleFirstMessage(link, msg, raw);

    const j = this.joining;
    if (j && this.isJoiningLink(j, link)) {
      if (msg) return this.handleJoiningMessage(j, link, msg);
      if (link === j.coordinatorLink && otherProtocolVersion(raw) !== null) {
        return this.failJoining(REJECT_TEXT.version, false);
      }
      return;
    }
    if (!msg) return;

    const member = this.members.get(link.peerId);
    if (member && member.data === link) return this.handleMemberMessage(member, msg);

    const adm = this.admission;
    if (adm && (adm.requestLink === link || adm.candidateLink?.data === link)) {
      if (msg.t === "cancel") {
        this.abortAdmission(adm, "declined", `${adm.candidateName || adm.candidate} isteğini iptal etti.`);
      } else if (adm.candidateLink?.data === link && adm.stage === "connecting" && adm.early.length < EARLY_LIMIT) {
        // Not a member for us yet: keep (bounded) and judge only after our own commit; nothing is shown now.
        adm.early.push(msg);
      }
    }
  }

  private onLinkClosed(link: DataLink): void {
    if (!this.limiters.has(link) && !this.unauthenticated.has(link)) return; // already forgotten
    this.limiters.delete(link);
    const t = this.unauthenticated.get(link);
    if (t !== undefined) {
      clearTimeout(t);
      this.unauthenticated.delete(link);
      return;
    }
    const j = this.joining;
    if (j && this.isJoiningLink(j, link)) return this.failJoining("Bağlantı kesildi.", true);

    const member = this.members.get(link.peerId);
    if (member && member.data === link) {
      return this.removeMember(member.peerId, `${label(member)} ile bağlantı kesildi.`);
    }
    const adm = this.admission;
    if (adm && (adm.requestLink === link || adm.candidateLink?.data === link)) {
      if (adm.requestLink === link) adm.requestLink = null;
      this.abortAdmission(adm, "failed");
    }
  }

  // ================================================================ incoming links

  private handleIncomingData(link: DataLink): void {
    if (this.disposed) return link.close();
    const peerId = link.peerId;
    if (!isValidUid(peerId) || peerId === this.selfUid()) return link.close();
    // Bound handshakes that have not identified themselves yet (resource / spam protection).
    if (this.unauthenticated.size >= LIMITS.unauthenticatedLinks) return link.close();
    if ([...this.unauthenticated.keys()].some((l) => l.peerId === peerId)) return link.close();

    const timer = setTimeout(() => {
      if (this.unauthenticated.has(link)) this.dropLink(link);
    }, TIMEOUTS.dataOpenMs);
    this.unauthenticated.set(link, timer);
    this.register(link);
  }

  private handleFirstMessage(link: DataLink, msg: ProtocolMessage | null, raw: unknown): void {
    const t = this.unauthenticated.get(link);
    if (t !== undefined) clearTimeout(t);
    this.unauthenticated.delete(link);

    if (!msg) {
      const v = otherProtocolVersion(raw);
      // Reply in the peer's own version so an older client can show a rejection.
      link.send(v !== null ? { t: "join-reject", v, reason: "invalid" } : { t: "join-reject", v: 2, reason: "invalid" });
      return this.dropLink(link);
    }
    if (msg.t === "join-request") return this.handleJoinRequest(link, msg.name);
    if (msg.t === "mesh-hello") return this.handleMeshHello(link, msg.sid, msg.aid);
    link.send({ t: "join-reject", v: 2, reason: "invalid" } satisfies ProtocolMessage);
    this.dropLink(link);
  }

  // ================================================================ coordinator side

  private handleJoinRequest(link: DataLink, name: string): void {
    const peerId = link.peerId;
    const me = this.selfUid();
    const reject = (reason: RejectReason): void => {
      link.send({ t: "join-reject", v: 2, reason } satisfies ProtocolMessage);
      this.dropLink(link);
    };
    if (this.members.has(peerId)) return this.dropLink(link); // already a member: duplicate link
    if (this.joining) return reject("busy");
    if (this.admission) return this.admission.candidate === peerId ? this.dropLink(link) : reject("busy");
    if (this.members.size + 2 > MAX_PARTICIPANTS) return reject("full");

    const aid = newSessionId();
    const adm: Admission = {
      uiId: this.nextUiId++,
      aid,
      candidate: peerId,
      candidateName: name,
      coordinator: me,
      snapshot: memberSnapshot([me, ...this.members.keys()]),
      myVote: "pending",
      stage: "voting",
      votes: new Set(),
      ready: new Set(),
      requestLink: link,
      candidateLink: null,
      early: [],
      timer: setTimeout(() => this.abortAdmission(adm, "timeout"), TIMEOUTS.admissionVoteMs),
    };
    this.admission = adm;
    link.send({ t: "join-pending", v: 2, aid } satisfies ProtocolMessage);
    if (this.sid) {
      for (const m of this.members.values()) {
        m.data.send({
          t: "admit-propose",
          v: 2,
          sid: this.sid,
          aid,
          candidate: peerId,
          name,
          members: adm.snapshot,
        } satisfies ProtocolMessage);
      }
    }
    this.emit();
  }

  private handleVote(from: PeerLink, aid: string, vote: Vote): void {
    const adm = this.admission;
    if (!adm || adm.coordinator !== this.selfUid() || adm.aid !== aid || adm.stage !== "voting") return;
    if (!adm.snapshot.includes(from.peerId)) return;
    if (vote !== "accept") {
      const reason: RejectReason = vote === "busy" || vote === "conflict" || vote === "full" ? vote : "declined";
      return this.abortAdmission(adm, reason);
    }
    adm.votes.add(from.peerId); // a repeated vote is idempotent
    this.checkVotes(adm);
    this.emit();
  }

  private checkVotes(adm: Admission): void {
    if (this.admission !== adm || adm.stage !== "voting") return;
    if (!adm.snapshot.every((uid) => adm.votes.has(uid))) return;

    // All members (incl. us) approved: tell the candidate whom to connect to.
    const link = adm.requestLink;
    if (!link) return this.abortAdmission(adm, "failed");
    clearTimeout(adm.timer);
    adm.stage = "connecting";
    if (!this.sid) this.sid = newSessionId(); // implicit session creation (GR-001)
    adm.requestLink = null;
    const pl = this.newPeerLink(adm.candidate, adm.candidateName, link);
    adm.candidateLink = pl;
    pl.onReady = () => this.markReady(adm, this.selfUid());
    link.send({
      t: "join-accept",
      v: 2,
      sid: this.sid,
      aid: adm.aid,
      name: this.deps.getDisplayName(),
      members: [...this.members.values()].map((m) => ({ uid: m.peerId, name: m.name })),
    } satisfies ProtocolMessage);
    adm.timer = setTimeout(() => this.abortAdmission(adm, "failed"), TIMEOUTS.meshSetupMs);
  }

  private markReady(adm: Admission, uid: string): void {
    if (this.admission !== adm || adm.stage !== "connecting" || !adm.snapshot.includes(uid)) return;
    adm.ready.add(uid);
    if (adm.snapshot.every((u) => adm.ready.has(u))) this.commitAdmission(adm);
  }

  private commitAdmission(adm: Admission): void {
    const pl = adm.candidateLink;
    if (!pl || !this.sid) return this.abortAdmission(adm, "failed");
    const commit = { t: "admit-commit", v: 2, sid: this.sid, aid: adm.aid } satisfies ProtocolMessage;
    for (const m of this.members.values()) m.data.send(commit);
    pl.data.send(commit);
    this.finishAdmission(adm);
    this.commitLink(pl);
    this.chat.addSystem(`${label(pl)} görüşmeye katıldı.`);
    this.notice = null;
    this.emit();
    this.flushDeferredProposal();
  }

  /** Coordinator: abort and inform everyone. Non-coordinator: local rollback only. */
  private abortAdmission(adm: Admission, reason: RejectReason, text?: string): void {
    if (this.admission !== adm) return;
    if (adm.coordinator === this.selfUid()) {
      if (this.sid) {
        const abort = { t: "admit-abort", v: 2, sid: this.sid, aid: adm.aid, reason } satisfies ProtocolMessage;
        for (const m of this.members.values()) m.data.send(abort);
        adm.candidateLink?.data.send(abort);
      }
      adm.requestLink?.send({ t: "join-reject", v: 2, reason } satisfies ProtocolMessage);
    }
    this.abortLocal(adm, reason, text);
  }

  private abortLocal(adm: Admission, reason: RejectReason, text?: string): void {
    if (this.admission !== adm) return;
    this.finishAdmission(adm);
    if (adm.requestLink) this.dropLink(adm.requestLink);
    if (adm.candidateLink) this.teardownLink(adm.candidateLink);
    const message = text ?? admissionAbortText(reason, adm.candidateName || adm.candidate);
    if (this.members.size > 0) {
      this.chat.addSystem(message);
    } else {
      this.sid = null; // first admission failed: no session was created
      if (reason !== "declined" || text) this.notice = { kind: "info", text: message };
    }
    adm.early.length = 0; // never process anything a rolled-back candidate sent
    this.emit();
    this.flushDeferredProposal();
  }

  private finishAdmission(adm: Admission): void {
    clearTimeout(adm.timer);
    this.finished.add(adm.aid);
    if (this.admission === adm) this.admission = null;
  }

  // ================================================================ member side

  private handleMemberMessage(member: PeerLink, msg: ProtocolMessage): void {
    if (!("sid" in msg) || msg.sid !== this.sid) return; // stale or foreign session
    switch (msg.t) {
      case "chat":
        if (!member.chatIds.add(msg.id)) return; // duplicate
        this.chat.add(false, label(member), msg.text, member.peerId); // sender = authorized link
        this.emit();
        return;
      case "leave":
        return this.removeMember(member.peerId, `${label(member)} görüşmeden ayrıldı.`);
      case "admit-propose":
        return this.handlePropose(member, msg);
      case "admit-vote":
        return this.handleVote(member, msg.aid, msg.vote);
      case "admit-ready": {
        const adm = this.admission;
        if (adm && adm.coordinator === this.selfUid() && adm.aid === msg.aid) this.markReady(adm, member.peerId);
        return;
      }
      case "admit-commit":
        return this.handleCommit(member, msg.aid);
      case "admit-abort": {
        const adm = this.admission;
        if (adm && adm.coordinator === member.peerId && adm.aid === msg.aid) this.abortLocal(adm, msg.reason);
        return;
      }
      default:
        return;
    }
  }

  private handlePropose(
    from: PeerLink,
    msg: Extract<ProtocolMessage, { t: "admit-propose" }>,
  ): void {
    const me = this.selfUid();
    const vote = (v: Vote): void =>
      from.data.send({ t: "admit-vote", v: 2, sid: msg.sid, aid: msg.aid, vote: v } satisfies ProtocolMessage);
    if (this.finished.has(msg.aid) || this.admission?.aid === msg.aid) return; // replay
    const own = this.admission;
    if (
      own &&
      own.stage === "connecting" &&
      !this.deferredProposal &&
      sameMembers(msg.members, [me, ...this.members.keys(), own.candidate])
    ) {
      // The proposer already counts our pending newcomer: wait for our own commit/abort, then judge.
      this.deferredProposal = { from: from.peerId, msg };
      return;
    }
    if (this.admission || this.joining) return vote("busy");
    if (msg.candidate === me || this.members.has(msg.candidate)) return vote("conflict");
    const mine = memberSnapshot([me, ...this.members.keys()]);
    if (!msg.members.includes(from.peerId) || !sameMembers(msg.members, mine)) return vote("conflict");
    if (mine.length + 1 > MAX_PARTICIPANTS) return vote("full");

    const adm: Admission = {
      uiId: this.nextUiId++,
      aid: msg.aid,
      candidate: msg.candidate,
      candidateName: msg.name,
      coordinator: from.peerId,
      snapshot: mine,
      myVote: "pending",
      stage: "voting",
      votes: new Set(),
      ready: new Set(),
      requestLink: null,
      candidateLink: null,
      early: [],
      timer: setTimeout(() => this.abortLocal(adm, "timeout"), TIMEOUTS.admissionVoteMs + TIMEOUTS.localSlackMs),
    };
    this.admission = adm;
    this.emit();
  }

  /** First message of a candidate's mesh link: accepted only with OUR OWN approval. */
  private handleMeshHello(link: DataLink, sid: string, aid: string): void {
    const adm = this.admission;
    if (
      !adm ||
      adm.coordinator === this.selfUid() ||
      adm.aid !== aid ||
      sid !== this.sid ||
      adm.candidate !== link.peerId ||
      adm.myVote !== "accept" ||
      adm.candidateLink
    ) {
      link.send({ t: "join-reject", v: 2, reason: "invalid" } satisfies ProtocolMessage);
      return this.dropLink(link);
    }
    clearTimeout(adm.timer);
    adm.stage = "connecting";
    const pl = this.newPeerLink(adm.candidate, adm.candidateName, link);
    adm.candidateLink = pl;
    pl.onReady = () => {
      if (this.admission !== adm || !this.sid) return;
      this.members.get(adm.coordinator)?.data.send({ t: "admit-ready", v: 2, sid: this.sid, aid: adm.aid } satisfies ProtocolMessage);
    };
    link.send({ t: "mesh-ack", v: 2, sid, aid } satisfies ProtocolMessage);
    adm.timer = setTimeout(() => this.abortLocal(adm, "failed"), TIMEOUTS.meshSetupMs + TIMEOUTS.localSlackMs);
    this.emit();
  }

  private handleCommit(from: PeerLink, aid: string): void {
    const adm = this.admission;
    if (!adm || adm.coordinator !== from.peerId || adm.aid !== aid) return;
    const pl = adm.candidateLink;
    if (adm.stage !== "connecting" || !pl || pl.mediaStatus !== "connected") {
      // We cannot confirm our own link to the newcomer: do not admit it locally.
      return this.abortLocal(adm, "failed");
    }
    this.finishAdmission(adm);
    this.commitLink(pl);
    this.chat.addSystem(`${label(pl)} görüşmeye katıldı.`);
    // Now a member for us too: process what it sent before our commit arrived (same checks as always).
    for (const early of adm.early.splice(0)) {
      if (this.members.get(pl.peerId) !== pl) break;
      this.handleMemberMessage(pl, early);
    }
    this.emit();
    this.flushDeferredProposal();
  }

  /** Re-evaluates a proposal that had to wait for our previous admission to finish. */
  private flushDeferredProposal(): void {
    const d = this.deferredProposal;
    this.deferredProposal = null;
    if (!d) return;
    const from = this.members.get(d.from);
    if (from) this.handleMemberMessage(from, d.msg);
  }

  acceptRequest(id: number): void {
    const adm = this.admission;
    if (this.disposed || !adm || adm.uiId !== id || adm.myVote !== "pending" || adm.stage !== "voting") return;
    adm.myVote = "accept";
    if (adm.coordinator === this.selfUid()) {
      adm.votes.add(adm.coordinator);
      this.checkVotes(adm);
    } else if (this.sid) {
      this.members
        .get(adm.coordinator)
        ?.data.send({ t: "admit-vote", v: 2, sid: this.sid, aid: adm.aid, vote: "accept" } satisfies ProtocolMessage);
    }
    this.emit();
  }

  rejectRequest(id: number): void {
    const adm = this.admission;
    if (!adm || adm.uiId !== id) return;
    if (adm.coordinator === this.selfUid()) return this.abortAdmission(adm, "declined");
    if (this.sid) {
      this.members
        .get(adm.coordinator)
        ?.data.send({ t: "admit-vote", v: 2, sid: this.sid, aid: adm.aid, vote: "declined" } satisfies ProtocolMessage);
    }
    this.abortLocal(adm, "declined", "Katılım isteğini reddettiniz.");
  }

  // ================================================================ candidate side

  requestJoin(rawTarget: string): void {
    if (this.disposed) return;
    const target = normalizeUid(rawTarget);
    if (!isValidUid(target)) return this.setNotice("error", "Geçersiz UID. Örnek biçim: psst-abcd-efgh-jkmn");
    if (target === this.selfUid()) return this.setNotice("error", "Kendinize bağlanamazsınız.");
    if (this.deps.signaling.state !== "online") return this.setNotice("error", "Sinyal sunucusuna bağlı değilsiniz.");
    if (this.joining) return this.setNotice("info", "Zaten bekleyen bir isteğiniz var.");
    if (this.members.size > 0) {
      return this.setNotice("info", "Zaten bir görüşmedesiniz. Başka bir görüşmeye katılmak için önce ayrılın.");
    }
    if (this.admission) return this.setNotice("info", "Önce bekleyen katılım isteğini yanıtlayın.");

    let link: DataLink;
    try {
      link = this.deps.signaling.connect(target);
    } catch {
      return this.setNotice("error", "Bağlantı başlatılamadı.");
    }
    this.register(link);
    const j: Joining = {
      target,
      stage: "contacting",
      aid: null,
      sid: null,
      coordinatorLink: link,
      expected: [],
      links: new Map(),
      pendingMesh: new Map(),
      early: [],
      timer: setTimeout(() => this.failJoining("Karşı tarafa ulaşılamadı (zaman aşımı).", true), TIMEOUTS.dataOpenMs),
    };
    this.joining = j;
    this.notice = null;
    this.emit();

    link.onOpen(() => {
      if (this.joining !== j) return;
      link.send({ t: "join-request", v: 2, name: this.deps.getDisplayName() } satisfies ProtocolMessage);
      clearTimeout(j.timer);
      j.timer = setTimeout(
        () => this.failJoining("Katılım isteği zamanında yanıtlanmadı.", true),
        TIMEOUTS.admissionVoteMs + TIMEOUTS.localSlackMs,
      );
    });
  }

  cancelRequest(): void {
    if (this.joining) this.failJoining("İstek iptal edildi.", true, "info");
  }

  private handleJoiningMessage(j: Joining, link: DataLink, msg: ProtocolMessage): void {
    if (link === j.coordinatorLink) {
      switch (msg.t) {
        case "join-pending":
          if (j.stage !== "contacting") return;
          j.aid = msg.aid;
          j.stage = "approval";
          return this.emit();
        case "join-reject":
          return this.failJoining(REJECT_TEXT[msg.reason], false);
        case "join-accept":
          return this.handleJoinAccept(j, link, msg);
        case "admit-commit":
          if (j.stage === "connecting" && msg.sid === j.sid && msg.aid === j.aid) this.commitJoin(j);
          return;
        case "admit-abort":
          if (msg.sid === j.sid && msg.aid === j.aid) this.failJoining(REJECT_TEXT[msg.reason], false);
          return;
        default:
          this.keepEarly(j, link.peerId, msg);
          return;
      }
    }
    // Mesh link to another member.
    if (msg.t === "mesh-ack" && msg.sid === j.sid && msg.aid === j.aid && j.pendingMesh.get(link.peerId) === link) {
      j.pendingMesh.delete(link.peerId);
      const info = j.expected.find((m) => m.uid === link.peerId);
      const pl = this.newPeerLink(link.peerId, info?.name ?? "", link);
      j.links.set(link.peerId, pl);
      this.placeCall(pl);
      this.emit();
    } else if (msg.t === "join-reject") {
      this.failJoining("Katılımcılardan biri bağlantıyı kabul etmedi.", true);
    } else if (j.links.get(link.peerId)?.data === link) {
      this.keepEarly(j, link.peerId, msg);
    }
  }

  /** A member that already committed us may talk before our commit arrives: keep it (bounded). */
  private keepEarly(j: Joining, from: string, msg: ProtocolMessage): void {
    if (j.stage === "connecting" && "sid" in msg && msg.sid === j.sid && j.early.length < EARLY_LIMIT) {
      j.early.push({ from, msg });
    }
  }

  private handleJoinAccept(j: Joining, link: DataLink, msg: Extract<ProtocolMessage, { t: "join-accept" }>): void {
    if (j.stage === "connecting" || (j.aid !== null && j.aid !== msg.aid)) return;
    const me = this.selfUid();
    if (msg.members.some((m) => m.uid === me || m.uid === j.target)) return this.failJoining(REJECT_TEXT.invalid, true);
    clearTimeout(j.timer);
    j.aid = msg.aid;
    j.sid = msg.sid;
    j.stage = "connecting";
    j.expected = msg.members;
    j.timer = setTimeout(() => this.failJoining(REJECT_TEXT.failed, true), TIMEOUTS.meshSetupMs + TIMEOUTS.localSlackMs);

    const coordinator = this.newPeerLink(j.target, msg.name, link);
    j.links.set(j.target, coordinator);
    this.placeCall(coordinator);
    for (const m of msg.members) this.connectMesh(j, m);
    this.emit();
  }

  private connectMesh(j: Joining, m: MemberInfo): void {
    let link: DataLink;
    try {
      link = this.deps.signaling.connect(m.uid);
    } catch {
      return this.failJoining(REJECT_TEXT.failed, true);
    }
    this.register(link);
    j.pendingMesh.set(m.uid, link);
    link.onOpen(() => {
      if (this.joining !== j || j.pendingMesh.get(m.uid) !== link || !j.sid || !j.aid) return;
      link.send({ t: "mesh-hello", v: 2, sid: j.sid, aid: j.aid } satisfies ProtocolMessage);
    });
  }

  private commitJoin(j: Joining): void {
    if (j.pendingMesh.size > 0 || j.expected.some((m) => !j.links.has(m.uid))) {
      return this.failJoining(REJECT_TEXT.failed, true);
    }
    clearTimeout(j.timer);
    this.joining = null;
    this.sid = j.sid;
    for (const pl of j.links.values()) this.commitLink(pl);
    this.chat.addSystem("Görüşmeye katıldınız.");
    this.notice = null;
    for (const { from, msg } of j.early.splice(0)) {
      const member = this.members.get(from);
      if (member) this.handleMemberMessage(member, msg);
    }
    this.emit();
  }

  private failJoining(text: string, notifyCoordinator: boolean, kind: Notice["kind"] = "error"): void {
    const j = this.joining;
    if (!j) return;
    clearTimeout(j.timer);
    this.joining = null;
    if (notifyCoordinator && j.coordinatorLink.isOpen) j.coordinatorLink.send({ t: "cancel", v: 2 } satisfies ProtocolMessage);
    for (const link of j.pendingMesh.values()) this.dropLink(link);
    for (const pl of j.links.values()) this.teardownLink(pl);
    if (!j.links.has(j.target)) this.dropLink(j.coordinatorLink);
    this.setNotice(kind, text);
  }

  // ================================================================ media

  private placeCall(pl: PeerLink): void {
    let silent: MediaStream;
    let link: MediaLink;
    try {
      silent = this.deps.media.createSilentStream();
      link = this.deps.signaling.call(pl.peerId, silent);
    } catch {
      return this.failJoining(REJECT_TEXT.failed, true);
    }
    pl.media = link;
    this.attachMedia(pl, link, silent);
  }

  private handleIncomingMedia(link: MediaLink): void {
    const adm = this.admission;
    const pl = adm?.candidateLink;
    // Only the candidate of an admission WE approved, only once, only while connecting.
    if (this.disposed || !adm || !pl || adm.stage !== "connecting" || adm.myVote !== "accept" || link.peerId !== adm.candidate || pl.media) {
      link.close();
      return;
    }
    // Only a verifiably audio-only offer is answered (fail-closed, D-010).
    if (link.offerVerdict !== "audio-only") {
      link.close();
      return this.abortAdmission(adm, "invalid");
    }
    let silent: MediaStream;
    try {
      silent = this.deps.media.createSilentStream();
      link.answer(silent);
    } catch {
      link.close();
      return this.abortAdmission(adm, "failed");
    }
    pl.media = link;
    this.attachMedia(pl, link, silent);
  }

  private attachMedia(p: PeerLink, link: MediaLink, silent: MediaStream): void {
    const pc = link.getPeerConnection();
    if (pc) {
      if (p.pc && p.pcListener) {
        p.pc.removeEventListener("iceconnectionstatechange", p.pcListener);
        p.pc.removeEventListener("connectionstatechange", p.pcListener);
      }
      p.pc = pc;
      const sender = pc.getSenders().find((s) => s.track?.kind === "audio") ?? null;
      if (sender) {
        p.sender = sender;
        if (p.committed) {
          this.deps.media.addSender(p.peerId, sender);
        } else {
          // Not a member yet: nothing is ever sent until commit (GR-005).
          void sender.replaceTrack(null).catch(() => undefined);
        }
      }
      const update = (): void => {
        if (p.pc !== pc || !this.isTracked(p)) return;
        p.iceState = pc.iceConnectionState;
        if (pc.connectionState === "failed" || pc.iceConnectionState === "failed") {
          return this.onMediaFailed(p, "Ses bağlantısı koptu veya kurulamadı (NAT/ağ kısıtı olabilir).");
        }
        if (p.mediaStatus === "failed") return;
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          if (p.mediaStatus !== "connected") {
            p.mediaStatus = "connected";
            if (p.mediaTimer) clearTimeout(p.mediaTimer);
            p.mediaTimer = null;
          }
          if (!p.committed && p.onReady) {
            const ready = p.onReady;
            p.onReady = null;
            ready();
          }
        } else if (pc.iceConnectionState === "disconnected" && p.mediaStatus === "connected") {
          p.mediaStatus = "interrupted"; // never show "connected" while it is not
        }
        this.emit();
      };
      p.pcListener = update;
      pc.addEventListener("iceconnectionstatechange", update);
      pc.addEventListener("connectionstatechange", update);
    }
    for (const t of silent.getTracks()) t.stop(); // synthetic silent track no longer needed

    link.onStream((stream) => {
      if (p.media !== link || !this.isTracked(p)) return;
      if (stream.getVideoTracks().length > 0) return this.onMediaFailed(p, "Video içeren bağlantı reddedildi.");
      p.remoteStream = stream;
      if (p.committed) this.deps.media.addRemoteStream(p.peerId, stream); // never before commit
    });
    const onGone = (): void => {
      if (p.media === link && this.isTracked(p)) this.onMediaFailed(p, "Ses bağlantısı kapandı.");
    };
    link.onClose(onGone);
    link.onError(onGone);
  }

  private onMediaFailed(p: PeerLink, text: string): void {
    if (!p.committed) {
      // A pending (not yet admitted) link failed: roll back the admission / join.
      const adm = this.admission;
      if (adm?.candidateLink === p) return this.abortAdmission(adm, "failed");
      if (this.joining?.links.get(p.peerId) === p) return this.failJoining(REJECT_TEXT.failed, true);
      return;
    }
    // Established member: media failure is NOT a departure; chat keeps working.
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
    this.chat.addSystem(`${label(p)}: ${text}`);
    this.emit();
  }

  /** Membership commit for one link: only now audio may flow (respecting mic/speaker state). */
  private commitLink(p: PeerLink): void {
    p.committed = true;
    p.onReady = null;
    this.members.set(p.peerId, p);
    this.watchDataLiveness(p);
    if (p.sender) this.deps.media.addSender(p.peerId, p.sender);
    if (p.remoteStream) this.deps.media.addRemoteStream(p.peerId, p.remoteStream);
    this.applyBandwidthMode();
    if (p.mediaStatus === "connecting") {
      p.mediaTimer = setTimeout(() => {
        p.mediaTimer = null;
        if (this.members.get(p.peerId) === p && p.mediaStatus === "connecting") {
          this.onMediaFailed(p, "Ses bağlantısı zamanında kurulamadı (NAT/ağ kısıtı olabilir).");
        }
      }, TIMEOUTS.mediaSetupMs);
    }
  }

  /**
   * Detects members that vanished without a goodbye (crashed tab, lost network): data link ICE
   * "failed"/"closed" ⇒ gone now; "disconnected" for TIMEOUTS.peerLostMs ⇒ gone. No extra traffic.
   */
  private watchDataLiveness(p: PeerLink): void {
    const pc = p.data.getPeerConnection();
    if (!pc) return;
    const check = (): void => {
      if (this.members.get(p.peerId) !== p || p.dataPc !== pc) return;
      const state = pc.iceConnectionState;
      if (state === "failed" || state === "closed") {
        this.removeMember(p.peerId, `${label(p)} ile bağlantı koptu.`);
      } else if (state === "disconnected") {
        if (!p.lostTimer) {
          p.lostTimer = setTimeout(() => {
            p.lostTimer = null;
            if (this.members.get(p.peerId) === p && pc.iceConnectionState === "disconnected") {
              this.removeMember(p.peerId, `${label(p)} ile bağlantı koptu.`);
            }
          }, TIMEOUTS.peerLostMs);
        }
      } else if (p.lostTimer) {
        clearTimeout(p.lostTimer);
        p.lostTimer = null;
      }
    };
    p.dataPc = pc;
    p.dataListener = check;
    pc.addEventListener("iceconnectionstatechange", check);
    check();
  }

  /** Releases everything that belongs to ONE peer. Shared capture / AudioContext are untouched. */
  private teardownLink(p: PeerLink): void {
    if (p.mediaTimer) clearTimeout(p.mediaTimer);
    p.mediaTimer = null;
    if (p.lostTimer) clearTimeout(p.lostTimer);
    p.lostTimer = null;
    if (p.dataPc && p.dataListener) p.dataPc.removeEventListener("iceconnectionstatechange", p.dataListener);
    p.dataPc = null;
    p.dataListener = null;
    p.onReady = null;
    if (p.pc && p.pcListener) {
      p.pc.removeEventListener("iceconnectionstatechange", p.pcListener);
      p.pc.removeEventListener("connectionstatechange", p.pcListener);
    }
    p.pcListener = null;
    if (p.sender) {
      if (p.committed) this.deps.media.removeSender(p.peerId, p.sender);
      else void p.sender.replaceTrack(null).catch(() => undefined);
    }
    p.sender = null;
    if (p.committed) this.deps.media.removeRemoteStream(p.peerId);
    p.remoteStream = null;
    const media = p.media;
    p.media = null;
    p.pc = null;
    media?.close();
    this.dropLink(p.data);
  }

  // ================================================================ membership changes

  private removeMember(peerId: string, info: string | null): void {
    const p = this.members.get(peerId);
    if (!p) return;
    this.members.delete(peerId);
    this.teardownLink(p);
    this.applyBandwidthMode();
    if (info) this.chat.addSystem(info);
    // Membership changed: any running admission no longer matches its approved snapshot.
    if (this.admission) this.abortAdmission(this.admission, "conflict");
    if (this.members.size === 0) this.endSession(info);
    else this.emit();
  }

  /**
   * Low-bandwidth mode (D-020): cap every member's outbound voice bitrate while the group is
   * larger than LOW_BANDWIDTH_THRESHOLD; restore the browser default otherwise.
   * Only encoder parameters change: no renegotiation, no effect on mic/privacy state.
   */
  private applyBandwidthMode(): void {
    const low = this.members.size + 1 > LOW_BANDWIDTH_THRESHOLD;
    this.lowBandwidth = low;
    const gen = ++this.bandwidthGeneration;
    const results = [...this.members.values()]
      .filter((p) => p.sender)
      .map((p) => setVoiceBitrate(p.sender as RTCRtpSender, low ? LOW_BANDWIDTH_BITRATE_BPS : null));
    void Promise.all(results).then((ok) => {
      if (gen !== this.bandwidthGeneration || this.disposed) return; // a newer change superseded this one
      const failed = low && ok.includes(false);
      if (failed !== this.bandwidthLimitFailed) {
        this.bandwidthLimitFailed = failed;
        this.emit();
      }
    });
  }

  private endSession(info: string | null): void {
    this.sid = null;
    this.deferredProposal = null;
    this.bandwidthLimitFailed = false;
    this.lowBandwidth = false;
    this.chat.clear(); // ephemeral: history is gone when the session ends
    if (info) this.notice = { kind: "info", text: info };
    this.deps.media.sessionEnded();
    this.emit();
  }

  // ================================================================ chat & leave

  sendChat(raw: string): boolean {
    if (this.members.size === 0 || !this.sid) return false;
    const text = sanitizeChatText(raw);
    if (text === null) return false;
    const msg = { t: "chat", v: 2, sid: this.sid, id: newMessageId(), text } satisfies ProtocolMessage;
    for (const p of this.members.values()) p.data.send(msg); // direct fan-out, no forwarding
    this.chat.add(true, this.deps.getDisplayName() || "Ben", text);
    this.emit();
    return true;
  }

  /** Leave the session. Only our own links are torn down; the UID stays available. */
  leave(): void {
    if (this.joining) return this.cancelRequest();
    const adm = this.admission;
    if (adm) {
      if (adm.coordinator === this.selfUid()) this.abortAdmission(adm, "failed");
      else this.abortLocal(adm, "conflict");
    }
    if (this.members.size === 0) return;
    if (this.sid) {
      const bye = { t: "leave", v: 2, sid: this.sid } satisfies ProtocolMessage;
      for (const p of this.members.values()) p.data.send(bye);
    }
    for (const p of [...this.members.values()]) {
      this.members.delete(p.peerId);
      this.teardownLink(p);
    }
    this.endSession("Görüşmeden ayrıldınız.");
  }

  /** Full teardown (page termination). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.leave();
    for (const link of [...this.unauthenticated.keys()]) this.dropLink(link);
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
