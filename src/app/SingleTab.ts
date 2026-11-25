/**
 * One active PsstAmigo tab per browser profile (D-035, user-approved).
 *
 * Uses the Web Locks API: no cookies, no storage, no network, no identifier. The browser releases the
 * lock automatically when the tab closes or crashes, so no "zombie" lock remains. A second tab does
 * not start the app (no UID, no signaling) until the user chooses "Burada devam et"; the first tab is
 * then asked over a same-origin BroadcastChannel to leave its call and stop.
 *
 * This is a convenience guard, not a security control: other browsers, profiles or private windows
 * are separate and cannot (and should not, PRIV-010) be linked.
 */

const LOCK_NAME = "psstamigo-active-tab";
const CHANNEL_NAME = "psstamigo-tab";
const TAKEOVER_WAIT_MS = 3_000;

export interface SingleTabCallbacks {
  /** This tab owns the lock: start the app. */
  acquired(): void;
  /** Another tab is active: show the choice (call `takeOver` to continue here). */
  busy(takeOver: () => void): void;
  /** Another tab took over: this tab must shut down and say so. */
  replaced(): void;
}

type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable?: boolean; steal?: boolean },
    cb: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
};

export class SingleTab {
  private release: (() => void) | null = null;
  private channel: BroadcastChannel | null = null;
  private stopped = false;
  /** True once this tab held the lock (a later rejection then means "stolen", never "start again"). */
  private everHeld = false;

  constructor(
    private readonly cb: SingleTabCallbacks,
    private readonly locks: LockManagerLike | null = (navigator as Navigator & { locks?: LockManagerLike }).locks ?? null,
    private readonly createChannel: () => BroadcastChannel | null = () =>
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME),
  ) {}

  start(): void {
    if (!this.locks) {
      // Unsupported browser: behave as before (no guard), never block the app.
      this.cb.acquired();
      return;
    }
    void this.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          this.cb.busy(() => this.takeOver());
          return;
        }
        return this.hold();
      })
      .catch(() => {
        // Locks failing before we ever held one must not lock the user out; a stolen lock must not restart us.
        if (!this.everHeld && !this.stopped) this.cb.acquired();
        // Our lock was stolen (we were frozen during a takeover): shut down now instead of running on.
        else if (this.everHeld && !this.stopped) {
          this.cb.replaced();
          this.stop();
        }
      });
  }

  private hold(): Promise<void> {
    this.everHeld = true;
    this.listenForTakeover();
    this.cb.acquired();
    return new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  private takeOver(): void {
    if (!this.locks || this.stopped) return;
    const ch = this.createChannel();
    ch?.postMessage({ t: "takeover" });
    ch?.close();
    let done = false;
    const acquire = (steal: boolean): void => {
      void this.locks
        ?.request(LOCK_NAME, steal ? { steal: true } : {}, () => {
          if (done) return undefined;
          done = true;
          return this.hold();
        })
        .catch(() => undefined);
    };
    acquire(false); // normally granted as soon as the other tab has left its call and released
    // If the other tab is frozen/unresponsive, take the lock anyway after a short wait.
    setTimeout(() => {
      if (!done) acquire(true);
    }, TAKEOVER_WAIT_MS);
  }

  private listenForTakeover(): void {
    this.channel = this.createChannel();
    if (!this.channel) return;
    this.channel.onmessage = (e: MessageEvent<unknown>) => {
      const d = e.data;
      if (typeof d === "object" && d !== null && (d as { t?: unknown }).t === "takeover") {
        this.cb.replaced(); // shuts the app down (leave call, destroy Peer) before we release
        this.stop();
      }
    };
  }

  /** Releases the lock (page termination or replaced). Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.channel?.close();
    this.channel = null;
    this.release?.();
    this.release = null;
  }
}
