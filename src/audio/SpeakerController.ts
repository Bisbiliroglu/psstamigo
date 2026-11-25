/**
 * Remote audio playback lifecycle (FR-008, PRIV-003) and output routing / volumes (PA-009).
 *
 * - Off by default. Receiving a remote stream never starts playback by itself.
 * - enable() must come from an explicit user action.
 * - disable() stops every player, detaches srcObject and disconnects analysers.
 * - New participants and reconnects inherit the current state; they never turn it on.
 * - Output routing (AUD-006…008, AUD-011): every player is routed with setSinkId BEFORE play();
 *   if routing fails for any player, playback stops entirely and the speaker turns off — audio is
 *   never played on another (e.g. default) device instead.
 * - Volumes (AUD-014…016) are local only: element volume = master × participant (0 when muted).
 *
 * Note: "remote packets are being received" and "audio is being played" are
 * different states. Only the latter is shown by the speaker indicator.
 */
import { Emitter } from "../core/emitter";
import type { Meter } from "./levels";

export interface Player {
  /** Routes output to the device ("" = system default). Must resolve before play() is called. */
  setSinkId(sinkId: string): Promise<void>;
  setVolume(volume: number): void;
  play(): Promise<void>;
  stop(): void;
}

export interface SpeakerDeps {
  createPlayer: (stream: MediaStream) => Player;
  createMeter: (stream: MediaStream) => Meter | null;
}

export interface SpeakerSnapshot {
  enabled: boolean;
  error: string | null;
  /** Selected output device (null = system default). */
  outputDeviceId: string | null;
  /** False if the selected explicit output is known to be missing; enable() then refuses. */
  outputAvailable: boolean;
  /** True while every active player is confirmed routed to the selected output. */
  routed: boolean;
  masterVolume: number;
}

export interface ParticipantAudio {
  volume: number;
  muted: boolean;
}

interface Remote {
  stream: MediaStream;
  player: Player | null;
  meter: Meter | null;
  /** True once setSinkId resolved and play() was started for this player. */
  routed: boolean;
}

export class SpeakerController {
  private enabled = false;
  private error: string | null = null;
  private readonly remotes = new Map<string, Remote>();
  private readonly participantAudio = new Map<string, ParticipantAudio>();
  private readonly events = new Emitter<{ change: SpeakerSnapshot }>();
  private disposed = false;
  private outputDeviceId: string | null = null;
  private outputAvailable = true;
  private masterVolume = 1;
  /** Invalidates routing callbacks of older output selections / enable cycles. */
  private routeGeneration = 0;

  constructor(private readonly deps: SpeakerDeps) {}

