/** Canonical relay facts only; no response bodies or permission decisions are retained. */
export interface RelaySessionFact {
  readonly id: string;
  readonly workspaceId: string | undefined;
  readonly complete: boolean;
  readonly title?: string | null | undefined;
  readonly customTitle?: string | null | undefined;
  readonly runnerTitle?: string | null | undefined;
  readonly conversationTitle?: string | null | undefined;
}
export interface RelayRunFact {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string | undefined;
}
interface RelayTerminalFact {
  readonly id: string;
  readonly workspaceId: string | null;
}
export interface RelayResourceFacts {
  readonly sessions: readonly RelaySessionFact[];
  readonly runs: readonly RelayRunFact[];
  readonly terminals: readonly RelayTerminalFact[];
}
export interface RelayResourceRemoval {
  readonly kind: 'session' | 'terminal' | 'workspace';
  readonly id: string;
}
interface NodeScope {
  readonly sessions: Map<string, string>;
  readonly runs: Map<string, { sessionId: string; workspaceId: string }>;
  readonly terminals: Map<string, string | null>;
  readonly observations: Set<ResourceObservation>;
}
export interface ResourceObservation {
  readonly nodeId: string;
  readonly scope: NodeScope;
  readonly excluded: Map<string, RelayResourceRemoval>;
}

const SESSION_TARGETS = new Set([
  'session.get',
  'session.watch',
  'session.unwatch',
  'session.runs',
  'session.message',
  'session.interrupt',
  'session.channel.message',
  'session.channel.token',
  'session.metadata.update',
  'session.config.update',
  'session.pin.move',
  'session.remove',
  'session.rewind',
  'session.rollback',
  'session.command.execute',
  'session.turns.list',
  'session.events.read',
  'session.context.read',
  'session.tool-resource.read',
  'session.schedule.get',
  'session.schedule.save',
  'session.schedule.remove',
  'session.schedule.agent.save',
  'session.schedule.proposal.resolve',
  'session.goal.get',
  'session.graph',
  'session.cli.context'
]);
const RUN_TARGETS = new Set([
  'run.get',
  'run.image.read',
  'run.cancel',
  'run.interrupt',
  'run.user-input.respond',
  'run.approval.decide'
]);
const TERMINAL_TARGETS = new Set([
  'terminal.close',
  'terminal.attach.authorize',
  'terminal.direct.preflight'
]);
const WORKSPACE_INPUTS = new Set([
  ...SESSION_TARGETS,
  ...RUN_TARGETS,
  ...TERMINAL_TARGETS,
  'agent.network',
  'session.create',
  'session.start',
  'session.list',
  'session.discover',
  'session.schedule.list',
  'terminal.open',
  'workspace.register',
  'workspace.remove',
  'workspace.diff',
  'workspace.watch',
  'workspace.unwatch',
  'workspace.sessions.cleanup',
  'workspace.queue.get',
  'workspace.queue.pause',
  'workspace.queue.resume',
  'workspace.queue.reorder',
  'workspace.queue.message.update',
  'workspace.queue.message.delete',
  'workspace.queue.message.execute',
  'workspace.git.settings.get',
  'workspace.git.settings.update',
  'workspace.directories.list',
  'workspace.files.list',
  'workspace.file.read',
  'workspace.file.write',
  'workspace.file.content.read',
  'workspace.file.direct.metadata',
  'workspace.files.search',
  'workspace.files.mutate',
  'workspace.content.search',
  'workspace.symbol.prepare',
  'workspace.symbol.definition',
  'workspace.files.upload.preflight',
  'workspace.files.upload.create',
  'workspace.files.upload.chunk',
  'workspace.files.upload.status',
  'workspace.files.upload.complete',
  'workspace.files.upload.cancel',
  'workspace.changes.current',
  'workspace.change.diff',
  'workspace.change.restore',
  'workspace.git.fetch',
  'workspace.git.refs.list',
  'workspace.git.history.list',
  'workspace.git.commit.files',
  'workspace.git.commit.file.diff',
  'workspace.git.commit.file.content.read',
  'workspace.git.commit.file.direct.metadata',
  'workspace.skills.inspect',
  'workspace.skills.install',
  'workspace.skills.remove',
  'workspace.skills.git-exclude-repair',
  'workspace.mcps.inspect',
  'workspace.mcps.install',
  'workspace.mcps.remove',
  'prompt-completion.context',
  'prompt-completion.generate',
  'conversation.template.source.inspect',
  'conversation.template.publish'
]);
const SESSION_RESULTS = new Set([
  'session.create',
  'session.start',
  'session.get',
  'session.metadata.update',
  'session.config.update',
  'session.rewind',
  'session.rollback',
  'session.message',
  'session.channel.message',
  'session.command.execute',
  'session.schedule.save',
  'session.schedule.remove',
  'session.cli.context'
]);
const RUN_RESULTS = new Set([
  'session.start',
  'session.message',
  'session.channel.message',
  'session.command.execute',
  'session.cli.context',
  'run.get',
  'run.cancel',
  'run.interrupt',
  'session.interrupt'
]);
const TERMINAL_RESULTS = new Set([
  'terminal.open',
  'terminal.command.open',
  'terminal.attach.authorize'
]);

