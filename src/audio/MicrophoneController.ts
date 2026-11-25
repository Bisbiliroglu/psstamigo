/**
 * Microphone lifecycle (FR-007, PRIV-001, PRIV-002, PRIV-006) and input device selection (PA-009).
 *
 * - Off by default. Only enable() (called from an explicit user action) captures.
 * - disable() really stops capture: every sender gets replaceTrack(null), the
 *   captured track is stop()ped, and the analyser is disconnected.
 * - Every enable() gets a generation number; a stale getUserMedia result is
 *   stopped immediately and can never change state.
 * - Device selection (AUD-003…005): an explicit device is opened with `deviceId: { exact }` and
 *   verified through getSettings(); a failure leaves the mic OFF — never a silent fallback to another
 *   device (AUD-010). Switching stops the old capture BEFORE starting the new one (single capture).
 */
import { Emitter } from "../core/emitter";
import type { Meter } from "./levels";

export type MicState = "off" | "starting" | "on" | "error";

export interface ProcessingSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}
export type ProcessingKey = keyof ProcessingSettings;

export interface MicSnapshot {
  state: MicState;
  error: string | null;
  /** Selected input device (null = system default). */
  selectedDeviceId: string | null;
  /** False if the selected explicit device is known to be missing; enable() then refuses. */
  selectedAvailable: boolean;
  /** Device the live capture actually uses (from getSettings), null when off or unknown. */
  activeDeviceId: string | null;
  /** Requested processing settings. */
  requested: ProcessingSettings;
  /** Settings reported by the live track (null when off or not reported by the browser). */
  applied: Partial<ProcessingSettings> | null;
}

export interface MicrophoneDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createMeter: (track: MediaStreamTrack) => Meter | null;
}

/** Audio-only constraints for the system default device. Video is never requested (PRIV-008). */
export const MIC_CONSTRAINTS: MediaStreamConstraints = Object.freeze({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
  video: false,
});

