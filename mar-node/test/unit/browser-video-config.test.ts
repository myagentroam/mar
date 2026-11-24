import { describe, expect, it } from 'vitest';
import { browserEncodeSize } from '../../src/browser/browser-video-config.js';

describe('Browser encoding size', () => {
  it.each([
    [
      { width: 1600, height: 900 },
      { width: 1280, height: 720 }
    ],
    [
      { width: 900, height: 1600 },
      { width: 720, height: 1280 }
    ],
    [
      { width: 1440, height: 900 },
      { width: 1152, height: 720 }
    ],
    [
      { width: 720, height: 720 },
      { width: 720, height: 720 }
    ],
    [
      { width: 641, height: 481 },
      { width: 640, height: 480 }
    ]
  ])('fits %o into the fixed envelope without upscaling', (viewport, expected) => {
    expect(browserEncodeSize(viewport)).toEqual(expected);
  });

  it.each([
    [
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 }
    ],
    [
      { width: 1440, height: 2560 },
      { width: 1080, height: 1920 }
    ],
    [
      { width: 960, height: 600 },
      { width: 960, height: 600 }
    ]
  ])('fits %o into the HD envelope without upscaling', (viewport, expected) => {
    expect(browserEncodeSize(viewport, true)).toEqual(expected);
  });
});
