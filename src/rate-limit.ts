export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  private prune(now: number): void {
    while (this.timestamps.length > 0 && this.timestamps[0]! <= now - this.windowMs) this.timestamps.shift();
  }

  canTake(now = Date.now()): boolean {
    this.prune(now);
    return this.timestamps.length < this.limit;
  }

  take(now = Date.now()): boolean {
    if (!this.canTake(now)) return false;
    this.timestamps.push(now);
    return true;
  }
}
