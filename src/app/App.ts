/**
 * Application lifecycle (PRIV-004, PRIV-005).
 *
 * - Wires signaling, session, audio and view together.
 * - Page termination (pagehide) => full idempotent shutdown, Peer destroyed.
 * - Background (visibilitychange / blur) => nothing happens; the call continues.
 * - Restored from BFCache (pageshow.persisted) => reload; no old state resumes.
 */
import { AudioGraph } from "../audio/AudioGraph";
import { ActivityDetector, AnalyserMeter, MeterLoop } from "../audio/levels";
import { MicrophoneController } from "../audio/MicrophoneController";
import { SpeakerController, type Player } from "../audio/SpeakerController";
import { APP_VERSION } from "../core/config";
import { buildInviteUrl, parseInviteHash } from "../core/invite";
import { sanitizeDisplayName } from "../session/protocol";
import { SessionController } from "../session/SessionController";
import { PeerJsSignaling } from "../signaling/PeerJsSignaling";
import { View } from "../ui/View";
import { collectDiagnostics } from "./diagnostics";

function createAudioElementPlayer(stream: MediaStream): Player {
  let audio: HTMLAudioElement | null = new Audio();
  audio.autoplay = false;
  audio.srcObject = stream;
  return {
    play: () => audio?.play() ?? Promise.resolve(),
    stop: () => {
      if (!audio) return;
      audio.pause();
      audio.srcObject = null;
      audio = null;
    },
  };
}

export class App {
  private readonly audioGraph = new AudioGraph();
  private readonly meterLoop = new MeterLoop();
  private readonly signaling = new PeerJsSignaling();
  private readonly mic: MicrophoneController;
  private readonly speaker: SpeakerController;
  private readonly session: SessionController;
  private readonly view: View;
  private displayName = "";
  private shutDown = false;
  private stopMicMeter: (() => void) | null = null;
  private stopSpeakerMeter: (() => void) | null = null;
  private readonly detectors = new Map<string, ActivityDetector>();
  private diagTimer: ReturnType<typeof setInterval> | null = null;
  /** UID from an invite link, waiting for the user's explicit click (never auto-connects). */
  private pendingInvite: string | null = null;

  constructor() {
    this.mic = new MicrophoneController({
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createMeter: (track) => new AnalyserMeter(this.audioGraph.get(), new MediaStream([track])),
    });
    this.speaker = new SpeakerController({
      createPlayer: createAudioElementPlayer,
      createMeter: (stream) => new AnalyserMeter(this.audioGraph.get(), stream),
    });
    this.session = new SessionController({
      signaling: this.signaling,
      getDisplayName: () => this.displayName,
      media: {
        createSilentStream: () => this.audioGraph.createSilentStream(),
        addSender: (_peer, sender) => this.mic.addSender(sender),
        removeSender: (_peer, sender) => this.mic.removeSender(sender),
        addRemoteStream: (peer, stream) => this.speaker.addRemote(peer, stream),
        removeRemoteStream: (peer) => {
          this.speaker.removeRemote(peer);
          this.detectors.delete(peer);
        },
        sessionEnded: () => this.resetAudioToSafeDefaults(),
      },
    });

    this.view = new View(APP_VERSION, {
      copyUid: () => void this.copyUid(),
      copyInvite: () => void this.copyInvite(),
      acceptInvite: () => {
        const uid = this.pendingInvite;
        if (!uid) return;
        this.setInvite(null);
        this.session.requestJoin(uid);
      },
      dismissInvite: () => this.setInvite(null),
      setDisplayName: (name) => {
        this.displayName = sanitizeDisplayName(name) ?? this.displayName;
      },
      connect: (target) => this.session.requestJoin(target),
      cancelRequest: () => this.session.cancelRequest(),
      accept: (id) => {
        // Accept is a user gesture: safe point to create/resume the AudioContext.
        this.audioGraph.get();
        this.session.acceptRequest(id);
      },
      reject: (id) => this.session.rejectRequest(id),
      toggleMic: () => {
        const state = this.mic.snapshot().state;
        if (state === "on" || state === "starting") this.mic.disable();
        else void this.mic.enable();
      },
      toggleSpeaker: () => {
        if (this.speaker.isEnabled()) this.speaker.disable();
        else {
          this.audioGraph.get();
          this.speaker.enable();
        }
      },
      leave: () => this.session.leave(),
      sendChat: (text) => this.session.sendChat(text),
      diagnosticsToggled: (open) => this.setDiagnostics(open),
    });

    this.signaling.on("state", () => this.view.renderSignaling(this.signaling.state, this.signaling.uid));
    this.signaling.on("open", () => this.view.renderSignaling(this.signaling.state, this.signaling.uid));
    this.signaling.on("error", (e) => {
      if (e.fatal) this.view.renderSignaling("failed", null);
    });
    this.session.onChange((s) => {
      // The requester's AudioContext is created when the call is placed (after accept).
      this.view.renderSession(s);
    });
    this.mic.onChange((m) => {
      this.view.renderMic(m);
      this.updateMicMeter(m.state === "on");
    });
    this.speaker.onChange((s) => {
      this.view.renderSpeaker(s);
      this.updateSpeakerMeter(s.enabled);
    });
  }

