#!/usr/bin/env node

import { main } from '../src/cli.mjs';

const exitCode = await main(['ssh', ...process.argv.slice(2)], { program: 'marssh' });
if (exitCode !== 0) process.exitCode = exitCode;
