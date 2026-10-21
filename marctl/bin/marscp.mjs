#!/usr/bin/env node

import { main } from '../src/cli.mjs';

const exitCode = await main(['scp', ...process.argv.slice(2)], { program: 'marscp' });
if (exitCode !== 0) process.exitCode = exitCode;
