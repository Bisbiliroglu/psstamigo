/**
 * Microphone lifecycle (FR-007, PRIV-001, PRIV-002, PRIV-006).
 *
 * - Off by default. Only enable() (called from an explicit user action) captures.
 * - disable() really stops capture: every sender gets replaceTrack(null), the
 *   captured track is stop()ped, and the analyser is disconnected.
 * - Every enable() gets a generation number; a stale getUserMedia result is
 *   stopped immediately and can never change state.
 */
import { Emitter } from "../core/emitter";
import type { Meter } from "./levels";

export type MicState = "off" | "starting" | "on" | "error";

export interface MicSnapshot {
  state: MicState;
  error: string | null;
}

export interface MicrophoneDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMeter: (track: MediaStreamTrack) => Meter | null;
}

/** Audio-only constraints. Video is never requested (PRIV-008). */
export const MIC_CONSTRAINTS: MediaStreamConstraints = Object.freeze({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
});

export class MicrophoneController {
  private state: MicState = "off";
  private error: string | null = null;
  private generation = 0;
  private track: MediaStreamTrack | null = null;
  private meter: Meter | null = null;
  private readonly senders = new Set<RTCRtpSender>();
  private readonly events = new Emitter<{ change: MicSnapshot }>();
  private disposed = false;

  constructor(private readonly deps: MicrophoneDeps) {}

  onChange(cb: (s: MicSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): MicSnapshot {
    return { state: this.state, error: this.error };
  }

  /** Current level 0..1 from the real captured signal; 0 when off. */
  readLevel(): number {
    return this.state === "on" && this.meter ? this.meter.read() : 0;
  }

  /** Registers an outbound audio sender. It receives the live track only if the mic is on. */
  addSender(sender: RTCRtpSender): void {
    this.senders.add(sender);
    void this.applyTrack(sender, this.state === "on" ? this.track : null);
  }

  removeSender(sender: RTCRtpSender): void {
    if (!this.senders.delete(sender)) return;
    void this.applyTrack(sender, null);
  }

  async enable(): Promise<void> {
    if (this.disposed || this.state === "on" || this.state === "starting") return;
    const gen = ++this.generation;
    this.setState("starting", null);

    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      if (gen === this.generation && !this.disposed) this.setState("error", describeMediaError(err));
      return;
    }

    // Stale or cancelled: release the capture immediately (PRIV-006).
    if (gen !== this.generation || this.disposed) {
      stopAll(stream);
      return;
    }

    for (const t of stream.getVideoTracks()) t.stop(); // defensive, never requested
    const [track, ...extra] = stream.getAudioTracks();
    for (const t of extra) t.stop();
    if (!track) {
      this.setState("error", "Mikrofon izi alınamadı.");
      return;
    }

    this.track = track;
    track.addEventListener("ended", this.onTrackEnded);
    this.meter = this.deps.createMeter(track);
    for (const sender of this.senders) void this.applyTrack(sender, track);
    this.setState("on", null);
  }

  /** Real shutdown. Safe to call repeatedly and in any state. */
  disable(): void {
    this.generation++; // invalidates any pending enable()
    for (const sender of this.senders) void this.applyTrack(sender, null);
    this.releaseCapture();
    if (this.state !== "off" || this.error !== null) this.setState("off", null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disable();
    this.disposed = true;
    this.senders.clear();
    this.events.clear();
  }

  private readonly onTrackEnded = (): void => {
    // Device unplugged / permission revoked: fall back to a safe "off" state.
    this.disable();
    this.setState("error", "Mikrofon bağlantısı kesildi.");
  };

  private releaseCapture(): void {
    this.meter?.dispose();
    this.meter = null;
    if (this.track) {
      this.track.removeEventListener("ended", this.onTrackEnded);
      this.track.stop();
      this.track = null;
    }
  }

  private async applyTrack(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
    try {
      await sender.replaceTrack(track);
    } catch {
      // Sender's connection may already be closed; nothing to send then.
    }
  }

  private setState(state: MicState, error: string | null): void {
    this.state = state;
    this.error = error;
    this.events.emit("change", this.snapshot());
  }
}

function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Mikrofon izni verilmedi. Metin sohbeti ve ses dinleme çalışmaya devam eder.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "Mikrofon bulunamadı.";
    case "NotReadableError":
    case "AbortError":
      return "Mikrofon başka bir uygulama tarafından kullanılıyor olabilir.";
    default:
      return "Mikrofon açılamadı.";
  }
}
