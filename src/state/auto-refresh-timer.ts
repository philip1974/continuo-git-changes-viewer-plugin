export interface AutoRefreshTimerOpts {
  readonly intervalMs: number;
  readonly onTick: () => Promise<void> | void;
  readonly onError?: (err: unknown) => void;
}

export class AutoRefreshTimer {
  private handle: ReturnType<typeof setInterval> | null = null;
  private opts: AutoRefreshTimerOpts | null = null;
  private ticking = false;
  private lastWarnMessage = '';
  private lastWarnAt = 0;

  start(opts: AutoRefreshTimerOpts): void {
    this.stop();
    if (opts.intervalMs < 2000) return;
    this.opts = opts;
    this.handle = setInterval(() => {
      void this.tick();
    }, opts.intervalMs);
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
    this.opts = null;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.opts?.onTick();
    } catch (err) {
      this.handleError(err);
    } finally {
      this.ticking = false;
    }
  }

  private handleError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (message === this.lastWarnMessage && now - this.lastWarnAt < 60_000) {
      return;
    }
    this.lastWarnMessage = message;
    this.lastWarnAt = now;
    this.opts?.onError?.(err);
  }
}
