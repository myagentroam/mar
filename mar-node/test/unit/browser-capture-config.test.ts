import { expect, it } from 'vitest';
import { browserStreamSize } from '../../src/browser/browser-capture-config.js';

it.each([
  [{ width: 800, height: 450 }, 1, { width: 800, height: 450 }],
  [{ width: 800, height: 450 }, 1.5, { width: 1200, height: 674 }],
  [{ width: 800, height: 450 }, 2, { width: 1600, height: 900 }],
  [{ width: 1920, height: 1080 }, 2, { width: 1920, height: 1080 }],
  [{ width: 1920, height: 1080 }, 1.5, { width: 1600, height: 900 }],
  [{ width: 1920, height: 1080 }, 0.65, { width: 864, height: 486 }],
  [{ width: 900, height: 1600 }, 1, { width: 720, height: 1280 }],
  [{ width: 800, height: 1200 }, 2, { width: 1080, height: 1620 }]
] as const)('fits the capture raster for %o at %d', (css, density, raster) => {
  expect(browserStreamSize(css, density)).toEqual(raster);
});
