import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createSessionToolAnalysis } from './session-tool-analysis.mjs';

const EVENT_FILE_PATTERN = /^events-(\d+)\.jsonl$/u;
const EXECUTION_TERMINALS = new Set([
  'execution.completed',
  'execution.failed',
  'execution.cancelled'
]);
const TIMELINE_TYPES = new Set([
  'execution.started',
  ...EXECUTION_TERMINALS,
  'compact.completed',
  'context.compacted',
  'context.gc.completed',
  'responses.continuation',
  'subagent.started',
  'subagent.completed',
  'subagent.failed',
  'subagent.cancelled'
]);

export async function analyzeSessionDirectory(
  sessionDirectory,
  {
    sinceSequence = 0,
    executionId,
    timelineLimit = 100,
    validateCheckpoints = false,
    checkpointValidator
  } = {}
) {
  const checkpointValidationSource = checkpointValidator
    ? 'provided-validator'
    : validateCheckpoints
      ? 'built-sdk'
      : 'not_requested';
  if (validateCheckpoints && !checkpointValidator) {
    const module = await import('../../dist/agent-core/session/context-gc-checkpoint.js').catch(
      () => {
        throw new Error(
          'SDK checkpoint validator is unavailable; build @myagentroam/agent before --validate-checkpoints.'
        );
      }
    );
    checkpointValidator = module.validateContextGcCheckpoint;
    if (typeof checkpointValidator !== 'function')
      throw new Error(
        'SDK checkpoint validator export is unavailable; rebuild @myagentroam/agent.'
      );
  }
  const checkpointRecords = checkpointValidator ? [] : undefined;
  const toolAnalysis = createSessionToolAnalysis({ exampleLimit: timelineLimit });
  const executions = new Map();
  const recordIds = new Set();
  const duplicateRecordIds = new Set();
  const timeline = [];
  const gc = [];
  const compacts = [];
  const usageCollector = createUsageCollector();
  const diagnostics = {
    malformedLines: [],
    duplicateRecordIds: [],
    nonIncreasingSequences: []
  };
  const usage = emptyUsage();
  const subagents = {
    started: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    messages: 0,
    waits: 0,
    waitCompletions: 0,
    waitTimeouts: 0
  };
  let recordCount = 0;
  let firstSequence;
  let lastSequence;
  let firstTimestamp;
  let lastTimestamp;
  let previousSequence;

  for await (const item of readSessionRecords(sessionDirectory)) {
    if (item.error) {
      diagnostics.malformedLines.push({
        file: item.file,
        line: item.line,
        message: 'Invalid JSON record'
      });
      continue;
    }
    const record = item.record;
    if (!isRecord(record) || !Number.isInteger(record.sequence)) continue;
    const payload = isRecord(record.payload) ? record.payload : {};
    const selected =
      record.sequence >= sinceSequence && (!executionId || record.executionId === executionId);
    checkpointRecords?.push(record);
    toolAnalysis.observe(record, selected);
    // Retain response boundaries before a range filter without counting excluded snapshots.
    usageCollector.observe(record, payload, selected);
    if (!selected) continue;

    recordCount += 1;
    firstSequence ??= record.sequence;
    firstTimestamp ??= record.timestamp;
    lastSequence = record.sequence;
    lastTimestamp = record.timestamp;
    if (previousSequence !== undefined && record.sequence <= previousSequence) {
      diagnostics.nonIncreasingSequences.push({
        previous: previousSequence,
        current: record.sequence
      });
    }
    previousSequence = record.sequence;

    if (typeof record.recordId === 'string') {
      if (recordIds.has(record.recordId)) duplicateRecordIds.add(record.recordId);
      recordIds.add(record.recordId);
    }

    const execution = record.executionId
      ? getExecution(executions, record.executionId, record)
      : undefined;
    if (execution) {
      execution.lastSequence = record.sequence;
      execution.lastTimestamp = record.timestamp;
    }

    if (record.type === 'model.attempt' && execution) {
      execution.attemptCount += payload.state === 'STARTED' ? 1 : 0;
      if (payload.state === 'STARTED' && execution.firstContinuation === undefined) {
        execution.firstContinuation = Boolean(payload.continuation);
        execution.firstCredentialReason = stringValue(payload.credentialReason);
        execution.protocol = stringValue(payload.protocol);
        execution.transport = stringValue(payload.transport);
      }
      if (payload.state === 'SUCCEEDED') {
        execution.successfulAttemptCount += 1;
        execution.lastContinuation = Boolean(payload.continuation);
        execution.lastConnectionReused = Boolean(payload.connectionReused);
      } else if (payload.state === 'FAILED') {
        execution.failedAttemptCount += 1;
      }
    } else if (record.type === 'responses.continuation' && execution) {
      execution.continuationCheckpointCount += 1;
      const checkpoint = isRecord(payload.checkpoint) ? payload.checkpoint : {};
      execution.lastCheckpointSequence = record.sequence;
      execution.lastCheckpointPrefixLength = numberValue(checkpoint.inputPrefixLength);
    } else if (EXECUTION_TERMINALS.has(record.type) && execution) {
      execution.terminal = record.type;
    } else if (record.type === 'context.gc.completed') {
      const metrics = isRecord(payload.metrics) ? payload.metrics : {};
      const trigger = isRecord(payload.trigger) ? payload.trigger : {};
      gc.push({
        type: record.type,
        sequence: record.sequence,
        timestamp: record.timestamp,
        base: isRecord(payload.base) ? payload.base.type : undefined,
        generation: numberValue(payload.generation),
        stage: stringValue(metrics.stage),
        contextInputTokens: numberValue(trigger.contextInputTokens),
        beforeTokens: numberValue(metrics.beforeTokens),
        afterTokens: numberValue(metrics.afterTokens),
        reclaimedTokens: numberValue(metrics.reclaimedTokens),
        grossReductionRate: numberValue(metrics.grossReductionRate),
        projectedRolloutsUntilCompactAfterGc: numberValue(
          metrics.projectedRolloutsUntilCompactAfterGc
        ),
        replacementCount: Array.isArray(payload.replacements) ? payload.replacements.length : 0,
        validation: checkpointValidator
          ? (await checkpointValidator(checkpointRecords, record))
            ? 'valid'
            : 'invalid'
          : 'not_requested',
        evidence: toolAnalysis.gcEvidence(payload)
      });
    } else if (record.type === 'compact.completed') {
      compacts.push({
        type: record.type,
        sequence: record.sequence,
        timestamp: record.timestamp,
        executionId: record.executionId,
        automatic: Boolean(payload.automatic),
        boundarySequence: numberValue(payload.boundarySequence),
        summaryLength: typeof payload.summary === 'string' ? [...payload.summary].length : undefined
      });
    }

    if (record.type === 'subagent.started') subagents.started += 1;
    if (record.type === 'subagent.completed') subagents.completed += 1;
    if (record.type === 'subagent.failed') subagents.failed += 1;
    if (record.type === 'subagent.cancelled') subagents.cancelled += 1;
    if (record.type === 'tool.started' && payload.toolName === 'agent_message')
      subagents.messages += 1;
    if (record.type === 'tool.started' && payload.toolName === 'agent_wait') subagents.waits += 1;
    if (record.type === 'tool.completed' && payload.toolName === 'agent_wait') {
      subagents.waitCompletions += 1;
      const result = parseToolResult(payload.data);
      if (result?.waitOutcome === 'timeout') subagents.waitTimeouts += 1;
    }

    const timelineEntry = timelineEntryFor(record, payload);
    if (timelineEntry) {
      timeline.push(timelineEntry);
      if (timeline.length > timelineLimit) timeline.shift();
    }
  }

  const usageSamples = usageCollector.finish();
  for (const sample of usageSamples) {
    addUsage(usage, sample);
    const execution = executions.get(sample.executionId);
    if (execution) {
      addUsage(execution.usage, sample);
      if (!sample.externalCompact) execution.firstUsage ??= finalizeUsage(usageFromPayload(sample));
    }
  }
  diagnostics.duplicateRecordIds = [...duplicateRecordIds].sort();
  const structuralEvents = [...gc, ...compacts];
  annotateFollowingUsage(gc, structuralEvents, usageSamples);
  annotateFollowingUsage(compacts, structuralEvents, usageSamples);
  const executionList = [...executions.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map(finalizeExecution);
  const continuationTransitions = [];
  for (let index = 1; index < executionList.length; index += 1) {
    const previous = executionList[index - 1];
    const current = executionList[index];
    const mutationBoundary = previous.lastCheckpointSequence ?? previous.firstSequence;
    const mutations = structuralEvents
      .filter(
        (event) => event.sequence > mutationBoundary && event.sequence < current.firstSequence
      )
      .map((event) => ({ sequence: event.sequence, type: event.type }));
    continuationTransitions.push({
      previousExecutionId: previous.executionId,
      executionId: current.executionId,
      previousTerminal: previous.terminal,
      previousCheckpointCount: previous.continuationCheckpointCount,
      firstContinuation: current.firstContinuation,
      firstCacheHitRate: current.firstUsage?.cacheHitRate,
      mutations
    });
  }

  return {
    sessionDirectory,
    range: {
      recordCount,
      firstSequence,
      lastSequence,
      firstTimestamp,
      lastTimestamp
    },
    usage: finalizeUsage(usage),
    executions: executionList,
    continuationTransitions,
    gc,
    compacts,
    checkpointValidationSource,
    subagents,
    ...toolAnalysis.finish(),
    timeline,
    diagnostics
  };
}

export function formatSessionAnalysis(report, { lastExecutions = 10 } = {}) {
  const lines = [];
  lines.push(`Session directory: ${report.sessionDirectory}`);
  lines.push(
    `Records: ${formatInteger(report.range.recordCount)} | sequence ${report.range.firstSequence ?? '-'}..${report.range.lastSequence ?? '-'}`
  );
  lines.push(
    `Usage: ${formatInteger(report.usage.requestCount)} requests | input ${formatInteger(report.usage.inputTokens)} | output ${formatInteger(report.usage.outputTokens)} | total ${formatInteger(report.usage.totalTokens)}`
  );
  lines.push(
    `Cache: ${formatInteger(report.usage.cacheReadTokens)} read | ${formatPercent(report.usage.cacheHitRate)} hit | ${formatInteger(report.usage.uncachedInputTokens)} uncached input`
  );
  if (report.usage.externalCompactUsage?.requestCount) {
    const external = report.usage.externalCompactUsage;
    lines.push(
      `External Compact: ${formatInteger(external.requestCount)} requests | input ${formatInteger(external.contextInputTokens)} | output ${formatInteger(external.outputTokens)} | cache read ${formatInteger(external.cacheReadTokens)} | cache write ${formatInteger(external.cacheWriteTokens)}`,
      `Execution cache: ${formatPercent(report.usage.cacheHitRate)} | overall cache: ${formatPercent(report.usage.overallCacheHitRate)}`
    );
  }
  lines.push(
    `Lifecycle: ${formatInteger(report.executions.length)} executions | ${formatInteger(report.compacts.length)} compacts | ${formatInteger(report.gc.length)} GC checkpoints`
  );
  lines.push(
    `Subagent events: ${report.subagents.started} started | ${report.subagents.completed} completed | ${report.subagents.failed} failed | ${report.subagents.cancelled} cancelled | ${report.subagents.waitTimeouts}/${report.subagents.waitCompletions} wait timeouts`
  );
  lines.push(
    `Code Mode: ${report.codeMode.cellCount} cells | ${report.codeMode.nestedCallCount} nested calls | ${report.codeMode.multiToolCellCount} multi-tool | ${report.codeMode.concurrentCellCount} concurrent | ${report.codeMode.waitCallCount} waits`
  );
  lines.push(
    `Observations: ${report.codeMode.observations.tool_result ?? 0} tool results | ${report.codeMode.observations.value ?? 0} values | ${report.codeMode.unobservedCompletedCallCount} unobserved completed calls`
  );
  lines.push(
    `Failures: ${report.failures.distinctToolFailureCount} distinct tool failures (${report.failures.correlatedCellFailureCount} correlated cell failures) | ${report.failures.nonzeroProcessCount} nonzero processes | ${report.failures.modelAttemptFailureCount} failed model attempts (${report.failures.cancelledModelAttemptCount} cancelled, ${report.failures.recoveredModelAttemptCount} subsequently succeeded)`
  );

  if (report.gc.length > 0) {
    const reclaimed = report.gc.reduce((sum, item) => sum + (item.reclaimedTokens ?? 0), 0);
    lines.push(`GC reclaimed estimate: ${formatInteger(reclaimed)} tokens`);

    lines.push('');
    lines.push('Recent GC checkpoints:');
    for (const checkpoint of report.gc.slice(-3)) {
      lines.push(
        [
          `seq=${checkpoint.sequence}`,
          checkpoint.stage ?? 'stage=-',
          `reclaimed=${formatInteger(checkpoint.reclaimedTokens)}`,
          `gross=${formatPercent(checkpoint.grossReductionRate)}`,
          `following=${checkpoint.followingUsageCount}`,
          `first-cache=${formatPercent(checkpoint.firstFollowingUsage?.cacheHitRate)}`,
          `adjacent-input-drop=${formatPercent(checkpoint.adjacentInputReductionRate)}`,
          `second-cache=${formatPercent(checkpoint.secondFollowingUsage?.cacheHitRate)}`,
          `validation=${checkpoint.validation}`,
          `partial-read-items=${checkpoint.evidence.partialPatchReadItemCount}`,
          `partial-input-targets=${checkpoint.evidence.partialPatchInputTargetCount}`
        ].join(' | ')
      );
    }
  }

  const recentTransitions = report.continuationTransitions.slice(-3);
  if (recentTransitions.length > 0) {
    lines.push('');
    lines.push('Recent cross-Execution transitions:');
    for (const transition of recentTransitions) {
      lines.push(
        [
          `${transition.previousExecutionId} -> ${transition.executionId}`,
          `checkpoint=${transition.previousCheckpointCount}`,
          `mutations=${transition.mutations.map((item) => item.type).join(',') || 'none'}`,
          `first-cont=${displayBoolean(transition.firstContinuation)}`,
          `first-cache=${formatPercent(transition.firstCacheHitRate)}`
        ].join(' | ')
      );
    }
  }

  const recent =
    lastExecutions === 0 ? report.executions : report.executions.slice(-lastExecutions);
  if (recent.length > 0) {
    lines.push('');
    lines.push('Recent executions:');
    for (const execution of recent) {
      lines.push(
        [
          execution.executionId,
          `${execution.requestCount} req`,
          `${formatInteger(execution.usage.totalTokens)} tokens`,
          `${formatPercent(execution.usage.cacheHitRate)} cache`,
          `first-cont=${displayBoolean(execution.firstContinuation)}`,
          execution.terminal ?? 'running'
        ].join(' | ')
      );
    }
  }

  const issues =
    report.diagnostics.malformedLines.length +
    report.diagnostics.duplicateRecordIds.length +
    report.diagnostics.nonIncreasingSequences.length;
  lines.push('');
  lines.push(
    `Diagnostics: ${issues} issue(s) | malformed=${report.diagnostics.malformedLines.length} duplicate-record-id=${report.diagnostics.duplicateRecordIds.length} non-increasing-sequence=${report.diagnostics.nonIncreasingSequences.length}`
  );
  return `${lines.join('\n')}\n`;
}

async function* readSessionRecords(sessionDirectory) {
  const fileNames = (await readdir(sessionDirectory))
    .filter((fileName) => EVENT_FILE_PATTERN.test(fileName))
    .sort(
      (left, right) =>
        Number(EVENT_FILE_PATTERN.exec(left)?.[1]) - Number(EVENT_FILE_PATTERN.exec(right)?.[1])
    );
  for (const file of fileNames) {
    const input = createReadStream(join(sessionDirectory, file), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length === 0) continue;
      try {
        yield { file, line: lineNumber, record: JSON.parse(line) };
      } catch (error) {
        yield {
          file,
          line: lineNumber,
          error: error instanceof Error ? error : new Error(String(error))
        };
      }
    }
  }
}

