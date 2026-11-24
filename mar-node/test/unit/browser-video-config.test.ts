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
});
