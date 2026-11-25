/** Sliding-window rate limiter for untrusted peer input. */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns true if the event is allowed (and records it). */
  tryConsume(): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxEvents) return false;
    this.timestamps.push(t);
    return true;
  }
}
