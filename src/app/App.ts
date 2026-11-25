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
import { AudioDevices, type DeviceSnapshot } from "../audio/AudioDevices";
import { AudioDiagnostics, type TonePlayer } from "../audio/AudioDiagnostics";
import { AudioPreferences } from "../audio/AudioPreferences";
import { describeMediaError, MicrophoneController, type ProcessingKey } from "../audio/MicrophoneController";
import { SpeakerController, type Player } from "../audio/SpeakerController";
import { APP_VERSION, SIGNALING_RECONNECT } from "../core/config";
import { buildInviteUrl, parseInviteHash } from "../core/invite";
import { sanitizeDisplayName } from "../session/protocol";
import { SessionController } from "../session/SessionController";
import { PeerJsSignaling } from "../signaling/PeerJsSignaling";
import { AudioSettingsView } from "../ui/AudioSettingsView";
import { View } from "../ui/View";
import { collectDiagnostics } from "./diagnostics";

function createAudioElementPlayer(stream: MediaStream): Player {
  let audio: HTMLAudioElement | null = new Audio();
  audio.autoplay = false;
  audio.srcObject = stream;
  return {
    setSinkId: (sinkId) => {
      const el = audio as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (!el) return Promise.reject(new Error("stopped"));
      if (typeof el.setSinkId !== "function") {
        // Output selection unsupported: only the system default is acceptable (no silent rerouting).
        return sinkId === "" ? Promise.resolve() : Promise.reject(new Error("setSinkId unsupported"));
      }
      return el.setSinkId(sinkId);
    },
    setVolume: (v) => {
      if (audio) audio.volume = v;
    },
    play: () => audio?.play() ?? Promise.resolve(),
    stop: () => {
      if (!audio) return;
      audio.pause();
      audio.srcObject = null;
      audio = null;
    },
  };
}

