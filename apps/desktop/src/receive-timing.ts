/** Lifetime totals and a bounded recent window, sampled only when stats are read. */
export class ReceiveTiming {
  private readonly values = new Float64Array(256);
  private count = 0;
  private total = 0;
  private maximum = 0;
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values[this.count % this.values.length] = ms;
    this.count++;
    this.total += ms;
    this.maximum = Math.max(this.maximum, ms);
  }
  read() {
    const values = Array.from(
      this.values.subarray(
        0,
        Math.min(this.count, this.values.length),
      ),
    ).sort((a, b) => a - b);
    const percentile = (p: number) =>
      values[
        Math.max(0, Math.ceil(values.length * p) - 1)
      ] ?? null;
    return {
      count: this.count,
      totalMs: this.total,
      maxMs: this.maximum,
      windowCount: values.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
    };
  }
}
