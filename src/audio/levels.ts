/**
 * Audio level measurement and activity detection.
 * Levels are always computed from the real signal (no simulated animation).
 */

export interface Meter {
  /** Current level, 0..1 (dBFS mapped from -60..0). */
  read(): number;
  dispose(): void;
}

const MIN_DB = -60;

/** Converts RMS of a time-domain buffer to a 0..1 level. Pure, unit-tested. */
export function rmsToLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - MIN_DB) / -MIN_DB));
}

export class AnalyserMeter implements Meter {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly buffer: Float32Array<ArrayBuffer>;
  private disposed = false;

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(this.analyser.fftSize);
    // Analyser only; never connected to ctx.destination (no playback through Web Audio).
    this.source.connect(this.analyser);
  }

  read(): number {
    if (this.disposed) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    return rmsToLevel(this.buffer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.disconnect();
    this.analyser.disconnect();
  }
}

/**
 * Smoothing + hysteresis so the "speaking" state does not flicker.
 * Pure state machine, unit-tested.
 */
export class ActivityDetector {
  private smoothed = 0;
  private speaking = false;
  private lastAbove = -Infinity;

  constructor(
    private readonly onThreshold = 0.42,
    private readonly offThreshold = 0.32,
    private readonly holdMs = 300,
    private readonly attack = 0.6,
    private readonly release = 0.15,
  ) {}

  update(level: number, now: number): { level: number; speaking: boolean } {
    const k = level > this.smoothed ? this.attack : this.release;
    this.smoothed += (level - this.smoothed) * k;
    if (this.smoothed >= this.onThreshold) {
      this.speaking = true;
      this.lastAbove = now;
    } else if (this.speaking && this.smoothed < this.offThreshold && now - this.lastAbove > this.holdMs) {
      this.speaking = false;
    }
    return { level: this.smoothed, speaking: this.speaking };
  }

  reset(): void {
    this.smoothed = 0;
    this.speaking = false;
    this.lastAbove = -Infinity;
  }
}

/**
 * One requestAnimationFrame loop for all meters, throttled to ~15 fps.
 * Runs only while there is at least one subscriber; rAF pauses automatically
 * in background tabs, so indicators cost nothing while the user is in a game.
 */
export class MeterLoop {
  private readonly subscribers = new Set<(now: number) => void>();
  private frame: number | null = null;
  private last = 0;
  private static readonly INTERVAL_MS = 66;

  add(fn: (now: number) => void): () => void {
    this.subscribers.add(fn);
    this.ensureRunning();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  private ensureRunning(): void {
    if (this.frame === null) this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    if (this.subscribers.size === 0) return;
    if (now - this.last >= MeterLoop.INTERVAL_MS) {
      this.last = now;
      for (const fn of [...this.subscribers]) fn(now);
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  clear(): void {
    this.subscribers.clear();
    this.stop();
  }
}
