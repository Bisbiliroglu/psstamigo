/**
 * Peer link lifecycle (PA-006C, behavior-preserving extraction from SessionController).
 *
 * One PeerLink = one application DataConnection (+ at most one MediaConnection) with one peer.
 * This module owns: media attachment, media status tracking, commit-time audio gating, data-link
 * liveness (D-024), teardown, and the low-bandwidth encoder cap (D-020/D-025).
 * Membership and admission decisions stay in SessionController (the host).
 */
import { LIMITS, LOW_BANDWIDTH_BITRATE_BPS, LOW_BANDWIDTH_THRESHOLD, MEDIA_RECOVERY, TIMEOUTS } from "../core/config";
import type { DataLink, MediaLink } from "../signaling/types";
import { BoundedSet } from "./admission";

export type MediaStatus = "connecting" | "connected" | "interrupted" | "recovering" | "failed";

/** Media-only recovery bookkeeping (REC-007). Generations make every callback stale-safe. */
export interface MediaRecoveryState {
  /** True from the first media failure until success or exhaustion. */
  active: boolean;
  /** Attempts made (initiator) in the current recovery. */
  attempt: number;
  /** Generation of our latest request (initiator). */
  gen: number;
  /** Highest generation accepted from the peer (responder; older requests are ignored). */
  seenGen: number;
  /** Responder: generation whose replacement call we will accept. */
  expecting: number | null;
  timer: Timer | null;
}
export type Timer = ReturnType<typeof setTimeout>;

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

export interface PeerLink {
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
  /** Media stuck in ICE "disconnected" while the data link is healthy. */
  stallTimer: Timer | null;
  recovery: MediaRecoveryState;
  /** Data link transport state for the UI ("ok" or "interrupted"). */
  linkState: "ok" | "interrupted";
}

export function newPeerLink(peerId: string, name: string, data: DataLink): PeerLink {
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
    stallTimer: null,
    recovery: { active: false, attempt: 0, gen: 0, seenGen: 0, expecting: null, timer: null },
    linkState: "ok",
  };
}

