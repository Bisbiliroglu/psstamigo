/**
 * Remote audio playback lifecycle (FR-008, PRIV-003).
 *
 * - Off by default. Receiving a remote stream never starts playback by itself.
 * - enable() must come from an explicit user action.
 * - disable() stops every player, detaches srcObject and disconnects analysers.
 * - New participants and reconnects inherit the current state; they never turn it on.
 *
 * Note: "remote packets are being received" and "audio is being played" are
 * different states. Only the latter is shown by the speaker indicator.
 */
import { Emitter } from "../core/emitter";
import type { Meter } from "./levels";

export interface Player {
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
}

interface Remote {
  stream: MediaStream;
  player: Player | null;
  meter: Meter | null;
}

export class SpeakerController {
  private enabled = false;
  private error: string | null = null;
  private readonly remotes = new Map<string, Remote>();
  private readonly events = new Emitter<{ change: SpeakerSnapshot }>();
  private disposed = false;

  constructor(private readonly deps: SpeakerDeps) {}

  onChange(cb: (s: SpeakerSnapshot) => void): () => void {
    return this.events.on("change", cb);
  }

  snapshot(): SpeakerSnapshot {
    return { enabled: this.enabled, error: this.error };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  addRemote(peerId: string, stream: MediaStream): void {
    if (this.disposed) return;
    this.removeRemote(peerId);
    const remote: Remote = { stream, player: null, meter: null };
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
    this.enabled = true;
    this.error = null;
    for (const [peerId, remote] of this.remotes) this.startPlayback(peerId, remote);
    this.emit();
  }

  disable(): void {
    for (const remote of this.remotes.values()) this.stopPlayback(remote);
    if (this.enabled || this.error !== null) {
      this.enabled = false;
      this.error = null;
      this.emit();
    }
  }

  /** Level of one participant's played audio (0 when speaker is off). */
  readLevel(peerId: string): number {
    if (!this.enabled) return 0;
    return this.remotes.get(peerId)?.meter?.read() ?? 0;
  }

  /** Maximum level across all played remote audio (0 when speaker is off). */
  readMaxLevel(): number {
    if (!this.enabled) return 0;
    let max = 0;
    for (const remote of this.remotes.values()) max = Math.max(max, remote.meter?.read() ?? 0);
    return max;
  }

  clear(): void {
    for (const peerId of [...this.remotes.keys()]) this.removeRemote(peerId);
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
    remote.meter = this.deps.createMeter(remote.stream);
    player.play().catch(() => {
      // Autoplay blocked or element failed; only report if still relevant.
      if (this.enabled && this.remotes.get(peerId) === remote && remote.player === player) {
        this.error = "Ses oynatılamadı. Hoparlörü kapatıp tekrar açmayı deneyin.";
        this.emit();
      }
    });
  }

  private stopPlayback(remote: Remote): void {
    remote.meter?.dispose();
    remote.meter = null;
    remote.player?.stop();
    remote.player = null;
  }

  private emit(): void {
    this.events.emit("change", this.snapshot());
  }
}