  onChange(cb: (s: SpeakerSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): SpeakerSnapshot {
    const active = [...this.remotes.values()].filter((r) => r.player);
    return {
      enabled: this.enabled,
      error: this.error,
      outputDeviceId: this.outputDeviceId,
      outputAvailable: this.outputAvailable,
      routed: this.enabled && active.every((r) => r.routed),
      masterVolume: this.masterVolume,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  addRemote(peerId: string, stream: MediaStream): void {
    if (this.disposed) return;
    this.removeRemote(peerId);
    const remote: Remote = { stream, player: null, meter: null, routed: false };
    this.remotes.set(peerId, remote);
    if (this.enabled) this.startPlayback(peerId, remote);
  }

  removeRemote(peerId: string): void {
    const remote = this.remotes.get(peerId);
    if (!remote) return;
    this.stopPlayback(remote);
    this.remotes.delete(peerId);
  }

  enable(): void {
    if (this.disposed || this.enabled) return;
    if (!this.outputAvailable) {
      // AUD-011: never fall back to another output; the user must choose again.
      this.error = "Seçilen ses çıkışı şu an bağlı değil. Ses ayarlarından bir çıkış seç.";
      this.emit();
      return;
    }
    this.enabled = true;
    this.error = null;
    this.routeGeneration++;
    for (const [peerId, remote] of this.remotes) this.startPlayback(peerId, remote);
    this.emit();
  }

  disable(): void {
    this.routeGeneration++;
    for (const remote of this.remotes.values()) this.stopPlayback(remote);
    if (this.enabled || this.error !== null) {
      this.enabled = false;
      this.error = null;
      this.emit();
    }
  }

  /**
   * AUD-007/008: selects the output (null = system default). While off this only stores the choice.
   * While on, all playback stops, every player is re-routed, and audio resumes only once routed.
   */
  selectOutput(deviceId: string | null, available = true): void {
    this.outputDeviceId = deviceId;
    this.outputAvailable = available;
    this.routeGeneration++;
    if (!this.enabled) {
      if (this.error !== null) this.error = null;
      this.emit();
      return;
    }
    for (const remote of this.remotes.values()) this.stopPlayback(remote);
    for (const [peerId, remote] of this.remotes) this.startPlayback(peerId, remote);
    this.emit();
  }

  /** AUD-011: the selected output disappeared — stop at once, show it, do not reroute. */
  markOutputUnavailable(): void {
    this.outputAvailable = false;
    if (this.enabled) {
      this.disable();
      this.error = "Seçilen ses çıkışının bağlantısı kesildi. Hoparlör kapatıldı; ses başka bir cihaza yönlendirilmedi.";
    }
    this.emit();
  }

  markOutputAvailable(): void {
    if (this.outputAvailable) return;
    this.outputAvailable = true;
    this.emit(); // stays OFF until the user enables it
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = clamp01(volume);
    this.applyVolumes();
    this.emit();
  }

  getParticipantAudio(peerId: string): ParticipantAudio {
    return this.participantAudio.get(peerId) ?? { volume: 1, muted: false };
  }

  setParticipantVolume(peerId: string, volume: number): void {
    this.participantAudio.set(peerId, { ...this.getParticipantAudio(peerId), volume: clamp01(volume) });
    this.applyVolumes();
  }

  setParticipantMuted(peerId: string, muted: boolean): void {
    this.participantAudio.set(peerId, { ...this.getParticipantAudio(peerId), muted });
    this.applyVolumes();
  }

  /** Effective element volume for a participant (local playback only). */
  effectiveVolume(peerId: string): number {
    const p = this.getParticipantAudio(peerId);
    return p.muted ? 0 : this.masterVolume * p.volume;
  }

  /** Level of one participant's PLAYED audio (0 when speaker off, not routed, or muted). */
  readLevel(peerId: string): number {
    if (!this.enabled) return 0;
    const remote = this.remotes.get(peerId);
    if (!remote?.routed) return 0;
    return (remote.meter?.read() ?? 0) * this.effectiveVolume(peerId);
  }

  /** Maximum played level across all remotes (0 when speaker is off). */
  readMaxLevel(): number {
    if (!this.enabled) return 0;
    let max = 0;
    for (const peerId of this.remotes.keys()) max = Math.max(max, this.readLevel(peerId));
    return max;
  }

  /** Session ended: drop streams and per-participant settings (session-scoped). */
  clear(): void {
    for (const peerId of [...this.remotes.keys()]) this.removeRemote(peerId);
    this.participantAudio.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disable();
    this.clear();
    this.disposed = true;
    this.events.clear();
  }

  private startPlayback(peerId: string, remote: Remote): void {
    if (remote.player) return;
    const player = this.deps.createPlayer(remote.stream);
    remote.player = player;
    remote.routed = false;
    remote.meter = this.deps.createMeter(remote.stream);
    player.setVolume(this.effectiveVolume(peerId));
    const gen = this.routeGeneration;
    const current = (): boolean =>
      this.enabled && gen === this.routeGeneration && this.remotes.get(peerId) === remote && remote.player === player;
    // Route first; play only on the confirmed device (never on the default by accident).
    player
      .setSinkId(this.outputDeviceId ?? "")
      .then(() => {
        if (!current()) return;
        remote.routed = true;
        this.emit();
        return player.play().catch(() => {
          if (current()) this.failPlayback("Ses oynatılamadı. Hoparlörü kapatıp tekrar açmayı deneyin.");
        });
      })
      .catch(() => {
        if (current()) {
          this.failPlayback("Ses çıkışı seçilen cihaza yönlendirilemedi. Hoparlör kapatıldı; başka bir cihazdan çalınmadı.");
        }
      });
  }

  /** Any routing/playback failure stops ALL playback (no partial or fallback output). */
  private failPlayback(message: string): void {
    this.disable();
    this.error = message;
    this.emit();
  }

  private applyVolumes(): void {
    for (const [peerId, remote] of this.remotes) remote.player?.setVolume(this.effectiveVolume(peerId));
  }

  private stopPlayback(remote: Remote): void {
    remote.meter?.dispose();
    remote.meter = null;
    remote.player?.stop();
    remote.player = null;
    remote.routed = false;
  }

  private emit(): void {
    this.events.emit("change", this.snapshot());
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}
