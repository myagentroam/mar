#!/usr/bin/env node

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeSessionDirectory, formatSessionAnalysis } from './session-analysis.mjs';

const arguments_ = process.argv.slice(2);
if (arguments_[0] === '--') arguments_.shift();

const { values } = parseArgs({
  args: arguments_,
  options: {
    session: { type: 'string' },
    'session-dir': { type: 'string' },
    'source-home': { type: 'string', default: homedir() },
    'since-sequence': { type: 'string', default: '0' },
    execution: { type: 'string' },
    'last-executions': { type: 'string', default: '10' },
    'timeline-limit': { type: 'string', default: '100' },
    json: { type: 'boolean', default: false },
    timeline: { type: 'boolean', default: false },
    'validate-checkpoints': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  },
  strict: true
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const sessionDirectory = resolveSessionDirectory(values);
const report = await analyzeSessionDirectory(sessionDirectory, {
  sinceSequence: nonNegativeInteger(values['since-sequence'], '--since-sequence'),
  executionId: values.execution,
  timelineLimit: positiveInteger(values['timeline-limit'], '--timeline-limit'),
  validateCheckpoints: values['validate-checkpoints']
});

if (values.json) {
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
} else {
  process.stdout.write(
    formatSessionAnalysis(report, {
      lastExecutions: nonNegativeInteger(values['last-executions'], '--last-executions')
    })
  );
  if (values.timeline) {
    process.stdout.write('\nTimeline:\n');
    for (const event of report.timeline) process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}
if (
  values['validate-checkpoints'] &&
  report.gc.some((checkpoint) => checkpoint.validation === 'invalid')
)
  process.exitCode = 1;

function resolveSessionDirectory(options) {
  if (options['session-dir']) return resolve(options['session-dir']);
  if (!options.session) throw new Error('--session or --session-dir is required');
  return join(resolve(options['source-home']), '.mar', 'agent', 'sessions', options.session);
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  pnpm --filter @myagentroam/agent analyze:session -- --session <id> [options]
  pnpm --filter @myagentroam/agent analyze:session -- --session-dir <path> [options]

Options:
  --source-home <path>       HOME containing .mar/agent (default: current HOME)
  --since-sequence <number>  Ignore earlier records
  --execution <id>           Restrict analysis to one Execution
  --last-executions <number> Text report execution limit; 0 prints all
  --timeline                 Print bounded structural timeline
  --timeline-limit <number>  Maximum timeline entries and diagnostic examples (default: 100)
  --json                     Emit machine-readable JSON
  --validate-checkpoints     Validate GC recovery evidence with the built SDK (build first)
  -h, --help                 Show this help

The analyzer streams events-*.jsonl and does not print message bodies, tool payloads,
provider-private items, hashes, or credentials.
Cache hit rate is sum(cacheReadTokens) / sum(contextInputTokens); total tokens are
sum(inputTokens) + sum(outputTokens).
Code Mode concurrency uses overlapping tool execution intervals, not JavaScript source text.
Nonzero process exits and model cancellations are not automatically runtime faults.
Adjacent GC input changes are observations, not isolated savings or a Direct-mode comparison.
Checkpoint validation is opt-in, retains raw records in memory, and uses the locally built SDK;
the build may differ from the source checkout or deployed SDK version.
`);
}