function getExecution(executions, executionId, record) {
  let execution = executions.get(executionId);
  if (!execution) {
    execution = {
      executionId,
      firstSequence: record.sequence,
      lastSequence: record.sequence,
      firstTimestamp: record.timestamp,
      lastTimestamp: record.timestamp,
      terminal: undefined,
      requestCount: 0,
      attemptCount: 0,
      successfulAttemptCount: 0,
      failedAttemptCount: 0,
      firstContinuation: undefined,
      firstCredentialReason: undefined,
      lastContinuation: undefined,
      lastConnectionReused: undefined,
      protocol: undefined,
      transport: undefined,
      continuationCheckpointCount: 0,
      lastCheckpointSequence: undefined,
      lastCheckpointPrefixLength: undefined,
      usage: emptyUsage(),
      firstUsage: undefined
    };
    executions.set(executionId, execution);
  }
  return execution;
}

function finalizeExecution(execution) {
  const usage = finalizeUsage(execution.usage);
  return {
    ...execution,
    requestCount: usage.requestCount,
    usage,
    firstUsage: execution.firstUsage
  };
}

function emptyUsage() {
  return {
    requestCount: 0,
    inputTokens: 0,
    contextInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  };
}

function usageFromPayload(payload) {
  const usage = emptyUsage();
  addUsage(usage, payload);
  return usage;
}

