import type { BrowserVncQuality } from './framebuffer.js';

const profiles = [
  { quality: 'high', fps: 24, scale: 2 },
  { quality: 'high', fps: 12, scale: 2 },
  { quality: 'medium', fps: 10, scale: 1.5 },
  { quality: 'low', fps: 6, scale: 1 },
  { quality: 'low', fps: 4, scale: 0.65 }
] as const satisfies ReadonlyArray<{ quality: BrowserVncQuality; fps: number; scale: number }>;
// Soft budget for consecutive expensive motion updates. A single static
// refresh is never reduced just because it is large.
export const BROWSER_VNC_MOTION_BPS = 12_000_000;
const motionBudget = BROWSER_VNC_MOTION_BPS;

/** Hysteresis driven by complete updates, not by idle time or raw RTT. */
export class BrowserVncRate {
  private level: number;
  private slow = 0;
  private fast = 0;
  private cheap = 0;
  private ceiling = 0;

  constructor(relay: boolean) {
    this.level = relay ? 1 : 0;
  }

  get profile() {
    return profiles[this.level]!;
  }

  limit(quality: BrowserVncQuality | 'auto'): boolean {
    const before = this.profile;
    const ceiling = quality === 'medium' ? 2 : quality === 'low' ? 3 : 0;
    if (ceiling === this.ceiling) return false;
    this.ceiling = ceiling;
    // Changing the ceiling must not override an existing congestion decision.
    this.level = Math.max(this.level, ceiling);
    this.cheap = this.fast = this.slow = 0;
    return before !== this.profile;
  }

  observe(writeMs: number, confirmedMs: number, superseded: boolean, motionBytes = 0): boolean {
    const before = this.profile;
    const motionBps = motionBytes * 8 * before.fps;
    const slow = writeMs >= 100 || (superseded && confirmedMs >= 200) || motionBps > motionBudget;
    if (slow) {
      this.cheap = this.fast = 0;
      // Keep the normal debounce, but don't spend three large frames at every
      // rung when the measured motion is already several times over budget.
      if (++this.slow >= (motionBps >= motionBudget * 3 ? 2 : 3)) {
        this.level = Math.min(this.level + 1, profiles.length - 1);
        this.slow = 0;
      }
    } else {
      this.slow = 0;
      const next = profiles[Math.max(this.ceiling, this.level - 1)]!;
      const projected = motionBps * (next.fps / before.fps) * (next.scale / before.scale) ** 2;
      if (writeMs <= 45 && confirmedMs <= 150 && projected <= motionBudget * 0.75) {
        this.fast++;
        // A switch from textured motion to cheap updates (e.g. CopyRect) can
        // safely recover sooner. One still/repair or light frame is not enough.
        this.cheap = projected <= motionBudget * 0.25 ? this.cheap + 1 : 0;
        if (this.fast >= 8 || this.cheap >= 4) {
          this.level = Math.max(this.ceiling, this.level - 1);
          this.cheap = this.fast = 0;
        }
      } else this.cheap = this.fast = 0;
    }
    return before !== this.profile;
  }
}