/** Short, quiet, locally generated test tone routed to the selected output (AUD-013). */
function createTonePlayer(): TonePlayer {
  let ctx: AudioContext | null = null;
  let audio: HTMLAudioElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    async play(sinkId, durationMs) {
      ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.05; // low level
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      audio = new Audio();
      audio.srcObject = dest.stream;
      const el = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      // Route first; if the selected output cannot be confirmed, nothing is played (no fallback).
      if (typeof el.setSinkId === "function") await el.setSinkId(sinkId);
      else if (sinkId !== "") throw new Error("setSinkId unsupported");
      osc.start();
      await audio.play();
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, durationMs);
      });
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (audio) {
        audio.pause();
        audio.srcObject = null;
        audio = null;
      }
      void ctx?.close().catch(() => undefined);
      ctx = null;
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
  private readonly devices: AudioDevices;
  private readonly diagnostics: AudioDiagnostics;
  private readonly prefs = new AudioPreferences();
  private readonly settingsView: AudioSettingsView;
  private remember = false;
  private settingsNotice: string | null = null;
  private stopTestMeter: (() => void) | null = null;
  private readonly supported: ReadonlySet<string> = new Set(
    Object.keys(navigator.mediaDevices?.getSupportedConstraints?.() ?? {}),
  );

  constructor() {
    this.mic = new MicrophoneController({
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createMeter: (track) => new AnalyserMeter(this.audioGraph.get(), new MediaStream([track])),
    });
    this.speaker = new SpeakerController({
      createPlayer: createAudioElementPlayer,
      createMeter: (stream) => new AnalyserMeter(this.audioGraph.get(), stream),
    });
    this.devices = new AudioDevices({
      enumerate: () => navigator.mediaDevices.enumerateDevices(),
      onDeviceChange: (cb) => {
        const md = navigator.mediaDevices;
        if (!md || !("ondevicechange" in md)) return null;
        md.addEventListener("devicechange", cb);
        return () => md.removeEventListener("devicechange", cb);
      },
      outputSelectable: typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === "function",
    });
    this.diagnostics = new AudioDiagnostics({
      getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
      createMeter: (track) => new AnalyserMeter(this.audioGraph.get(), new MediaStream([track])),
      createTonePlayer,
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
      participantAudio: (peer) => this.speaker.getParticipantAudio(peer),
      setParticipantVolume: (peer, v) => this.speaker.setParticipantVolume(peer, v),
      toggleParticipantMute: (peer) => {
        this.speaker.setParticipantMuted(peer, !this.speaker.getParticipantAudio(peer).muted);
        this.view.renderSession(this.session.snapshot());
      },
      retrySignaling: () => this.signaling.retryNow(),
      rejoin: (target) => this.session.requestJoin(target), // explicit click; full admission again (REC-014)
      renewUid: () => {
        // Only outside a session: a new Peer would close every P2P link (REC-003).
        if (this.session.snapshot().phase === "idle") this.signaling.renewIdentity();
      },
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

    this.settingsView = new AudioSettingsView({
      selectMic: (id) => {
        this.diagnostics.stopMicTest(); // AUD-012: device change ends a running test
        this.settingsNotice = null;
        void this.mic.selectDevice(id, this.isAvailable("audioinput", id));
        this.savePrefs();
      },
      selectOutput: (id) => {
        this.speaker.selectOutput(id, this.isAvailable("audiooutput", id));
        this.savePrefs();
      },
      grantLabels: () => void this.grantLabels(),
      toggleMicTest: () => {
        const t = this.diagnostics.snapshot().micTest;
        if (t === "running" || t === "starting") return this.diagnostics.stopMicTest();
        // Only outside a session and with the communication mic off: never a second capture (AUD-012).
        if (this.session.snapshot().phase !== "idle" || this.mic.snapshot().state === "on") return;
        const m = this.mic.snapshot();
        void this.diagnostics.startMicTest(m.selectedDeviceId, m.requested);
      },
      speakerTest: () => void this.diagnostics.playTestTone(this.speaker.snapshot().outputDeviceId),
      setMasterVolume: (v) => {
        this.speaker.setMasterVolume(v);
        this.savePrefs();
      },
      setProcessing: (k: ProcessingKey, v) => {
        void this.mic.setProcessing(k, v);
        this.savePrefs();
      },
      setRemember: (on) => {
        this.remember = on && this.prefs.available;
        if (this.remember) this.savePrefs();
        else this.prefs.clear();
        this.renderSettings();
      },
      clearPrefs: () => {
        this.prefs.clear();
        this.remember = false;
        this.renderSettings();
      },
      refreshDevices: () => void this.devices.refresh(),
      panelToggled: (open) => {
        if (!open) this.diagnostics.stopMicTest();
        this.renderSettings();
      },
    });
    this.devices.onChange((snap) => {
      this.validateSelections(snap);
      this.renderSettings();
    });
    this.diagnostics.onChange((d) => {
      this.updateTestMeter(d.micTest === "running");
      this.renderSettings();
    });
    this.signaling.on("state", () => this.renderSignaling());
    this.signaling.on("open", () => this.renderSignaling());
    this.signaling.on("error", () => this.renderSignaling());
    this.session.onChange((s) => {
      // Joining/being in a session ends a local mic test (AUD-012).
      if (s.phase !== "idle") this.diagnostics.stopMicTest();
      this.view.renderSession(s);
      this.renderSettings();
    });
    this.mic.onChange((m) => {
      this.view.renderMic(m);
      this.updateMicMeter(m.state === "on");
      this.renderSettings();
    });
    this.speaker.onChange((s) => {
      this.view.renderSpeaker(s);
      this.updateSpeakerMeter(s.enabled);
      this.renderSettings();
    });
  }

  start(): void {
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("online", this.onBrowserOnline);
    window.addEventListener("hashchange", this.readInvite);
    window.addEventListener("pageshow", this.onPageShow);
    this.renderSignaling();
    this.view.renderSession(this.session.snapshot());
    this.view.renderMic(this.mic.snapshot());
    this.view.renderSpeaker(this.speaker.snapshot());
    this.readInvite();
    this.loadPrefs();
    this.devices.start();
    this.renderSettings();
    this.signaling.start();
  }

  // ---------------------------------------------------------------- audio devices (PA-009)

  /** Unknown (labels hidden before permission) counts as available: getUserMedia/setSinkId verify later. */
  private isAvailable(kind: "audioinput" | "audiooutput", id: string | null): boolean {
    if (id === null) return true;
    const snap = this.devices.snapshot();
    return this.devices.has(kind, id) || !snap.labelsAvailable;
  }

  /** AUD-009/010/011: a missing selected device turns mic/speaker off; nothing falls back silently. */
  private validateSelections(snap: DeviceSnapshot): void {
    const micId = this.mic.snapshot().selectedDeviceId;
    if (micId !== null) {
      if (snap.inputs.some((d) => d.id === micId)) this.mic.markDeviceAvailable();
      else if (snap.labelsAvailable) this.mic.markDeviceUnavailable();
    }
    const outId = this.speaker.snapshot().outputDeviceId;
    if (outId !== null) {
      if (snap.outputs.some((d) => d.id === outId)) this.speaker.markOutputAvailable();
      else if (snap.labelsAvailable) this.speaker.markOutputUnavailable();
    }
    const testId = this.diagnostics.snapshot().micTestDeviceId;
    if (testId && snap.labelsAvailable && !snap.inputs.some((d) => d.id === testId)) this.diagnostics.stopMicTest();
  }

  /** Explicit click: a momentary capture so the browser reveals device names; stopped immediately. */
  private async grantLabels(): Promise<void> {
    if (this.mic.snapshot().state === "on" || this.diagnostics.snapshot().micTest !== "idle") return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      for (const t of s.getTracks()) t.stop();
      this.settingsNotice = null;
    } catch (err) {
      this.settingsNotice = describeMediaError(err);
    }
    await this.devices.refresh();
  }

  private loadPrefs(): void {
    const saved = this.prefs.load();
    if (!saved) return;
    this.remember = true;
    void this.mic.selectDevice(saved.inputId); // muted: only stores the choice (AUD-004)
    this.speaker.selectOutput(saved.outputId); // off: only stores the choice (AUD-008)
    this.speaker.setMasterVolume(saved.masterVolume);
    for (const k of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
      void this.mic.setProcessing(k, saved.processing[k]);
    }
  }

  private savePrefs(): void {
    if (!this.remember) return;
    const m = this.mic.snapshot();
    const sp = this.speaker.snapshot();
    this.prefs.save({ inputId: m.selectedDeviceId, outputId: sp.outputDeviceId, masterVolume: sp.masterVolume, processing: m.requested });
  }

  private renderSettings(): void {
    if (this.shutDown) return;
    this.settingsView.render({
      devices: this.devices.snapshot(),
      mic: this.mic.snapshot(),
      speaker: this.speaker.snapshot(),
      diag: this.diagnostics.snapshot(),
      inSession: this.session.snapshot().phase !== "idle",
      remember: this.remember,
      storageAvailable: this.prefs.available,
      supported: this.supported,
      prefsNotice: this.settingsNotice,
    });
  }

  private updateTestMeter(on: boolean): void {
    if (on && !this.stopTestMeter) {
      this.stopTestMeter = this.meterLoop.add(() => this.settingsView.setTestLevel(this.diagnostics.readMicTestLevel()));
    } else if (!on && this.stopTestMeter) {
      this.stopTestMeter();
      this.stopTestMeter = null;
      this.settingsView.setTestLevel(0);
    }
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

  /** Network came back: try signaling now instead of waiting for the next backoff step. */
  private readonly onBrowserOnline = (): void => {
    const s = this.signaling.state;
    if (s === "reconnecting" || s === "unavailable") this.signaling.retryNow();
  };

  private renderSignaling(): void {
    this.view.renderSignaling({
      state: this.signaling.state,
      uid: this.signaling.uid,
      attempt: this.signaling.reconnectAttempt,
      maxAttempts: SIGNALING_RECONNECT.delaysMs.length,
      uidLost: this.signaling.uidLost,
    });
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
    window.removeEventListener("online", this.onBrowserOnline);
    this.setDiagnostics(false);
    this.diagnostics.dispose(); // ends a local mic test / tone (page close, AUD-012)
    this.devices.dispose();
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
