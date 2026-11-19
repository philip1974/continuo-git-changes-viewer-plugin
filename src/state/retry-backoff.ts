/** 持续失败时两次重试之间最长的间隔。 */
export const MAX_RETRY_GAP_MS = 60_000;

/**
 * 按 tick 计的退避:自动刷新的 tick 里重试一件持续失败的事(见 GitViewerPanel 对 statusError 的处理)。
 * 第一次立即重试;之后两次重试相隔 2、4、8 … 个 tick,封顶为约 MAX_RETRY_GAP_MS(间隔本身不短于它时,
 * 每个 tick 都重试)。成功后 reset()。
 */
export class RetryBackoff {
  private failures = 0;
  private skip = 0;
  private readonly maxGapTicks: number;

  constructor(intervalMs: number) {
    this.maxGapTicks = Math.max(1, Math.floor(MAX_RETRY_GAP_MS / intervalMs));
  }

  /** 这个 tick 是否该重试(每个 tick 调用一次)。 */
  due(): boolean {
    if (this.skip > 0) {
      this.skip -= 1;
      return false;
    }
    return true;
  }

  failed(): void {
    this.failures += 1;
    // 2 ** failures 很快超过封顶值;指数本身也封顶,避免长时间失败后溢出成 Infinity
    const gap = Math.min(2 ** Math.min(this.failures, 30), this.maxGapTicks);
    this.skip = gap - 1;
  }

  reset(): void {
    this.failures = 0;
    this.skip = 0;
  }
}
