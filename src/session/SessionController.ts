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
import { LIMITS, MAX_PARTICIPANTS, MEDIA_RECOVERY, TIMEOUTS } from "../core/config";
import { Emitter } from "../core/emitter";
import { RateLimiter } from "../core/rateLimiter";
import { isValidUid, normalizeUid } from "../core/uid";
import { ChatLog, type ChatEntry } from "../messaging/ChatLog";
import type { DataLink, MediaLink, Signaling } from "../signaling/types";
import { BoundedSet, memberSnapshot, newMessageId, newSessionId, sameMembers } from "./admission";
import {
  BandwidthMode,
  dataHealthy,
  label,
  newPeerLink,
  PeerLinks,
  type MediaStatus,
  type PeerLink,
  type SessionMediaHooks,
  type Timer,
} from "./peerLink";

export type { MediaStatus, SessionMediaHooks } from "./peerLink";
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
export interface ParticipantView {
  readonly peerId: string;
  readonly name: string;
  readonly media: MediaStatus;
  readonly iceState: string;
  /** Application data link (chat + authorization) transport state. */
  readonly link: "ok" | "interrupted";
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
  /** After an involuntary session end: a member UID to send a NEW join request to (explicit click only, REC-014). */
  readonly rejoinTarget: string | null;
}

export interface SessionDeps {
  signaling: Signaling;
  media: SessionMediaHooks;
  getDisplayName(): string;
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
  private readonly bandwidth = new BandwidthMode();
  /** Local commit order (lower = earlier) used only to decide which side of an inconsistent pair leaves (D-030). */
  private readonly joinOrder = new Map<string, number>();
  private selfSeq = 0;
  private seqCounter = 0;
  private rejoinTarget: string | null = null;
  /** Latest member-sync per reporter, with our commit counter at arrival (D-030). */
  private readonly latestSync = new Map<string, { members: Set<string>; pending: string | null; seqAt: number }>();
  private syncTimer: Timer | null = null;
  private readonly links: PeerLinks;
  /**
   * A proposal received while our own admission was still connecting; it can only be judged
   * after that admission commits or aborts (cross-channel ordering, PA-006B).
   */
  private deferredProposal: { from: string; msg: Extract<ProtocolMessage, { t: "admit-propose" }> } | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.links = new PeerLinks({
      media: deps.media,
      isTracked: (p) => this.isTracked(p),
      isMember: (p) => this.members.get(p.peerId) === p,
      pendingMediaFailed: (p) => {
        const adm = this.admission;
        if (adm?.candidateLink === p) return this.abortAdmission(adm, "failed");
        if (this.joining?.links.get(p.peerId) === p) this.failJoining(REJECT_TEXT.failed, true);
      },
      memberLost: (p) => this.removeMember(p.peerId, `${label(p)} ile bağlantı koptu.`),
      memberMediaFailed: (p, text) => this.onMemberMediaFailed(p, text),
      memberMediaRecovered: (p) => this.onMemberMediaRecovered(p),
      dropLink: (link) => this.dropLink(link),
      changed: () => this.emit(),
    });
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
        link: p.linkState,
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
      lowBandwidth: this.bandwidth.low,
      bandwidthLimitFailed: this.bandwidth.failed,
      rejoinTarget: this.rejoinTarget,
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
    const pl = newPeerLink(adm.candidate, adm.candidateName, link);
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
    // A rollback while connecting may mean others did commit the candidate: tell them our view (D-030).
    if (adm.stage === "connecting" && this.members.size > 0) this.broadcastMemberSync();
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
      case "media-recover":
        return this.handleMediaRecoverRequest(member, msg.gen);
      case "media-recover-ok":
        return this.handleMediaRecoverOk(member, msg.gen);
      case "member-sync":
        return this.handleMemberSync(member, msg.members, msg.pending);
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
    const pl = newPeerLink(adm.candidate, adm.candidateName, link);
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
    this.rejoinTarget = null;
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
      const pl = newPeerLink(link.peerId, info?.name ?? "", link);
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

