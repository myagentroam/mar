import { describe, expect, it } from 'vitest';
import { browserEncodeSize, browserStreamSize } from '../../src/browser/browser-video-config.js';

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

  it.each([
    [
      { width: 800, height: 450 },
      { width: 1600, height: 900 },
      { width: 800, height: 450 }
    ],
    [
      { width: 960, height: 600 },
      { width: 1728, height: 1080 },
      { width: 960, height: 600 }
    ],
    [
      { width: 390, height: 701 },
      { width: 780, height: 1402 },
      { width: 390, height: 700 }
    ],
    [
      { width: 1920, height: 1080 },
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 }
    ]
  ])(
    'uses device pixels for HD and preserves the standard size for %o',
    (viewport, hd, standard) => {
      expect(browserStreamSize(viewport, true)).toEqual(hd);
      expect(browserStreamSize(viewport, false)).toEqual(standard);
    }
  );
});
