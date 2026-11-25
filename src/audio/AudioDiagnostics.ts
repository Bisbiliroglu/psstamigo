/**
 * Local audio diagnostics (AUD-012, AUD-013; D-033, user-approved controlled addition to PRIV-001).
 *
 * Microphone test:
 * - only by explicit click, only OUTSIDE a session (the app enforces this), uses ONLY the selected device;
 * - its track is never given to any RTCRtpSender (this module has no access to senders), never played
 *   back (no sidetone), never recorded or sent anywhere — a level meter is the only consumer;
 * - stops on: user stop, timeout (15 s), panel close, device change, session start, track end, page close.
 *
 * Speaker test: a short, quiet, locally generated tone routed to the selected output; if routing
 * cannot be confirmed, nothing is played. It never touches remote playback or the speaker state.
 */
import { Emitter } from "../core/emitter";
import type { Meter } from "./levels";
import { describeMediaError, micConstraints, type ProcessingSettings } from "./MicrophoneController";

export const MIC_TEST_MS = 15_000;
export const TONE_MS = 1_500;

export type MicTestState = "idle" | "starting" | "running" | "error";

export interface DiagnosticsSnapshot {
  micTest: MicTestState;
  micTestError: string | null;
  /** Device the test capture actually used (from getSettings), if reported. */
  micTestDeviceId: string | null;
  speakerTest: "idle" | "playing" | "error";
  speakerTestError: string | null;
}

export interface TonePlayer {
  /** Routes to the device ("" = default), then plays; rejects if routing fails (nothing is played). */
  play(sinkId: string, durationMs: number): Promise<void>;
  stop(): void;
}

export interface DiagnosticsDeps {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createMeter: (track: MediaStreamTrack) => Meter | null;
  createTonePlayer: () => TonePlayer;
}

export class AudioDiagnostics {
  private state: DiagnosticsSnapshot = {
    micTest: "idle",
    micTestError: null,
    micTestDeviceId: null,
    speakerTest: "idle",
    speakerTestError: null,
  };
  private generation = 0;
  private track: MediaStreamTrack | null = null;
  private meter: Meter | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tone: TonePlayer | null = null;
  private toneGeneration = 0;
  private readonly events = new Emitter<{ change: DiagnosticsSnapshot }>();

  constructor(private readonly deps: DiagnosticsDeps) {}

  onChange(cb: (s: DiagnosticsSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): DiagnosticsSnapshot {
    return this.state;
  }

  readMicTestLevel(): number {
    return this.state.micTest === "running" && this.meter ? this.meter.read() : 0;
  }

  async startMicTest(deviceId: string | null, processing: ProcessingSettings): Promise<void> {
    this.stopMicTest();
    const gen = ++this.generation;
    this.set({ micTest: "starting", micTestError: null, micTestDeviceId: null });
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(micConstraints(deviceId, processing));
    } catch (err) {
      if (gen === this.generation) this.set({ micTest: "error", micTestError: describeMediaError(err, deviceId !== null) });
      return;
    }
    if (gen !== this.generation) {
      for (const t of stream.getTracks()) t.stop(); // stale test capture (PRIV-006)
      return;
    }
    for (const t of stream.getVideoTracks()) t.stop();
    const [track, ...extra] = stream.getAudioTracks();
    for (const t of extra) t.stop();
    if (!track) return this.set({ micTest: "error", micTestError: "Mikrofon izi alınamadı." });
    const actual = track.getSettings?.().deviceId ?? null;
    if (deviceId !== null && actual && actual !== deviceId) {
      track.stop();
      return this.set({ micTest: "error", micTestError: "Seçilen mikrofon açılamadı (farklı cihaz döndü)." });
    }
    this.track = track;
    track.addEventListener("ended", this.onEnded);
    this.meter = this.deps.createMeter(track);
    this.timer = setTimeout(() => this.stopMicTest(), MIC_TEST_MS); // bounded safety timeout
    this.set({ micTest: "running", micTestDeviceId: actual });
  }

  /** Idempotent; also used for panel close, device change, session start and page close. */
  stopMicTest(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.meter?.dispose();
    this.meter = null;
    if (this.track) {
      this.track.removeEventListener("ended", this.onEnded);
      this.track.stop();
      this.track = null;
    }
    if (this.state.micTest !== "idle" || this.state.micTestError !== null) {
      this.set({ micTest: "idle", micTestError: null, micTestDeviceId: null });
    }
  }

  async playTestTone(outputId: string | null): Promise<void> {
    this.stopTone();
    const gen = ++this.toneGeneration;
    const tone = this.deps.createTonePlayer();
    this.tone = tone;
    this.set({ speakerTest: "playing", speakerTestError: null });
    try {
      await tone.play(outputId ?? "", TONE_MS);
      if (gen === this.toneGeneration) this.set({ speakerTest: "idle" });
    } catch {
      if (gen === this.toneGeneration) {
        this.set({
          speakerTest: "error",
          speakerTestError: "Test sesi seçilen çıkışa yönlendirilemedi; başka bir cihazdan çalınmadı.",
        });
      }
    } finally {
      if (gen === this.toneGeneration) this.stopTone();
    }
  }

  stopTone(): void {
    this.toneGeneration++;
    this.tone?.stop();
    this.tone = null;
  }

  dispose(): void {
    this.stopMicTest();
    this.stopTone();
    this.events.clear();
  }

  private readonly onEnded = (): void => {
    this.stopMicTest();
    this.set({ micTest: "error", micTestError: "Mikrofon bağlantısı kesildi; test durduruldu." });
  };

  private set(patch: Partial<DiagnosticsSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.events.emit("change", this.state);
  }
}
