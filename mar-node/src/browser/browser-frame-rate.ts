import {
  BROWSER_VIDEO_BITRATE,
  BROWSER_VIDEO_FRAMERATE,
  BROWSER_VIDEO_HD_BITRATE
} from './browser-video-config.js';

const profiles = [
  { fps: BROWSER_VIDEO_FRAMERATE, bitrate: BROWSER_VIDEO_BITRATE, hd: false },
  { fps: 10, bitrate: BROWSER_VIDEO_BITRATE, hd: false },
  { fps: 10, bitrate: 768_000, hd: false },
  { fps: 6, bitrate: 384_000, hd: false }
] as const;
const directProfiles = [
  { fps: BROWSER_VIDEO_FRAMERATE, bitrate: BROWSER_VIDEO_HD_BITRATE, hd: true },
  { fps: 10, bitrate: BROWSER_VIDEO_HD_BITRATE, hd: true },
  { fps: 10, bitrate: 2_400_000, hd: true },
  ...profiles.slice(1)
] as const;
const UNKNOWN_ACK_FLOOR_MS = 80;
type Sample = { bytes: number; writeMs: number; confirmedMs: number };

/** Adjusts one attachment's outbound cadence and bitrate from delivered frames.
 * The stream owns timing and credit; this policy never starts probes or timers.
 */
export class BrowserFrameRate {
  private readonly profiles;
  private level = 0;
  private smallFrameDelay: number | undefined;
  private lastSampleAt: number | undefined;
  private slowFrames = 0;
  private goodFrames = 0;
  private goodSince = 0;

  constructor(hd = false) {
    this.profiles = hd ? directProfiles : profiles;
  }

  get profile() {
    return this.profiles[this.level]!;
  }

  record({ bytes, writeMs, confirmedMs }: Sample, now: number): void {
    if (this.lastSampleAt !== undefined) {
      const idleMs = now - confirmedMs - this.lastSampleAt;
      if (idleMs > 1000) this.slowFrames = 0;
      // Intermittent input can prove recovery without continuous animation.
      if (idleMs > 5000) this.goodFrames = 0;
    }
    this.lastSampleAt = now;

    // Small frames give a floor that includes the path's steady ACK and decode cost.
    // Let it move upward slowly so a single stall does not hide congestion.
    if (bytes <= 4 * 1024 && writeMs <= 20) {
      const floor = this.smallFrameDelay ?? confirmedMs;
      this.smallFrameDelay = Math.min(confirmedMs, floor + (confirmedMs - floor) * 0.08);
    }
    // A stream of only large frames may not have sampled the ACK floor yet.
    const excessMs = confirmedMs - (this.smallFrameDelay ?? UNKNOWN_ACK_FLOOR_MS);
    if (writeMs >= 60 || excessMs >= 70) {
      this.goodFrames = 0;
      if (++this.slowFrames >= 3) {
        this.level = Math.min(this.level + 1, this.profiles.length - 1);
        this.slowFrames = 0;
      }
    } else {
      this.slowFrames = 0;
      // Without a measured ACK floor, use a narrower dead band so healthy
      // large frames can trigger a trial even when no small frames follow.
      const maxGoodExcessMs = this.smallFrameDelay === undefined ? 55 : 35;
      if (this.level === 0 || writeMs > 20 || excessMs > maxGoodExcessMs) {
        this.goodFrames = 0;
        return;
      }
      if (this.goodFrames++ === 0) this.goodSince = now;
      if (this.goodFrames >= 8 && now - this.goodSince >= 1800) {
        this.level--;
        this.goodFrames = 0;
      }
    }
  }
}