  start(): void {
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("hashchange", this.readInvite);
    window.addEventListener("pageshow", this.onPageShow);
    this.view.renderSignaling("connecting", null);
    this.view.renderSession(this.session.snapshot());
    this.view.renderMic(this.mic.snapshot());
    this.view.renderSpeaker(this.speaker.snapshot());
    this.readInvite();
    this.signaling.start();
  }

  /** Reads "#join=<uid>" once and removes it from the address bar (no re-trigger on reload). */
  private readonly readInvite = (): void => {
    const uid = parseInviteHash(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (uid) this.setInvite(uid);
  };

  private setInvite(uid: string | null): void {
    this.pendingInvite = uid;
    this.view.renderInvite(uid);
  }

  private async copyInvite(): Promise<void> {
    const uid = this.signaling.uid;
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(buildInviteUrl(uid, location));
      this.view.flashInviteCopied(true);
    } catch {
      this.view.flashInviteCopied(false);
    }
  }

  private readonly onPageHide = (): void => {
    // Fires on close, reload, navigation and BFCache entry. Not on tab switch / minimize.
    this.shutdown();
  };

  private readonly onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) {
      // Restored from BFCache: never resume an old call or audio state.
      location.reload();
    }
  };

  private resetAudioToSafeDefaults(): void {
    this.mic.disable();
    this.speaker.disable();
    this.speaker.clear();
    this.detectors.clear();
    this.setDiagnostics(false);
    void this.audioGraph.close();
  }

  private updateMicMeter(on: boolean): void {
    if (on && !this.stopMicMeter) {
      this.stopMicMeter = this.meterLoop.add(() => this.view.setMicLevel(this.mic.readLevel()));
    } else if (!on && this.stopMicMeter) {
      this.stopMicMeter();
      this.stopMicMeter = null;
      this.view.setMicLevel(0);
    }
  }

  private updateSpeakerMeter(on: boolean): void {
    if (on && !this.stopSpeakerMeter) {
      this.stopSpeakerMeter = this.meterLoop.add((now) => {
        let max = 0;
        for (const p of this.session.snapshot().participants) {
          const level = this.speaker.readLevel(p.peerId);
          let det = this.detectors.get(p.peerId);
          if (!det) {
            det = new ActivityDetector();
            this.detectors.set(p.peerId, det);
          }
          const out = det.update(level, now);
          this.view.setParticipantLevel(p.peerId, out.level, out.speaking);
          max = Math.max(max, level);
        }
        this.view.setSpeakerLevel(max);
      });
    } else if (!on && this.stopSpeakerMeter) {
      this.stopSpeakerMeter();
      this.stopSpeakerMeter = null;
      for (const d of this.detectors.values()) d.reset();
      this.view.setSpeakerLevel(0);
    }
  }

  private setDiagnostics(open: boolean): void {
    if (this.diagTimer !== null) clearInterval(this.diagTimer);
    this.diagTimer = null;
    if (!open || this.shutDown) return;
    const refresh = async (): Promise<void> => {
      const rows = await collectDiagnostics(this.signaling.state, this.session.snapshot(), (peer) =>
        this.session.getPeerConnection(peer),
      );
      if (this.diagTimer !== null) this.view.renderDiagnostics(rows);
    };
    // Polling only while the panel is open (minimal background cost).
    this.diagTimer = setInterval(() => void refresh(), 2_000);
    void refresh();
  }

  private async copyUid(): Promise<void> {
    const uid = this.signaling.uid;
    if (!uid) return;
    try {
      await navigator.clipboard.writeText(uid);
      this.view.flashCopied(true);
    } catch {
      this.view.flashCopied(false);
    }
  }

  /** Full, idempotent shutdown. */
  shutdown(): void {
    if (this.shutDown) return;
    this.shutDown = true;
    window.removeEventListener("hashchange", this.readInvite);
    this.setDiagnostics(false);
    this.session.dispose();
    this.mic.dispose();
    this.speaker.dispose();
    this.meterLoop.clear();
    this.stopMicMeter = null;
    this.stopSpeakerMeter = null;
    void this.audioGraph.close();
    this.signaling.destroy();
    this.view.dispose();
  }
}