export function observesRelayResources(operation: string): boolean {
  return (
    SESSION_RESULTS.has(operation) ||
    RUN_RESULTS.has(operation) ||
    TERMINAL_RESULTS.has(operation) ||
    ['session.list', 'session.discover', 'session.graph', 'session.runs', 'terminal.list'].includes(
      operation
    )
  );
}

export class NodeResourceScopeIndex {
  private readonly nodes = new Map<string, NodeScope>();

  resolve(
    nodeId: string,
    operation: string,
    data: unknown,
    explicit?: string
  ): {
    workspaceId: string | undefined;
    conflict: boolean;
  } {
    const input = record(data);
    const scope = this.nodes.get(nodeId);
    const requested = WORKSPACE_INPUTS.has(operation) ? text(input?.workspaceId) : undefined;
    let known: string | null | undefined;
    if (SESSION_TARGETS.has(operation)) known = scope?.sessions.get(text(input?.sessionId) ?? '');
    else if (RUN_TARGETS.has(operation)) {
      const runId = text(input?.runId) ?? '';
      known = scope?.runs.get(runId)?.workspaceId;
      // Native transcript image handles address a Session, not a stored Run.
      if (operation === 'run.image.read' && runId.startsWith('native-history:'))
        known = runId.startsWith('native-history:hosted:')
          ? undefined
          : scope?.sessions.get(runId.slice('native-history:'.length));
    } else if (TERMINAL_TARGETS.has(operation))
      known = scope?.terminals.get(text(input?.terminalId) ?? '');
    const hint = explicit ?? requested;
    return {
      workspaceId: hint ?? (known === null ? undefined : known),
      conflict:
        (explicit !== undefined && requested !== undefined && explicit !== requested) ||
        (hint !== undefined && known !== undefined && hint !== known)
    };
  }

  begin(nodeId: string): ResourceObservation {
    let scope = this.nodes.get(nodeId);
    if (scope === undefined) {
      scope = {
        sessions: new Map(),
        runs: new Map(),
        terminals: new Map(),
        observations: new Set()
      };
      this.nodes.set(nodeId, scope);
    }
    const observation = { nodeId, scope, excluded: new Map<string, RelayResourceRemoval>() };
    scope.observations.add(observation);
    return observation;
  }

  observe(observation: ResourceObservation, facts: RelayResourceFacts): RelayResourceFacts {
    const { nodeId, scope, excluded } = observation;
    if (this.nodes.get(nodeId) !== scope || !scope.observations.has(observation))
      return { sessions: [], runs: [], terminals: [] };
    const allowed = (
      kind: 'session' | 'run' | 'terminal',
      id: string,
      workspaceId?: string | null,
      sessionId?: string
    ) => {
      for (const removal of excluded.values()) {
        if (removal.kind === 'workspace' && removal.id === workspaceId) return false;
        if (
          removal.kind === 'session' &&
          ((kind === 'session' && removal.id === id) || removal.id === sessionId)
        )
          return false;
        if (removal.kind === 'terminal' && kind === 'terminal' && removal.id === id) return false;
      }
      return true;
    };
    const filtered = {
      sessions: facts.sessions.filter((s) => allowed('session', s.id, s.workspaceId)),
      runs: facts.runs.filter((r) => allowed('run', r.id, r.workspaceId, r.sessionId)),
      terminals: facts.terminals.filter((t) => allowed('terminal', t.id, t.workspaceId))
    };
    for (const session of filtered.sessions)
      if (session.workspaceId !== undefined) scope.sessions.set(session.id, session.workspaceId);
    for (const run of filtered.runs) {
      if (run.workspaceId === undefined) continue;
      scope.runs.set(run.id, { sessionId: run.sessionId, workspaceId: run.workspaceId });
      scope.sessions.set(run.sessionId, run.workspaceId);
    }
    for (const terminal of filtered.terminals)
      scope.terminals.set(terminal.id, terminal.workspaceId);
    return filtered;
  }

  finish(observation: ResourceObservation): void {
    observation.excluded.clear();
    observation.scope.observations.delete(observation);
    const scope = observation.scope;
    if (
      this.nodes.get(observation.nodeId) === scope &&
      scope.sessions.size === 0 &&
      scope.runs.size === 0 &&
      scope.terminals.size === 0 &&
      scope.observations.size === 0
    )
      this.nodes.delete(observation.nodeId);
  }

