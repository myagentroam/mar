import { describe, expect, it } from 'vitest';
import { BrowserFrameRate } from '../../src/browser/browser-frame-rate.js';

const fast = { bytes: 2048, writeMs: 2, confirmedMs: 12 };
const slow = { bytes: 12_288, writeMs: 5, confirmedMs: 130 };

describe('Browser frame rate policy', () => {
  it('backs off frame rate before bitrate, then probes upward with sustained good samples', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    rate.record(fast, 0);
    for (const at of [150, 300, 450]) rate.record(slow, at);
    expect(rate.profile.fps).toBeLessThan(initial.fps);
    expect(rate.profile.bitrate).toBe(initial.bitrate);
    for (const at of [600, 750, 900]) rate.record(slow, at);
    const constrained = rate.profile;
    expect(constrained.bitrate).toBeLessThan(initial.bitrate);

    rate.record(fast, 5000);
    expect(rate.profile).toBe(constrained);
    for (let at = 5150; at <= 6950; at += 150) rate.record(fast, at);
    expect(rate.profile.bitrate).toBe(initial.bitrate);
    expect(rate.profile.fps).toBeLessThan(initial.fps);
    for (let at = 7100; at <= 9050; at += 150) rate.record(fast, at);
    expect(rate.profile).toBe(initial);
  });

  it('does not treat static gaps or an already high but steady ACK time as congestion', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    for (let at = 0; at <= 1200; at += 150) {
      rate.record({ ...fast, confirmedMs: 180 }, at);
    }
    for (const at of [3000, 6000, 9000]) {
      rate.record({ ...slow, writeMs: 100, confirmedMs: 300 }, at);
    }
    expect(rate.profile).toBe(initial);
  });

  it('backs off on slow writes without needing a separate RTT probe', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    for (const at of [0, 200, 400]) {
      rate.record({ bytes: slow.bytes, writeMs: 90, confirmedMs: 115 }, at);
    }
    expect(rate.profile.fps).toBeLessThan(initial.fps);
  });

  it('detects sustained ACK pressure even before receiving a small frame', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    for (const at of [0, 200, 400]) rate.record({ ...slow, confirmedMs: 190 }, at);
    expect(rate.profile.fps).toBeLessThan(initial.fps);
  });

  it('distinguishes a slow stream from idle time between frame deliveries', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    for (const at of [1500, 3000, 4500]) rate.record({ ...slow, confirmedMs: 1500 }, at);
    expect(rate.profile.fps).toBeLessThan(initial.fps);
  });

  it('recovers on fresh ACKs from an intermittently changing page', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    rate.record(fast, 0);
    for (const at of [150, 300, 450]) rate.record(slow, at);
    expect(rate.profile.fps).toBeLessThan(initial.fps);

    for (const at of [2000, 4000, 6000, 8000, 10000, 12000, 14000]) rate.record(fast, at);
    expect(rate.profile.fps).toBeLessThan(initial.fps);
    rate.record(fast, 16000);
    expect(rate.profile).toBe(initial);
  });

  it('does not combine stale recovery samples across a long idle period', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    rate.record(fast, 0);
    for (const at of [150, 300, 450]) rate.record(slow, at);
    for (const at of [2000, 2300, 2600, 2900, 3200, 3500, 3800]) rate.record(fast, at);
    rate.record(fast, 20000);
    expect(rate.profile.fps).toBeLessThan(initial.fps);
  });

  it('can recover with only large frames once ACK pressure clears and writes are fast', () => {
    const rate = new BrowserFrameRate();
    const initial = rate.profile;
    for (const at of [200, 400, 600]) rate.record({ ...slow, confirmedMs: 190 }, at);
    expect(rate.profile.fps).toBeLessThan(initial.fps);

    for (let at = 900; at <= 3000; at += 300) rate.record(slow, at);
    expect(rate.profile).toBe(initial);
  });
});