// These body-free helpers are also serialized by the UAT remote collector.
export function createExternalCompactUsageClassifier() {
  const scopes = new Map();
  return (record) => {
    const payload = record.payload ?? {};
    const key = record.executionId ?? payload.executionId;
    if (record.type === 'context.compacting') {
      scopes.set(key, { id: payload.compactionId });
    } else if (record.type === 'compact.progress' && typeof payload.compactionId === 'string') {
      let scope = scopes.get(key);
      if (scope?.id !== payload.compactionId) {
        scope = { id: payload.compactionId };
        scopes.set(key, scope);
      }
      if (payload.extensionOutcome === 'HANDLED') {
        scope.external = {
          modelId: payload.extension?.modelId ?? 'external-compact:unknown',
          modelName:
            payload.extension?.providerModelId ?? payload.extension?.modelId ?? 'External Compact'
        };
      } else if (payload.extensionOutcome !== undefined) {
        delete scope.external;
      }
    } else if (
      record.type === 'compact.completed' ||
      record.type === 'context.compacted' ||
      record.type === 'execution.started' ||
      record.type === 'execution.completed' ||
      record.type === 'execution.failed' ||
      record.type === 'execution.cancelled'
    ) {
      scopes.delete(key);
    } else if (record.type === 'usage.updated') {
      const scope = scopes.get(key);
      if (scope?.external && !scope.consumed) {
        if (Number.isFinite(payload.outputTokens)) scope.consumed = true;
        return scope.external;
      }
    }
    return undefined;
  };
}