    const coordinator = newPeerLink(j.target, msg.name, link);
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
    for (const pl of j.links.values()) this.commitLink(pl); // all existing members are older than us
    this.selfSeq = ++this.seqCounter;
    this.rejoinTarget = null;
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
    const member = this.members.get(link.peerId);
    if (!this.disposed && member && member.recovery.expecting !== null) return this.answerRecoveryCall(member, link);
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
    this.links.attachMedia(p, link, silent);
  }

  /** Membership commit for one link: only now audio may flow (respecting mic/speaker state). */
  private commitLink(p: PeerLink): void {
    if (this.members.size === 0 && !this.joining) this.selfSeq = ++this.seqCounter; // we started this session
    this.joinOrder.set(p.peerId, ++this.seqCounter);
    this.members.set(p.peerId, p);
    this.links.commit(p);
    this.applyBandwidthMode();
  }

  private teardownLink(p: PeerLink): void {
    this.links.teardown(p);
  }

  // ================================================================ membership changes

  private removeMember(peerId: string, info: string | null): void {
    const p = this.members.get(peerId);
    if (!p) return;
    this.members.delete(peerId);
    this.joinOrder.delete(peerId);
    this.teardownLink(p);
    this.applyBandwidthMode();
    if (info) this.chat.addSystem(info);
    // Membership changed: any running admission no longer matches its approved snapshot.
    if (this.admission) this.abortAdmission(this.admission, "conflict");
    if (this.members.size === 0) {
      this.rejoinTarget = peerId; // involuntary end: offer an explicit new join request (REC-014)
      this.endSession(info);
    } else {
      this.broadcastMemberSync();
      this.emit();
    }
  }

  private applyBandwidthMode(): void {
    const senders = [...this.members.values()].flatMap((p) => (p.sender ? [p.sender] : []));
    this.bandwidth.apply(this.members.size + 1, senders, () => {
      if (!this.disposed) this.emit();
    });
  }

  private endSession(info: string | null): void {
    this.sid = null;
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.latestSync.clear();
    this.joinOrder.clear();
    this.selfSeq = 0;
    this.deferredProposal = null;
    this.bandwidth.reset();
    this.chat.clear(); // ephemeral: history is gone when the session ends
    if (info) this.notice = { kind: "info", text: info };
    this.deps.media.sessionEnded();
    this.emit();
  }

  // ================================================================ media recovery (REC-007, D-029)

  /** Deterministic initiator per pair (lower UID) so that only one replacement call is made. */
  private isRecoveryInitiator(p: PeerLink): boolean {
    return this.selfUid() < p.peerId;
  }

  private onMemberMediaFailed(p: PeerLink, text: string): void {
    if (this.members.get(p.peerId) !== p) return;
    if (!p.recovery.active) {
      p.recovery.active = true;
      p.recovery.attempt = 0;
      this.chat.addSystem(`${label(p)}: ${text} Yeniden kuruluyor…`);
    }
    p.mediaStatus = "recovering";
    // Responder: a closed attempt must not extend its watchdog; only new requests do.
    if (this.isRecoveryInitiator(p) || !p.recovery.timer) this.scheduleMediaRecovery(p);
    this.emit();
  }

  private scheduleMediaRecovery(p: PeerLink): void {
    if (p.recovery.timer) clearTimeout(p.recovery.timer);
    p.recovery.timer = null;
    const delays = MEDIA_RECOVERY.delaysMs;
    if (this.isRecoveryInitiator(p)) {
      if (p.recovery.attempt >= delays.length) return this.giveUpMedia(p);
      p.recovery.timer = setTimeout(() => this.attemptMediaRecovery(p), delays[p.recovery.attempt] ?? 0);
    } else {
      // Responder: wait for the next request; give up if none arrives within one full attempt window.
      const budget = Math.max(...delays) + MEDIA_RECOVERY.attemptTimeoutMs + 5_000;
      p.recovery.timer = setTimeout(() => {
        p.recovery.timer = null;
        if (this.members.get(p.peerId) === p && p.recovery.active) this.giveUpMedia(p);
      }, budget);
    }
  }

  private attemptMediaRecovery(p: PeerLink): void {
    p.recovery.timer = null;
    if (this.members.get(p.peerId) !== p || !this.sid || !p.recovery.active) return;
    p.recovery.attempt += 1;
    // Authorization is re-checked through the member's own data link; signaling carries the new offer.
    if (!dataHealthy(p) || this.deps.signaling.state !== "online") return this.scheduleMediaRecovery(p);
    const gen = ++p.recovery.gen;
    p.data.send({ t: "media-recover", v: 2, sid: this.sid, gen } satisfies ProtocolMessage);
    p.recovery.timer = setTimeout(() => {
      p.recovery.timer = null;
      if (this.members.get(p.peerId) !== p || p.recovery.gen !== gen || !p.recovery.active) return;
      this.links.dropMedia(p); // this attempt did not connect in time
      p.mediaStatus = "recovering";
      this.scheduleMediaRecovery(p);
      this.emit();
    }, MEDIA_RECOVERY.attemptTimeoutMs);
  }

  private handleMediaRecoverRequest(p: PeerLink, gen: number): void {
    if (this.isRecoveryInitiator(p) || gen <= p.recovery.seenGen || !this.sid) return; // wrong role or stale/replayed
    p.recovery.seenGen = gen;
    if (p.media) this.links.dropMedia(p); // our side may still believe the old path works
    if (!p.recovery.active) {
      p.recovery.active = true;
      this.chat.addSystem(`${label(p)} ile ses yeniden kuruluyor…`);
    }
    p.mediaStatus = "recovering";
    p.recovery.expecting = gen;
    this.scheduleMediaRecovery(p); // re-arm the responder watchdog
    p.data.send({ t: "media-recover-ok", v: 2, sid: this.sid, gen } satisfies ProtocolMessage);
    this.emit();
  }

  private handleMediaRecoverOk(p: PeerLink, gen: number): void {
    if (!this.isRecoveryInitiator(p) || gen !== p.recovery.gen || !p.recovery.active || p.media) return;
    let silent: MediaStream;
    let link: MediaLink;
    try {
      silent = this.deps.media.createSilentStream();
      link = this.deps.signaling.call(p.peerId, silent);
    } catch {
      return; // the attempt timer schedules the next try
    }
    p.media = link;
    // Committed member: sender gets the CURRENT mic state (null if muted), playback follows the speaker (D-029).
    this.attachMedia(p, link, silent);
    this.emit();
  }

  private answerRecoveryCall(p: PeerLink, link: MediaLink): void {
    // Only the member we agreed with, only once per request, only audio (fail-closed, D-010).
    if (p.media || link.offerVerdict !== "audio-only") {
      link.close();
      return;
    }
    p.recovery.expecting = null;
    let silent: MediaStream;
    try {
      silent = this.deps.media.createSilentStream();
      link.answer(silent);
    } catch {
      link.close();
      return;
    }
    p.media = link;
    this.attachMedia(p, link, silent);
    this.emit();
  }

  private onMemberMediaRecovered(p: PeerLink): void {
    if (p.recovery.timer) clearTimeout(p.recovery.timer);
    p.recovery = { ...p.recovery, active: false, attempt: 0, expecting: null, timer: null };
    this.applyBandwidthMode(); // the new sender gets the current bitrate profile (D-020)
    this.chat.addSystem(`${label(p)} ile ses yeniden bağlandı.`);
  }

  private giveUpMedia(p: PeerLink): void {
    if (p.recovery.timer) clearTimeout(p.recovery.timer);
    p.recovery = { ...p.recovery, active: false, expecting: null, timer: null };
    this.links.dropMedia(p);
    p.mediaStatus = "failed";
    this.chat.addSystem(`${label(p)} ile ses kurulamadı; mesajlaşma kullanılabilir.`);
    this.emit();
  }

  // ================================================================ membership convergence (REC-010/011, D-030)

  /** Tells every member our own committed set after a change. Used by others only to REMOVE peers. */
  private broadcastMemberSync(): void {
    if (!this.sid || this.members.size === 0) return;
    const adm = this.admission;
    const msg = {
      t: "member-sync",
      v: 2,
      sid: this.sid,
      members: memberSnapshot([this.selfUid(), ...this.members.keys()]),
      pending: adm && adm.stage === "connecting" ? adm.candidate : null,
    } satisfies ProtocolMessage;
    for (const m of this.members.values()) m.data.send(msg);
  }

  /**
   * Shrink-only reconciliation (D-030): if a member does not list someone we have (and is not still
   * connecting them), that pair is not fully meshed, so the more recently joined of the two is
   * removed. Nobody is ever ADDED from another peer's list (no approval is assumed). Reports are
   * judged only after a grace period, against members that were already committed when they arrived.
   */
  private handleMemberSync(from: PeerLink, members: string[], pending: string | null): void {
    if (!members.includes(from.peerId)) return;
    this.latestSync.set(from.peerId, { members: new Set(members), pending, seqAt: this.seqCounter });
    if (this.syncTimer === null) {
      this.syncTimer = setTimeout(() => {
        this.syncTimer = null;
        this.evaluateMemberSync();
      }, TIMEOUTS.memberSyncGraceMs);
    }
  }

  private evaluateMemberSync(): void {
    if (this.members.size === 0) return this.latestSync.clear();
    const me = this.selfUid();
    const order = (uid: string): number => (uid === me ? this.selfSeq : (this.joinOrder.get(uid) ?? Number.MAX_SAFE_INTEGER));
    const evict = new Set<string>();
    for (const [reporter, report] of this.latestSync) {
      if (!this.members.has(reporter)) continue; // reporter already gone
      for (const uid of [me, ...this.members.keys()]) {
        if (uid === reporter || report.members.has(uid) || uid === report.pending) continue;
        if (uid !== me && order(uid) > report.seqAt) continue; // committed after that report: not covered by it
        evict.add(order(uid) > order(reporter) ? uid : reporter);
      }
    }
    this.latestSync.clear();
    if (evict.size === 0) return;
    if (evict.has(me)) {
      const target = [...this.members.keys()][0] ?? null;
      this.leave();
      this.rejoinTarget = target;
      this.notice = {
        kind: "error",
        text: "Görüşmedeki herkesle bağlantın tamamlanamadığı için görüşmeden çıkarıldın. Yeniden katılım isteği gönderebilirsin.",
      };
      this.emit();
      return;
    }
    for (const uid of evict) {
      const m = this.members.get(uid);
      if (!m) continue;
      this.removeMember(uid, `${label(m)} herkesle bağlantı kuramadığı için görüşmeden çıkarıldı; yeniden katılım isteği gönderebilir.`);
    }
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
    this.rejoinTarget = null;
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
