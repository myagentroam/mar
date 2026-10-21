import { up as v001 } from './v001.js';
import { up as v002 } from './v002.js';
import { up as v003 } from './v003.js';
import { up as v004 } from './v004.js';
import { up as v005 } from './v005.js';
import { up as v006 } from './v006.js';
import { up as v007 } from './v007.js';
import { up as v008 } from './v008.js';
import { up as v009 } from './v009.js';
import { up as v010 } from './v010.js';
import { up as v011 } from './v011.js';
import { up as v012 } from './v012.js';
import { up as v013 } from './v013.js';
import { up as v014 } from './v014.js';
import { up as v015 } from './v015.js';
import { up as v016 } from './v016.js';
import { up as v017 } from './v017.js';
import { up as v018 } from './v018.js';

export const SERVER_MIGRATIONS = [
  { version: 1, up: v001 },
  { version: 2, up: v002 },
  { version: 3, up: v003 },
  { version: 4, up: v004 },
  { version: 5, up: v005 },
  { version: 6, up: v006 },
  { version: 7, up: v007 },
  { version: 8, up: v008 },
  { version: 9, up: v009 },
  { version: 10, up: v010 },
  { version: 11, up: v011 },
  { version: 12, up: v012 },
  { version: 13, up: v013 },
  { version: 14, up: v014 },
  { version: 15, up: v015 },
  { version: 16, up: v016 },
  { version: 17, up: v017 },
  { version: 18, up: v018 }
] as const;
