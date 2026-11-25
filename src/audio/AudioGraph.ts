/**
 * Owns the single AudioContext. Created lazily, only from a user gesture path
 * (accepting a request, enabling mic/speaker). Closed on session end and page shutdown.
 */
export class AudioGraph {
  private ctx: AudioContext | null = null;

  get(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  /**
   * A silent, synthetic audio stream that is NOT connected to any microphone.
   * PeerJS requires a stream to call()/answer(); this provides the audio m-line
   * so the real microphone track can later be attached via replaceTrack() without
   * renegotiation (DECISIONS D-002).
   */
  createSilentStream(): MediaStream {
    return this.get().createMediaStreamDestination().stream;
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }
}