/** True if the application data link of `p` currently has a working transport. */
export function dataHealthy(p: PeerLink): boolean {
  const pc = p.data.getPeerConnection();
  if (!pc) return p.data.isOpen;
  return p.data.isOpen && (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed");
}

export function label(p: { name: string; peerId: string }): string {
  return p.name || p.peerId;
}

/** What the lifecycle needs from the session (dependency inversion). */
export interface PeerLinkHost {
  readonly media: SessionMediaHooks;
  /** Link is a member, the current admission's candidate link, or a joining link. */
  isTracked(p: PeerLink): boolean;
  /** Link is the committed member entry for its peer. */
  isMember(p: PeerLink): boolean;
  /** Voice path of an uncommitted link failed: roll back the admission / join. */
  pendingMediaFailed(p: PeerLink): void;
  /** Committed member vanished (data link failed / disconnected too long). */
  memberLost(p: PeerLink): void;
  /** A committed member's media failed (chat keeps working). */
  memberMediaFailed(p: PeerLink, text: string): void;
  /** A committed member's replacement media connected (REC-007). */
  memberMediaRecovered(p: PeerLink): void;
  dropLink(link: DataLink): void;
  changed(): void;
}

export class PeerLinks {
  constructor(private readonly host: PeerLinkHost) {}

  attachMedia(p: PeerLink, link: MediaLink, silent: MediaStream): void {
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
          this.host.media.addSender(p.peerId, sender);
        } else {
          // Not a member yet: nothing is ever sent until commit (GR-005).
          void sender.replaceTrack(null).catch(() => undefined);
        }
      }
      const update = (): void => {
        if (p.pc !== pc || !this.host.isTracked(p)) return;
        p.iceState = pc.iceConnectionState;
        // "closed" here means the transport was closed under us (our own drops remove this listener first).
        if (pc.connectionState === "failed" || pc.iceConnectionState === "failed" || pc.connectionState === "closed") {
          return this.failMedia(p, "Ses bağlantısı koptu veya kurulamadı (NAT/ağ kısıtı olabilir).");
        }
        if (p.mediaStatus === "failed") return;
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          this.clearStall(p);
          if (p.mediaStatus !== "connected") {
            const wasRecovering = p.committed && p.recovery.active;
            p.mediaStatus = "connected";
            if (p.mediaTimer) clearTimeout(p.mediaTimer);
            p.mediaTimer = null;
            if (wasRecovering) this.host.memberMediaRecovered(p);
          }
          if (!p.committed && p.onReady) {
            const ready = p.onReady;
            p.onReady = null;
            ready();
          }
        } else if (pc.iceConnectionState === "disconnected" && p.mediaStatus === "connected") {
          p.mediaStatus = "interrupted"; // never show "connected" while it is not
          // Scenario B: give the same connection time to recover by itself; if the data link is fine
          // but media stays stuck, treat it as failed so a replacement can be negotiated (REC-005/007).
          if (p.committed && !p.stallTimer) {
            p.stallTimer = setTimeout(() => {
              p.stallTimer = null;
              if (p.pc === pc && this.host.isMember(p) && pc.iceConnectionState === "disconnected" && dataHealthy(p)) {
                this.failMedia(p, "Ses bağlantısı takıldı.");
              }
            }, MEDIA_RECOVERY.stallMs);
          }
        }
        this.host.changed();
      };
      p.pcListener = update;
      pc.addEventListener("iceconnectionstatechange", update);
      pc.addEventListener("connectionstatechange", update);
    }
    for (const t of silent.getTracks()) t.stop(); // synthetic silent track no longer needed

    link.onStream((stream) => {
      if (p.media !== link || !this.host.isTracked(p)) return;
      if (stream.getVideoTracks().length > 0) return this.failMedia(p, "Video içeren bağlantı reddedildi.");
      p.remoteStream = stream;
      if (p.committed) this.host.media.addRemoteStream(p.peerId, stream); // never before commit
    });
    const onGone = (): void => {
      if (p.media === link && this.host.isTracked(p)) this.failMedia(p, "Ses bağlantısı kapandı.");
    };
    link.onClose(onGone);
    link.onError(onGone);
  }

  failMedia(p: PeerLink, text: string): void {
    if (!p.committed) {
      // A pending (not yet admitted) link failed: roll back the admission / join.
      return this.host.pendingMediaFailed(p);
    }
    // Established member: media failure is NOT a departure; chat keeps working.
    if (p.mediaStatus === "failed" && !p.media) return;
    this.dropMedia(p);
    p.mediaStatus = "failed";
    this.host.memberMediaFailed(p, text);
  }

  /**
   * Releases only the media path of a committed member: sender detached from the mic, playback
   * stopped, connection closed. Data link, membership and the shared capture are untouched.
   */
  dropMedia(p: PeerLink): void {
    if (p.mediaTimer) clearTimeout(p.mediaTimer);
    p.mediaTimer = null;
    this.clearStall(p);
    if (p.pc && p.pcListener) {
      p.pc.removeEventListener("iceconnectionstatechange", p.pcListener);
      p.pc.removeEventListener("connectionstatechange", p.pcListener);
    }
    p.pcListener = null;
    p.pc = null;
    if (p.sender && p.committed) this.host.media.removeSender(p.peerId, p.sender);
    p.sender = null;
    if (p.committed) this.host.media.removeRemoteStream(p.peerId);
    p.remoteStream = null;
    const media = p.media;
    p.media = null;
    media?.close();
  }

  private clearStall(p: PeerLink): void {
    if (p.stallTimer) clearTimeout(p.stallTimer);
    p.stallTimer = null;
  }

  /** Membership commit for one link (host already registered it as member): audio may flow now. */
  commit(p: PeerLink): void {
    p.committed = true;
    p.onReady = null;
    this.watchDataLiveness(p);
    if (p.sender) this.host.media.addSender(p.peerId, p.sender);
    if (p.remoteStream) this.host.media.addRemoteStream(p.peerId, p.remoteStream);
    if (p.mediaStatus === "connecting") {
      p.mediaTimer = setTimeout(() => {
        p.mediaTimer = null;
        if (this.host.isMember(p) && p.mediaStatus === "connecting") {
          this.failMedia(p, "Ses bağlantısı zamanında kurulamadı (NAT/ağ kısıtı olabilir).");
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
      if (!this.host.isMember(p) || p.dataPc !== pc) return;
      const state = pc.iceConnectionState;
      const linkState = state === "connected" || state === "completed" ? "ok" : "interrupted";
      if (linkState !== p.linkState) {
        p.linkState = linkState;
        this.host.changed();
      }
      if (state === "failed" || state === "closed") {
        this.host.memberLost(p);
      } else if (state === "disconnected") {
        if (!p.lostTimer) {
          p.lostTimer = setTimeout(() => {
            p.lostTimer = null;
            if (this.host.isMember(p) && pc.iceConnectionState === "disconnected") this.host.memberLost(p);
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
  teardown(p: PeerLink): void {
    if (p.mediaTimer) clearTimeout(p.mediaTimer);
    p.mediaTimer = null;
    this.clearStall(p);
    if (p.recovery.timer) clearTimeout(p.recovery.timer);
    p.recovery = { active: false, attempt: 0, gen: p.recovery.gen, seenGen: p.recovery.seenGen, expecting: null, timer: null };
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
      if (p.committed) this.host.media.removeSender(p.peerId, p.sender);
      else void p.sender.replaceTrack(null).catch(() => undefined);
    }
    p.sender = null;
    if (p.committed) this.host.media.removeRemoteStream(p.peerId);
    p.remoteStream = null;
    const media = p.media;
    p.media = null;
    p.pc = null;
    media?.close();
    this.host.dropLink(p.data);
  }
}

/**
 * Low-bandwidth mode (D-020, D-025): cap every member's outbound voice bitrate while the group is
 * larger than LOW_BANDWIDTH_THRESHOLD; restore the browser default otherwise. Reports failures.
 */
export class BandwidthMode {
  low = false;
  failed = false;
  private generation = 0;

  /** Applies the profile for `groupSize` (incl. self) to `senders`; `onFailedChange` fires if the failure state flips. */
  apply(groupSize: number, senders: RTCRtpSender[], onFailedChange: () => void): void {
    const low = groupSize > LOW_BANDWIDTH_THRESHOLD;
    this.low = low;
    const gen = ++this.generation;
    const results = senders.map((s) => setVoiceBitrate(s, low ? LOW_BANDWIDTH_BITRATE_BPS : null));
    void Promise.all(results).then((ok) => {
      if (gen !== this.generation) return; // a newer change superseded this one
      const failed = low && ok.includes(false);
      if (failed !== this.failed) {
        this.failed = failed;
        onFailedChange();
      }
    });
  }

  reset(): void {
    this.generation++;
    this.low = false;
    this.failed = false;
  }
}

/** Returns true if the sender now has the requested cap (or nothing had to change). */
export async function setVoiceBitrate(sender: RTCRtpSender, bps: number | null): Promise<boolean> {
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
