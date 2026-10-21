#!/usr/bin/env node

import { executableArgs, main } from '../src/cli.mjs';

const exitCode = await main(executableArgs(process.argv[1], process.argv.slice(2)));
if (exitCode !== 0) process.exitCode = exitCode;