export function addExternalCompactUsage(target, usage) {
  if (!usage?.requestCount) return;
  target.externalCompactUsage ??= {};
  for (const field of [
    'requestCount',
    'inputTokens',
    'contextInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ])
    target.externalCompactUsage[field] =
      (target.externalCompactUsage[field] ?? 0) + (usage[field] ?? 0);
}

export function finalizeUsageAccounting(usage) {
  const ratio = (value) =>
    value.contextInputTokens > 0 ? value.cacheReadTokens / value.contextInputTokens : undefined;
  const external = usage.externalCompactUsage;
  if (!external?.requestCount) return { ...usage, cacheHitRate: ratio(usage) };
  const execution = {};
  const fields = [
    'requestCount',
    'inputTokens',
    'contextInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens'
  ];
  const compact = {};
  for (const field of fields) {
    compact[field] = external[field] ?? 0;
    execution[field] = (usage[field] ?? 0) - compact[field];
  }
  return {
    ...usage,
    overallCacheHitRate: ratio(usage),
    cacheHitRate: ratio(execution),
    executionUsage: { ...execution, cacheHitRate: ratio(execution) },
    externalCompactUsage: { ...compact, cacheHitRate: ratio(compact) }
  };
}

function createUsageCollector() {
  const classify = createExternalCompactUsageClassifier();
  const pending = new Map();
  const samples = [];
  const fields = [
    'inputTokens',
    'contextInputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'outputTokens'
  ];
  const flush = (key) => {
    const sample = pending.get(key);
    if (sample?.sequence !== undefined) samples.push(sample);
    pending.delete(key);
  };
  return {
    observe(record, payload, selected) {
      const externalCompact = classify(record);
      const key = record.executionId;
      if (record.type === 'usage.updated') {
        const previous = pending.get(key);
        const complete = numberValue(payload.outputTokens) !== undefined;
        // Input-only message_start and its final usage are snapshots, not two requests.
        // Final usage can correct the initial input totals. Request boundaries, not equal
        // token counts, distinguish requests; a new input-only snapshot ends a partial.
        const continuation = previous && complete;
        if (!continuation) flush(key);
        const sample = continuation ? previous : { executionId: key };
        if (externalCompact) sample.externalCompact = externalCompact;
        if (selected) sample.sequence ??= record.sequence;
        for (const field of fields) {
          const value = numberValue(payload[field]);
          if (value !== undefined) sample[field] = value;
        }
        pending.set(key, sample);
        if (complete) flush(key);
      } else if (record.type === 'context.gc.completed' || record.type === 'compact.completed') {
        for (const key of pending.keys()) flush(key);
      } else if (
        record.type === 'execution.started' ||
        EXECUTION_TERMINALS.has(record.type) ||
        record.type === 'model.attempt' ||
        (record.type === 'tool.started' && stringValue(payload.parentCallId) === undefined) ||
        record.type === 'responses.continuation'
      ) {
        flush(key);
      }
    },
    finish() {
      for (const key of pending.keys()) flush(key);
      return samples.sort((left, right) => left.sequence - right.sequence);
    }
  };
}

function addUsage(target, payload) {
  target.requestCount += 1;
  target.inputTokens += numberValue(payload.inputTokens) ?? 0;
  target.contextInputTokens += numberValue(payload.contextInputTokens) ?? 0;
  target.outputTokens += numberValue(payload.outputTokens) ?? 0;
  target.cacheReadTokens += numberValue(payload.cacheReadTokens) ?? 0;
  target.cacheWriteTokens += numberValue(payload.cacheWriteTokens) ?? 0;
  if (payload.externalCompact) {
    target.externalCompactUsage ??= emptyUsage();
    addUsage(target.externalCompactUsage, { ...payload, externalCompact: undefined });
  }
}

function finalizeUsage(usage) {
  return finalizeUsageAccounting({
    ...usage,
    totalTokens: usage.inputTokens + usage.outputTokens,
    uncachedInputTokens: Math.max(0, usage.contextInputTokens - usage.cacheReadTokens)
  });
}

function annotateFollowingUsage(events, structuralEvents, usageSamples) {
  const orderedStructuralEvents = [...structuralEvents].sort(
    (left, right) => left.sequence - right.sequence
  );
  for (const event of events) {
    const next = orderedStructuralEvents.find((candidate) => candidate.sequence > event.sequence);
    const following = usageSamples.filter(
      (sample) => sample.sequence > event.sequence && (!next || sample.sequence < next.sequence)
    );
    event.followingUsageCount = following.length;
    event.nextStructuralEvent = next ? { sequence: next.sequence, type: next.type } : undefined;
    const previous = usageSamples.findLast((sample) => sample.sequence < event.sequence);
    if (previous) event.beforeUsage = usageSummary(previous);
    for (const [index, field] of [
      [0, 'firstFollowingUsage'],
      [1, 'secondFollowingUsage']
    ]) {
      if (!following[index]) continue;
      event[field] = usageSummary(following[index]);
    }
    if (event.beforeUsage?.contextInputTokens > 0 && event.firstFollowingUsage) {
      // Adjacent requests also include intervening work; this is not isolated GC savings.
      event.adjacentInputReductionRate =
        1 - event.firstFollowingUsage.contextInputTokens / event.beforeUsage.contextInputTokens;
    }
  }
}

function usageSummary(sample) {
  const contextInputTokens = sample.contextInputTokens ?? 0;
  const cacheReadTokens = sample.cacheReadTokens ?? 0;
  return {
    sequence: sample.sequence,
    executionId: sample.executionId,
    contextInputTokens,
    cacheReadTokens,
    cacheHitRate: contextInputTokens > 0 ? cacheReadTokens / contextInputTokens : undefined
  };
}

function timelineEntryFor(record, payload) {
  if (!TIMELINE_TYPES.has(record.type)) return undefined;
  const entry = {
    sequence: record.sequence,
    timestamp: record.timestamp,
    executionId: record.executionId,
    type: record.type
  };
  if (record.type === 'context.gc.completed') {
    const metrics = isRecord(payload.metrics) ? payload.metrics : {};
    entry.reclaimedTokens = numberValue(metrics.reclaimedTokens);
    entry.stage = stringValue(metrics.stage);
  } else if (record.type === 'responses.continuation') {
    const checkpoint = isRecord(payload.checkpoint) ? payload.checkpoint : {};
    entry.inputPrefixLength = numberValue(checkpoint.inputPrefixLength);
  } else if (record.type.startsWith('subagent.')) {
    entry.agentId = stringValue(payload.agentId);
    entry.status = stringValue(payload.status);
  }
  return entry;
}

function parseToolResult(value) {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

function formatInteger(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value ?? 0);
}

function formatPercent(value) {
  return value === undefined ? '-' : `${(value * 100).toFixed(2)}%`;
}

function displayBoolean(value) {
  return value === undefined ? '-' : String(value);
}
