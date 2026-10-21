import { posix } from 'node:path';

const CELL_TOOLS = new Set(['code_exec', 'code_exec_wait']);

/** Keep call identities and evidence, never command, error, observation or provider bodies. */
export function createSessionToolAnalysis({ exampleLimit = 100 } = {}) {
  const calls = new Map();
  const cells = new Map();
  const handles = new Map();
  const processes = new Map();
  const partials = new Map();
  const attempts = [];
  const pendingAttempts = new Map();
  let compactBoundary = 0;
  let lastSelectedSequence = 0;
  const examples = (values) => (exampleLimit > 0 ? values.slice(-exampleLimit) : []);

  const call = (id, name) => {
    if (typeof id !== 'string') return undefined;
    if (!calls.has(id)) calls.set(id, { callId: id, toolName: name });
    const value = calls.get(id);
    value.toolName ??= name;
    return value;
  };
  const cell = (id) => {
    if (!cells.has(id)) cells.set(id, { callId: id, observations: new Map(), selected: false });
    return cells.get(id);
  };

  function observe(record, selected) {
    const p = object(record.payload);
    if (selected) lastSelectedSequence = record.sequence;
    if (record.type === 'compact.completed')
      compactBoundary = p.boundarySequence ?? record.sequence;
    const attemptKey = JSON.stringify([record.executionId, p.purpose]);
    // A continuation reset intentionally replays the same request with attempt 1.
    if (
      record.type === 'model.attempt' &&
      p.state === 'STARTED' &&
      p.attempt === 1 &&
      pendingAttempts.get(attemptKey)?.at(-1)?.code !== 'MAR_AGENT_RESPONSES_CONTINUATION_RESET'
    )
      pendingAttempts.delete(attemptKey);
    if (record.type === 'model.attempt' && p.state === 'FAILED') {
      const attempt = {
        sequence: record.sequence,
        executionId: record.executionId,
        purpose: p.purpose,
        code: p.errorCode,
        selected,
        cancelled: p.errorCode === 'MAR_AGENT_CANCELLED'
      };
      attempts.push(attempt);
      if (!attempt.cancelled) {
        if (!pendingAttempts.has(attemptKey)) pendingAttempts.set(attemptKey, []);
        pendingAttempts.get(attemptKey).push(attempt);
      }
    }
    if (record.type === 'model.attempt' && p.state === 'SUCCEEDED') {
      for (const attempt of pendingAttempts.get(attemptKey) ?? [])
        attempt.recoveredSequence = record.sequence;
      pendingAttempts.delete(attemptKey);
    }
    if (
      record.type === 'tool.started' ||
      record.type === 'tool.completed' ||
      record.type === 'tool.failed'
    ) {
      const c = call(p.callId, p.toolName);
      if (!c) return;
      c.parentCallId ??= p.parentCallId;
      if (record.type === 'tool.started') {
        c.startSequence ??= record.sequence;
        c.startSelected ||= selected;
        if (p.toolName === 'read')
          c.readPaths = array(object(p.input).reads).flatMap((read) =>
            typeof read?.path === 'string' ? [pathKey(read.path)] : []
          );
      } else {
        c.terminal ??= {
          sequence: record.sequence,
          status: record.type === 'tool.failed' ? 'failed' : 'completed',
          code: p.code,
          selected
        };
        if (p.toolName === 'read')
          c.readErrors = new Set(
            array(object(p.data).results)
              .filter((item) => item?.error)
              .map((item) => pathKey(item.path))
          );
        if (
          record.type === 'tool.completed' &&
          (p.toolName === 'exec' || p.toolName === 'exec_wait')
        ) {
          const data = object(p.data);
          if (typeof data.processId === 'string' && Number.isInteger(data.exitCode) && selected) {
            processes.set(data.processId, {
              sequence: record.sequence,
              processId: data.processId,
              exitCode: data.exitCode
            });
          }
        }
      }
      if (p.parentCallId) cell(p.parentCallId).selected ||= selected;
      if (CELL_TOOLS.has(p.toolName)) {
        const data = object(p.data);
        const id =
          p.toolName === 'code_exec'
            ? p.callId
            : handles.get(data.cellId ?? object(p.input).cellId);
        if (id) {
          c.cellCallId = id;
          cell(id).selected ||= selected;
          if (typeof data.cellId === 'string') handles.set(data.cellId, id);
        }
      }
      if (
        record.type === 'tool.failed' &&
        p.toolName === 'apply_patch' &&
        p.code === 'MAR_AGENT_PATCH_PARTIAL'
      ) {
        const data = object(p.data),
          files = Array.isArray(data.files) ? data.files : [];
        const paths = files
          .filter(
            (file) =>
              ['modified', 'deleted', 'moved'].includes(file?.operation) &&
              typeof file.path === 'string'
          )
          .map((file) => pathKey(file.path));
        partials.set(p.callId, {
          sequence: record.sequence,
          callId: p.callId,
          parentCallId: p.parentCallId,
          selected,
          appliedFileCount: files.length,
          pendingFileCount: Array.isArray(data.pendingFiles) ? data.pendingFiles.length : undefined,
          priorStructuredReadCount: [...calls.values()].filter(
            (read) =>
              read.toolName === 'read' &&
              read.startSequence > compactBoundary &&
              read.terminal?.status === 'completed' &&
              paths.some((path) => read.readPaths?.includes(path) && !read.readErrors?.has(path))
          ).length
        });
      }
    }
    if (record.type === 'model.context' && p.role === 'tool' && Array.isArray(p.observations)) {
      const outer = calls.get(p.callId);
      const id = outer?.cellCallId;
      if (!id) return;
      const current = cell(id);
      current.selected ||= selected;
      for (const entry of Array.isArray(p.calls) ? p.calls : []) {
        const nested = call(entry?.callId, entry?.toolName);
        if (!nested) continue;
        nested.parentCallId ??= id;
        nested.ledgerSequence ??= record.sequence;
        (nested.ledger ??= []).push({ sequence: record.sequence, status: entry.status });
      }
      for (const observation of p.observations) {
        if (
          observation?.type === 'tool_result' &&
          observation.outcome !== 'failed' &&
          observation.outcome !== 'cancelled'
        ) {
          const observed = call(observation.source?.callId, observation.source?.toolName);
          if (observed) observed.firstObservationSequence ??= record.sequence;
        }
        if (
          !selected ||
          !['tool_result', 'value'].includes(observation?.type) ||
          typeof observation.id !== 'string'
        )
          continue;
        current.observations.set(observation.id, {
          type: observation.type,
          format: observation.format,
          callId: observation.source?.callId
        });
      }
    }
  }

  function gcEvidence(payload) {
    const replacements = Array.isArray(payload.replacements) ? payload.replacements : [];
    const protectedIds = new Set(
      [...partials.values()].flatMap((p) =>
        calls.get(p.parentCallId)?.terminal?.status === 'failed'
          ? [p.callId, p.parentCallId]
          : [p.callId]
      )
    );
    return {
      replacementKinds: counts(replacements.map((replacement) => replacement?.kind)),
      partialPatchReadItemCount: replacements
        .flatMap((replacement) => (Array.isArray(replacement?.items) ? replacement.items : []))
        .filter((item) => partials.has(item?.supersededByCallId)).length,
      partialPatchInputTargetCount: replacements.filter(
        (replacement) =>
          replacement?.kind === 'TOOL_CALL_INPUT' && protectedIds.has(replacement.target?.callId)
      ).length
    };
  }

  function finish() {
    const visibleCalls = [...calls.values()].filter(
      (c) =>
        (c.startSequence ?? c.ledgerSequence ?? c.terminal?.sequence ?? Infinity) <=
        lastSelectedSequence
    );
    const selectedCells = [...cells.values()].filter(
      (c) => c.selected && calls.get(c.callId)?.toolName === 'code_exec'
    );
    const observations = selectedCells.flatMap((c) => [...c.observations.values()]);
    const selectedCellIds = new Set(selectedCells.map((c) => c.callId));
    const nested = visibleCalls.filter((c) => selectedCellIds.has(c.parentCallId));
    const terminal = (c) => (c.terminal?.sequence <= lastSelectedSequence ? c.terminal : undefined);
    const status = (c) =>
      terminal(c)?.status ??
      c.ledger?.findLast((entry) => entry.sequence <= lastSelectedSequence)?.status;
    const sizes = selectedCells.map(
      (c) => nested.filter((n) => n.parentCallId === c.callId).length
    );
    const concurrent = selectedCells.filter((c) => {
      let end = -Infinity;
      for (const n of nested
        .filter((n) => n.parentCallId === c.callId)
        .sort((a, b) => (a.startSequence ?? Infinity) - (b.startSequence ?? Infinity))) {
        if (n.startSequence === undefined || !terminal(n)) continue;
        if (n.startSequence < end) return true;
        end = Math.max(end, terminal(n).sequence);
      }
      return false;
    });
    const failed = visibleCalls.filter(
      (c) => terminal(c)?.selected && terminal(c).status === 'failed'
    );
    const correlated = failed.filter(
      (c) =>
        CELL_TOOLS.has(c.toolName) &&
        c.cellCallId !== undefined &&
        failed.some(
          (n) =>
            n !== c &&
            n.parentCallId === c.cellCallId &&
            terminal(n).code !== undefined &&
            terminal(n).code === terminal(c).code
        )
    );
    const modelAttempts = attempts.filter((a) => a.selected);
    const nonzero = [...processes.values()].filter((p) => p.exitCode !== 0);
    return {
      codeMode: {
        cellCount: selectedCells.length,
        nestedCallCount: nested.length,
        callsPerCell: counts(sizes),
        singleToolCellCount: sizes.filter((size) => size === 1).length,
        multiToolCellCount: sizes.filter((size) => size > 1).length,
        concurrentCellCount: concurrent.length,
        waitCallCount: visibleCalls.filter(
          (c) => c.toolName === 'code_exec_wait' && (c.startSelected || terminal(c)?.selected)
        ).length,
        incompleteNestedIntervalCount: nested.filter(
          (c) => c.startSequence !== undefined && !terminal(c)
        ).length,
        nestedCallStatus: counts(nested.map(status)),
        observations: counts(observations.map((o) => o.type)),
        valueFormats: counts(observations.filter((o) => o.type === 'value').map((o) => o.format)),
        unobservedCompletedCallCount: nested.filter(
          (c) => status(c) === 'completed' && !(c.firstObservationSequence <= lastSelectedSequence)
        ).length
      },
      tools: {
        startedByName: counts(visibleCalls.filter((c) => c.startSelected).map((c) => c.toolName)),
        completedByName: counts(
          visibleCalls
            .filter((c) => terminal(c)?.selected && terminal(c).status === 'completed')
            .map((c) => c.toolName)
        )
      },
      failures: {
        failedToolCallCount: failed.length,
        correlatedCellFailureCount: correlated.length,
        distinctToolFailureCount: failed.length - correlated.length,
        toolFailures: examples(failed).map((c) => ({
          sequence: terminal(c).sequence,
          callId: c.callId,
          toolName: c.toolName,
          parentCallId: c.parentCallId,
          code: terminal(c).code
        })),
        nonzeroProcessCount: nonzero.length,
        nonzeroProcesses: examples(nonzero),
        modelAttemptFailureCount: modelAttempts.length,
        cancelledModelAttemptCount: modelAttempts.filter((a) => a.cancelled).length,
        recoveredModelAttemptCount: modelAttempts.filter(
          (a) => a.recoveredSequence <= lastSelectedSequence
        ).length,
        modelAttempts: examples(modelAttempts).map(
          ({ selected, recoveredSequence, ...attempt }) => ({
            ...attempt,
            recovered: recoveredSequence <= lastSelectedSequence
          })
        ),
        partialPatchCount: [...partials.values()].filter((p) => p.selected).length,
        partialPatches: examples([...partials.values()].filter((p) => p.selected)).map(
          ({ selected, ...partial }) => partial
        )
      }
    };
  }
  return { observe, gcEvidence, finish };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function pathKey(path) {
  return typeof path === 'string' ? posix.normalize(path.replaceAll('\\', '/')) : undefined;
}
function counts(values) {
  const result = Object.create(null);
  for (const value of values) if (value !== undefined) result[value] = (result[value] ?? 0) + 1;
  return result;
}