export const DEFAULT_PROCESSING: ProcessingSettings = Object.freeze({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

/** Builds audio-only constraints for a device selection (exported for the local mic test). */
export function micConstraints(deviceId: string | null, p: ProcessingSettings): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    channelCount: 1,
  };
  if (deviceId !== null) audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

export class MicrophoneController {
  private state: MicState = "off";
  private error: string | null = null;
  private generation = 0;
  private track: MediaStreamTrack | null = null;
  private meter: Meter | null = null;
  private readonly senders = new Set<RTCRtpSender>();
  private readonly events = new Emitter<{ change: MicSnapshot }>();
  private disposed = false;
  private selectedDeviceId: string | null = null;
  private selectedAvailable = true;
  private requested: ProcessingSettings = { ...DEFAULT_PROCESSING };

  constructor(private readonly deps: MicrophoneDeps) {}

  onChange(cb: (s: MicSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): MicSnapshot {
    const settings = this.track?.getSettings?.() ?? null;
    return {
      state: this.state,
      error: this.error,
      selectedDeviceId: this.selectedDeviceId,
      selectedAvailable: this.selectedAvailable,
      activeDeviceId: this.state === "on" ? (settings?.deviceId ?? null) : null,
      requested: { ...this.requested },
      applied:
        this.state === "on" && settings
          ? pick(settings, ["echoCancellation", "noiseSuppression", "autoGainControl"])
          : null,
    };
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
    if (!this.selectedAvailable) {
      // AUD-010: never fall back to another microphone; the user must choose again.
      this.setState("error", "Seçilen mikrofon şu an bağlı değil. Ses ayarlarından bir mikrofon seç.");
      return;
    }
    const gen = ++this.generation;
    const wanted = this.selectedDeviceId;
    this.setState("starting", null);

    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(micConstraints(wanted, this.requested));
    } catch (err) {
      if (gen === this.generation && !this.disposed) this.setState("error", describeMediaError(err, wanted !== null));
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
    // AUD-003: verify the capture really comes from the selected device when the browser reports it.
    const actual = track.getSettings?.().deviceId;
    if (wanted !== null && actual && actual !== wanted) {
      track.stop();
      this.setState("error", "Seçilen mikrofon açılamadı (tarayıcı farklı bir cihaz verdi). Mikrofon kapalı.");
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

  /**
   * Selects the input device (null = system default). While muted this only stores the choice
   * (AUD-004: no capture). While on, it switches: old capture stopped first, then the new device
   * is opened; on failure the mic stays off (AUD-005).
   */
  async selectDevice(deviceId: string | null, available = true): Promise<void> {
    const changed = deviceId !== this.selectedDeviceId;
    this.selectedDeviceId = deviceId;
    this.selectedAvailable = available;
    const wasActive = this.state === "on" || this.state === "starting";
    if (!changed) {
      this.emit();
      return;
    }
    if (!wasActive) {
      if (this.state === "error") this.setState("off", null);
      else this.emit();
      return;
    }
    this.disable();
    await this.enable();
  }

  /**
   * The selected (or active) device disappeared (devicechange / track ended): stop capture,
   * show it, and do NOT open another microphone (AUD-010). Reconnecting never re-enables.
   */
  markDeviceUnavailable(): void {
    this.selectedAvailable = false;
    if (this.state === "on" || this.state === "starting") {
      this.disable();
      this.setState("error", "Seçilen mikrofonun bağlantısı kesildi. Mikrofon kapatıldı; başka bir mikrofon açılmadı.");
    } else {
      this.emit();
    }
  }

  markDeviceAvailable(): void {
    if (this.selectedAvailable) return;
    this.selectedAvailable = true;
    this.emit(); // available again, but stays OFF until the user enables it
  }

  /** AUD-017…019: stores the preference; applies it to a live track when possible and reports the result. */
  async setProcessing(key: ProcessingKey, value: boolean): Promise<void> {
    this.requested = { ...this.requested, [key]: value };
    const track = this.track;
    if (this.state !== "on" || !track) {
      this.emit(); // muted: never starts capture
      return;
    }
    const gen = this.generation;
    try {
      await track.applyConstraints({
        echoCancellation: this.requested.echoCancellation,
        noiseSuppression: this.requested.noiseSuppression,
        autoGainControl: this.requested.autoGainControl,
        channelCount: 1,
      });
      if (gen === this.generation) this.emit();
    } catch {
      if (gen === this.generation && this.state === "on") {
        this.error = "Bu ses işleme ayarı tarayıcı tarafından uygulanamadı; gösterilen değerler geçerli olanlardır.";
        this.emit();
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disable();
    this.disposed = true;
    this.senders.clear();
    this.events.clear();
  }

  private readonly onTrackEnded = (): void => {
    // Device unplugged / permission revoked: safe "off" state, no other device is opened.
    if (this.selectedDeviceId !== null) return this.markDeviceUnavailable();
    // System default: the OS may pick another default later; the user may enable again explicitly.
    this.disable();
    this.setState("error", "Mikrofon bağlantısı kesildi. Mikrofon kapatıldı.");
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
    this.emit();
  }

  private emit(): void {
    this.events.emit("change", this.snapshot());
  }
}

function pick(s: MediaTrackSettings, keys: ProcessingKey[]): Partial<ProcessingSettings> {
  const out: Partial<ProcessingSettings> = {};
  for (const k of keys) {
    const v = s[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function stopAll(stream: MediaStream): void {
  for (const t of stream.getTracks()) t.stop();
}

export function describeMediaError(err: unknown, explicitDevice = false): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Mikrofon izni verilmedi. Metin sohbeti ve ses dinleme çalışmaya devam eder.";
    case "NotFoundError":
    case "OverconstrainedError":
      return explicitDevice
        ? "Seçilen mikrofon bulunamadı veya kullanılamıyor. Başka bir mikrofon açılmadı; ses ayarlarından seç."
        : "Mikrofon bulunamadı.";
    case "NotReadableError":
    case "AbortError":
      return "Mikrofon başka bir uygulama tarafından kullanılıyor olabilir.";
    default:
      return "Mikrofon açılamadı.";
  }
}
