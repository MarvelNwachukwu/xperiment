// Shared follow/scrape pacing helpers. Used by follow-bot and prospect/dm tools.

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomDelay(minSec: number, maxSec: number, label = "before next action"): Promise<void> {
  const sec = randInt(minSec, maxSec);
  const human = sec >= 90 ? `${(sec / 60).toFixed(1)}min` : `${sec}s`;
  console.log(`  Waiting ${human} ${label}...`);
  return new Promise((resolve) => setTimeout(resolve, sec * 1000));
}

export interface BurstPacing {
  clusterMin: number;
  clusterMax: number;
  intraDelayMinSec: number;
  intraDelayMaxSec: number;
  restDelayMinSec: number;
  restDelayMaxSec: number;
}

export type DelayKind = "intra" | "rest";
export interface DelayDecision {
  kind: DelayKind;
  sec: number;
}

// Sequences burst pacing: after each action, returns a short intra-burst delay
// or, when the cluster is exhausted, a long rest and starts a fresh cluster.
// rng is injectable for deterministic tests (defaults to Math.random).
export class BurstScheduler {
  private remaining: number;
  constructor(
    private readonly p: BurstPacing,
    private readonly rng: () => number = Math.random
  ) {
    this.remaining = this.pick(p.clusterMin, p.clusterMax);
  }

  private pick(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }

  next(): DelayDecision {
    this.remaining--;
    if (this.remaining > 0) {
      return { kind: "intra", sec: this.pick(this.p.intraDelayMinSec, this.p.intraDelayMaxSec) };
    }
    this.remaining = this.pick(this.p.clusterMin, this.p.clusterMax);
    return { kind: "rest", sec: this.pick(this.p.restDelayMinSec, this.p.restDelayMaxSec) };
  }
}

// Counts timestamps falling on the same UTC calendar day as `now`.
// `now` is passed in (ISO string) so callers control "today" and tests stay pure.
export function todayCountUTC(timestamps: string[], now: string): number {
  const day = now.slice(0, 10); // YYYY-MM-DD
  return timestamps.filter((t) => t.slice(0, 10) === day).length;
}

// Awaits a BurstScheduler decision (convenience for callers).
export async function applyDelay(d: DelayDecision): Promise<void> {
  const label = d.kind === "rest" ? "to rest between bursts" : "in this burst";
  await randomDelay(d.sec, d.sec, label);
}
