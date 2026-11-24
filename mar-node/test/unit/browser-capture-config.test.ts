import { expect, it } from 'vitest';
import { browserStreamSize } from '../../src/browser/browser-capture-config.js';

it.each([
  [{ width: 800, height: 450 }, 1, { width: 800, height: 450 }],
  [{ width: 800, height: 450 }, 1.5, { width: 800, height: 450 }],
  [{ width: 660, height: 839 }, 2, { width: 660, height: 838 }],
  [{ width: 1920, height: 1080 }, 1, { width: 1920, height: 1080 }],
  [{ width: 2560, height: 1440 }, 1, { width: 1920, height: 1080 }],
  [{ width: 800, height: 450 }, 0.65, { width: 520, height: 292 }],
  [{ width: 1920, height: 1080 }, 0.65, { width: 864, height: 486 }],
  [{ width: 1440, height: 2560 }, 1, { width: 1080, height: 1920 }],
  [{ width: 800, height: 1200 }, 1, { width: 800, height: 1200 }]
] as const)('fits the capture raster for %o at %d', (css, density, raster) => {
  expect(browserStreamSize(css, density)).toEqual(raster);
});
