export class RateLimiter {
  private windows = new Map<string, number[]>();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests = 20, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    // Periodically evict expired windows to prevent unbounded growth
    setInterval(() => this.cleanup(), windowMs).unref();
  }

  isAllowed(userId: string): boolean {
    const now = Date.now();
    const recent = (this.windows.get(userId) ?? []).filter(ts => now - ts < this.windowMs);

    if (recent.length >= this.maxRequests) {
      this.windows.set(userId, recent);
      return false;
    }

    recent.push(now);
    this.windows.set(userId, recent);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [userId, timestamps] of this.windows.entries()) {
      const recent = timestamps.filter(ts => now - ts < this.windowMs);
      if (recent.length === 0) {
        this.windows.delete(userId);
      } else {
        this.windows.set(userId, recent);
      }
    }
  }
}
