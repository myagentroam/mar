#!/usr/bin/env node

import { main } from '../src/cli.mjs';

const exitCode = await main(['nodes', ...process.argv.slice(2)], { program: 'marnodes' });
if (exitCode !== 0) process.exitCode = exitCode;