  remove(nodeId: string, removal: RelayResourceRemoval): void {
    const scope = this.nodes.get(nodeId);
    if (scope === undefined) return;
    const exclude = (target: RelayResourceRemoval) => {
      for (const observation of scope.observations)
        observation.excluded.set(`${target.kind}:${target.id}`, target);
    };
    exclude(removal);
    if (removal.kind === 'terminal') scope.terminals.delete(removal.id);
    for (const [id, workspaceId] of scope.sessions)
      if (
        (removal.kind === 'session' && id === removal.id) ||
        (removal.kind === 'workspace' && workspaceId === removal.id)
      ) {
        // Compact replies may omit Workspace scope, so retain known member IDs until settlement.
        if (removal.kind === 'workspace') exclude({ kind: 'session', id });
        scope.sessions.delete(id);
      }
    for (const [id, run] of scope.runs)
      if (
        (removal.kind === 'session' && run.sessionId === removal.id) ||
        (removal.kind === 'workspace' && run.workspaceId === removal.id)
      )
        scope.runs.delete(id);
    if (removal.kind === 'workspace')
      for (const [id, workspaceId] of scope.terminals)
        if (workspaceId === removal.id) {
          exclude({ kind: 'terminal', id });
          scope.terminals.delete(id);
        }
    if (
      !scope.sessions.size &&
      !scope.runs.size &&
      !scope.terminals.size &&
      !scope.observations.size
    )
      this.nodes.delete(nodeId);
  }

  removeNode(nodeId: string): void {
    const scope = this.nodes.get(nodeId);
    if (scope !== undefined) {
      for (const observation of scope.observations) observation.excluded.clear();
      scope.observations.clear();
    }
    this.nodes.delete(nodeId);
  }

  clear(): void {
    for (const nodeId of this.nodes.keys()) this.removeNode(nodeId);
  }
}

/** Operation-aware projection: never descend into events, tools, or arbitrary command results. */
export function projectRelayResources(
  operation: string,
  data: unknown,
  result: unknown
): RelayResourceFacts {
  const input = record(data);
  const value = record(result);
  const sessions: RelaySessionFact[] = [];
  const runs: RelayRunFact[] = [];
  const terminals: RelayTerminalFact[] = [];
  if (value === undefined) return { sessions, runs, terminals };
  const session = (
    candidate: unknown,
    view: 'full' | 'marctl' | 'graph' = 'full',
    workspace?: string
  ) => {
    const item = record(candidate);
    const id = text(item?.id);
    if (item === undefined || id === undefined) return;
    const compact = view !== 'full';
    sessions.push({
      id,
      workspaceId: compact ? workspace : text(item.workspaceId),
      complete: !compact,
      ...(compact
        ? { title: nullableText(item.title) }
        : {
            customTitle: nullableText(item.customTitle),
            runnerTitle: nullableText(item.runnerTitle),
            conversationTitle: nullableText(item.conversationTitle)
          })
    });
    const runId = view === 'marctl' ? text(item.runId) : undefined;
    if (runId !== undefined) runs.push({ id: runId, sessionId: id, workspaceId: workspace });
  };
  const run = (candidate: unknown) => {
    const item = record(candidate);
    const id = text(item?.id);
    const sessionId = text(item?.sessionId);
    if (id !== undefined && sessionId !== undefined)
      runs.push({ id, sessionId, workspaceId: text(item?.workspaceId) });
  };
  const terminal = (candidate: unknown) => {
    const item = record(candidate);
    const id = text(item?.id);
    const workspaceId = item?.workspaceId === null ? null : text(item?.workspaceId);
    if (id !== undefined && workspaceId !== undefined) terminals.push({ id, workspaceId });
  };
  if (SESSION_RESULTS.has(operation))
    session(
      value.session,
      operation === 'session.get' && value.view === 'marctl' ? 'marctl' : 'full',
      text(value.workspaceId)
    );
  if (RUN_RESULTS.has(operation)) run(value.run);
  if (TERMINAL_RESULTS.has(operation)) terminal(value.terminal);
  if (
    (operation === 'session.list' || operation === 'session.discover') &&
    Array.isArray(value.sessions)
  )
    for (const item of value.sessions)
      session(
        item,
        operation === 'session.list' && value.view === 'marctl' ? 'marctl' : 'full',
        text(input?.workspaceId)
      );
  if (operation === 'session.graph' && Array.isArray(value.nodes))
    for (const item of value.nodes) session(item, 'graph', text(input?.workspaceId));
  if (operation === 'session.runs' && Array.isArray(value.runs))
    for (const item of value.runs) run(item);
  if (operation === 'terminal.list' && Array.isArray(value.terminals))
    for (const item of value.terminals) terminal(item);
  return { sessions, runs, terminals };
}

export function relayResourceRemoval(
  operation: string,
  data: unknown,
  result: unknown
): RelayResourceRemoval | undefined {
  const input = record(data);
  const value = record(result);
  if (input === undefined || value === undefined) return undefined;
  if (operation === 'session.remove' && value.deleted === true && text(input.sessionId))
    return { kind: 'session', id: input.sessionId as string };
  const terminal = record(value.terminal);
  if (
    operation === 'terminal.close' &&
    text(input.terminalId) &&
    terminal !== undefined &&
    terminal.id === input.terminalId &&
    (terminal.state === 'CLOSED' || terminal.state === 'EXITED')
  )
    return { kind: 'terminal', id: input.terminalId as string };
  if (
    operation === 'workspace.remove' &&
    text(input.workspaceId) &&
    record(value.workspace)?.id === input.workspaceId
  )
    return { kind: 'workspace', id: input.workspaceId as string };
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : text(value);
}
