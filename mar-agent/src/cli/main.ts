#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { describeAgentError } from '../error.js';
import { LocalAgentHost } from '../host.js';
import { readModelCatalog, writeModelCatalog, type CliModelConfiguration } from './catalog-file.js';
import {
  AgentError,
  createAgent,
  agentReasoningEffortSchema,
  resolveModelDefaultReasoningEffort,
  SecretValue,
  testAgentModelTransport,
  type RunInput,
  type ExecutionHandle,
  type AgentModelConfiguration,
  type AgentReasoningEffort
} from '../index.js';
import { CodexAuthFileCredentialProvider } from './codex-auth-file.js';
import { generateSessionTitle } from '../shared/auto-title.js';

const HELP = `maragent - MAR coding agent

Usage:
  maragent [--model ID] [--reasoning-effort EFFORT] [--codex-auth-file PATH]
  maragent run <prompt> [--permission-mode auto|full-access] [--reasoning-effort EFFORT] [--format text|json|stream-json] [--codex-auth-file PATH]
  maragent resume [sessionId] [--reasoning-effort EFFORT] [--codex-auth-file PATH]
  maragent sessions list|delete <sessionId>
  maragent models list|add|edit|remove|test [id] [--default-reasoning-effort EFFORT] [--code-mode|--no-code-mode] [--fast-mode|--no-fast-mode] [--codex-auth-file PATH]
`;

function takeOption(arguments_: string[], name: string) {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  if (arguments_.indexOf(name, index + 1) >= 0)
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', `${name} cannot be repeated.`);
  const value = arguments_[index + 1];
  if (!value) throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', `${name} requires a value.`);
  arguments_.splice(index, 2);
  return value;
}
async function loadCatalog(home: string) {
  return readModelCatalog(home);
}

function takeFlag(arguments_: string[], name: string) {
  const index = arguments_.indexOf(name);
  if (index < 0) return false;
  arguments_.splice(index, 1);
  return true;
}
function booleanFlag(arguments_: string[], enabled: string, disabled: string, fallback: boolean) {
  const on = takeFlag(arguments_, enabled);
  const off = takeFlag(arguments_, disabled);
  if (on && off)
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      `${enabled} and ${disabled} cannot be combined.`
    );
  return on ? true : off ? false : fallback;
}

async function readApiKey() {
  if (stdin.isTTY)
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', '--api-key-stdin requires piped stdin.');
  stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of stdin) value += chunk;
  if (!value.trim())
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'API key stdin was empty.');
  return value.trim();
}

async function modelsCommand(
  home: string,
  arguments_: string[],
  codexAuthFile: string | undefined
) {
  if (
    arguments_.includes('--high-density-compaction') ||
    arguments_.includes('--no-high-density-compaction')
  )
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      'High-density compaction is no longer a model option.'
    );
  if (arguments_.includes('--responses-encoding'))
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      'Responses encoding is no longer configurable.'
    );
  const action = arguments_[1];
  const catalog = await loadCatalog(home);
  if (action === 'list') {
    for (const model of catalog.models)
      stdout.write(
        `${model.id}\t${model.name}\t${model.protocol}\t${model.modelId}\tcredential=${model.apiKey === undefined ? 'codex-auth-file' : 'api-key'}\n`
      );
    return;
  }
  const id = arguments_[2];
  if (!id) throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'Model id is required.');
  const existing = catalog.models.find((model) => model.id === id);
  if (action === 'remove') {
    if (!existing) throw new AgentError('MAR_AGENT_MODEL_NOT_FOUND', 'Model was not found.');
    if (!takeFlag(arguments_, '--yes') && !stdin.isTTY)
      throw new AgentError(
        'MAR_AGENT_CLI_ARGUMENT_INVALID',
        'Non-interactive removal requires --yes.'
      );
    await writeModelCatalog(home, {
      version: 1,
      models: catalog.models.filter((model) => model.id !== id),
      ...(catalog.defaultModelId && catalog.defaultModelId !== id
        ? { defaultModelId: catalog.defaultModelId }
        : {})
    });
    return;
  }
  if (action === 'test') {
    if (!existing) throw new AgentError('MAR_AGENT_MODEL_NOT_FOUND', 'Model was not found.');
    assertExternalCredentialAvailable(existing, codexAuthFile);
    const runtime = runtimeModels([existing], codexAuthFile);
    try {
      const { response } = await testAgentModelTransport(
        runtime.models[0]!,
        AbortSignal.timeout(30_000),
        { system: 'Reply OK.', prompt: 'Reply OK.' }
      );
      stdout.write(
        `${JSON.stringify({ success: true, modelId: id, response: response.slice(0, 80) })}\n`
      );
      return;
    } finally {
      await Promise.all(runtime.providers.map((provider) => provider.close()));
    }
  }
  if (action !== 'add' && action !== 'edit')
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'Unknown model command.');
  if (action === 'add' && existing)
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'Model id already exists.');
  if (action === 'edit' && !existing)
    throw new AgentError('MAR_AGENT_MODEL_NOT_FOUND', 'Model was not found.');
  const option = (name: string, fallback?: string) => takeOption(arguments_, name) ?? fallback;
  const integer = (name: string, fallback: number) => {
    const raw = takeOption(arguments_, name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', `${name} is invalid.`);
    return value;
  };
  const protocol = option('--protocol', existing?.protocol ?? 'ANTHROPIC_MESSAGES');
  if (protocol !== 'OPENAI_RESPONSES' && protocol !== 'ANTHROPIC_MESSAGES')
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', '--protocol is invalid.');
  const required = (value: string | undefined, name: string) => {
    if (!value) throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', `${name} is required.`);
    return value;
  };
  const credential =
    option(
      '--credential',
      existing?.credentialSource === 'CODEX_AUTH_FILE' ? 'codex-auth-file' : 'api-key'
    ) ?? 'api-key';
  if (credential !== 'api-key' && credential !== 'codex-auth-file')
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', '--credential is invalid.');
  const hasFastModeOption =
    arguments_.includes('--fast-mode') || arguments_.includes('--no-fast-mode');
  const fastMode = booleanFlag(
    arguments_,
    '--fast-mode',
    '--no-fast-mode',
    credential === 'codex-auth-file' ? (existing?.fastMode ?? false) : false
  );
  if (hasFastModeOption && (protocol !== 'OPENAI_RESPONSES' || credential !== 'codex-auth-file'))
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', '--fast-mode requires Codex.');
  const readsApiKey = takeFlag(arguments_, '--api-key-stdin');
  if (credential === 'codex-auth-file' && readsApiKey)
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      '--api-key-stdin cannot be combined with an external credential.'
    );
  const responsesTransport = parseResponsesTransport(
    option('--responses-transport'),
    protocol,
    existing?.responsesTransport
  );
  const reasoningEffortsOption = option('--reasoning-efforts');
  const reasoningEfforts =
    reasoningEffortsOption === undefined
      ? (existing?.reasoningEfforts ?? [])
      : reasoningEffortsOption
          .split(',')
          .filter(Boolean)
          .map((effort) => parseReasoningEffort(effort, '--reasoning-efforts'));
  const defaultReasoningEffortOption = option('--default-reasoning-effort');
  const model: CliModelConfiguration = {
    useResourceUrl: existing?.useResourceUrl ?? false,
    id,
    name: required(option('--name', existing?.name), '--name'),
    protocol,
    baseUrl: required(option('--url', existing?.baseUrl), '--url'),
    ...(credential === 'codex-auth-file'
      ? { credentialSource: 'CODEX_AUTH_FILE' as const }
      : {
          apiKey: new SecretValue(
            readsApiKey
              ? await readApiKey()
              : required(existing?.apiKey?.reveal(), '--api-key-stdin')
          )
        }),
    modelId: required(option('--model', existing?.modelId), '--model'),
    contextWindowTokens: integer('--context', existing?.contextWindowTokens ?? 256_000),
    maxOutputTokens: integer('--max-output', existing?.maxOutputTokens ?? 32_000),
    inputCapabilities: booleanFlag(
      arguments_,
      '--image',
      '--no-image',
      existing?.inputCapabilities.includes('IMAGE') ?? false
    )
      ? ['TEXT', 'IMAGE']
      : ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts,
    defaultReasoningEffort:
      defaultReasoningEffortOption === undefined
        ? resolveModelDefaultReasoningEffort({
            reasoningEfforts,
            defaultReasoningEffort: existing?.defaultReasoningEffort
          })
        : parseReasoningEffort(defaultReasoningEffortOption, '--default-reasoning-effort'),
    conversationModel: existing?.conversationModel ?? true,
    titleGeneration: existing?.titleGeneration ?? false,
    codeMode: booleanFlag(arguments_, '--code-mode', '--no-code-mode', existing?.codeMode ?? false),
    ...(credential === 'codex-auth-file' && fastMode ? { fastMode: true } : {}),
    ...(protocol === 'OPENAI_RESPONSES' && existing?.serviceTier !== undefined
      ? {
          serviceTier: hasFastModeOption
            ? fastMode
              ? 'priority'
              : 'default'
            : existing.serviceTier
        }
      : {}),
    hostedWebSearch: booleanFlag(
      arguments_,
      '--web-search',
      '--no-web-search',
      existing?.hostedWebSearch ?? false
    ),
    ...(responsesTransport === undefined ? {} : { responsesTransport }),
    responsesPreviousResponseId: booleanFlag(
      arguments_,
      '--responses-continuation',
      '--no-responses-continuation',
      existing?.responsesPreviousResponseId ?? false
    ),
    enabled: booleanFlag(arguments_, '--enabled', '--disabled', existing?.enabled ?? true)
  };
  await writeModelCatalog(home, {
    version: 1,
    defaultModelId: catalog.defaultModelId ?? id,
    models: existing
      ? catalog.models.map((candidate) => (candidate.id === id ? model : candidate))
      : [...catalog.models, model]
  });
}

function parseReasoningEffort(value: string, optionName: string): AgentReasoningEffort {
  const parsed = agentReasoningEffortSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', `${optionName} is invalid.`);
  return parsed.data;
}

function parseResponsesTransport(
  value: string | undefined,
  protocol: AgentModelConfiguration['protocol'],
  existing: AgentModelConfiguration['responsesTransport']
): AgentModelConfiguration['responsesTransport'] {
  if (protocol !== 'OPENAI_RESPONSES') {
    if (value !== undefined)
      throw new AgentError(
        'MAR_AGENT_CLI_ARGUMENT_INVALID',
        '--responses-transport requires OPENAI_RESPONSES.'
      );
    return undefined;
  }
  const selected = value?.toLowerCase();
  if (selected === undefined) return existing;
  if (selected === 'websocket') return { transport: 'WEBSOCKET' };
  if (selected === 'http2') return { transport: 'HTTP', httpVersion: '2' };
  if (selected === 'http1' || selected === 'http1.1')
    return { transport: 'HTTP', httpVersion: '1.1' };
  throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', '--responses-transport is invalid.');
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const home = resolve(takeOption(arguments_, '--home') ?? homedir());
  const codexAuthFile = takeOption(arguments_, '--codex-auth-file');
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    stdout.write(HELP);
    return;
  }
  if (arguments_[0] === 'models') {
    await modelsCommand(home, arguments_, codexAuthFile);
    return;
  }
  const workspace = process.cwd();
  const catalog = await loadCatalog(home);
  const modelId = takeOption(arguments_, '--model') ?? catalog.defaultModelId;
  const reasoningEffortOption = takeOption(arguments_, '--reasoning-effort');
  const reasoningEffort =
    reasoningEffortOption === undefined
      ? undefined
      : parseReasoningEffort(reasoningEffortOption, '--reasoning-effort');
  const legacyAccess = takeOption(arguments_, '--access');
  const permissionModeOption = takeOption(arguments_, '--permission-mode');
  if (
    permissionModeOption !== undefined &&
    permissionModeOption !== 'auto' &&
    permissionModeOption !== 'full-access'
  )
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      '--permission-mode must be auto or full-access.'
    );
  const permissionMode = permissionModeOption as RunInput['permissionMode'];
  if (legacyAccess !== undefined && legacyAccess !== 'full-access')
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      'The deprecated --access option only accepts full-access.'
    );
  const format = takeOption(arguments_, '--format') ?? 'text';
  const command = arguments_[0];
  const selectedModel = catalog.models.find(
    (model) => model.id === modelId && model.enabled && model.conversationModel !== false
  );
  if (selectedModel !== undefined) assertExternalCredentialAvailable(selectedModel, codexAuthFile);
  if (reasoningEffort && selectedModel && !selectedModel.reasoningEfforts.includes(reasoningEffort))
    throw new AgentError(
      'MAR_AGENT_CLI_ARGUMENT_INVALID',
      `Reasoning effort "${reasoningEffort}" is not supported by model "${selectedModel.id}".`
    );
  const interactive = command !== 'run';
  let prompt = command === 'run' ? arguments_.slice(1).join(' ') : '';
  // `run` does not need stdin until a question occurs. Create
  // readline lazily so a closed or pseudo-TTY stream in an external harness
  // cannot fail the execution before its first model request.
  let terminal: ReturnType<typeof createInterface> | undefined;
  const requireTerminal = () => (terminal ??= createInterface({ input: stdin, output: stdout }));
  const host = new LocalAgentHost({
    homeDirectory: home,
    workspace,
    question: async (request) => {
      if (!stdin.isTTY)
        throw new AgentError(
          'MAR_AGENT_USER_INPUT_UNAVAILABLE',
          'Interactive input is unavailable.'
        );
      const answers: Record<string, unknown> = {};
      for (const question of request.questions) {
        const value = question as { id?: unknown; question?: unknown };
        const id = typeof value.id === 'string' ? value.id : String(Object.keys(answers).length);
        answers[id] = await requireTerminal().question(
          `${typeof value.question === 'string' ? value.question : JSON.stringify(question)} `
        );
      }
      return answers;
    }
  });
  const runtime = runtimeModels(catalog.models, codexAuthFile);
  const agent = await createAgent({
    mode: 'normal',
    host,
    models: runtime.models,
    ...(modelId === undefined ? {} : { defaultModelId: modelId })
  });
  try {
    if (command === 'sessions' && arguments_[1] === 'list') {
      stdout.write(
        `${JSON.stringify(await agent.listSessions(), null, takeFlag(arguments_, '--json') ? 0 : 2)}\n`
      );
      return;
    }
    if (command === 'sessions' && arguments_[1] === 'delete' && arguments_[2]) {
      if (!takeFlag(arguments_, '--yes') && !stdin.isTTY)
        throw new AgentError(
          'MAR_AGENT_CLI_ARGUMENT_INVALID',
          'Non-interactive deletion requires --yes.'
        );
      await agent.deleteSession(arguments_[2]);
      return;
    }
    if (command === 'sessions')
      throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'Unknown sessions command.');
    let resumeId = command === 'resume' ? arguments_[1] : undefined;
    if (command === 'resume' && !resumeId) {
      if (!stdin.isTTY)
        throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'resume requires a session id.');
      const listed = (await agent.listSessions()) as {
        sessions?: { id: string; title: string; lastActivityAt: string }[];
      };
      for (const item of listed.sessions ?? [])
        stdout.write(`${item.id}\t${item.title}\t${item.lastActivityAt}\n`);
      resumeId = (await requireTerminal().question('Session ID: ')).trim();
      if (!resumeId)
        throw new AgentError('MAR_AGENT_CLI_ARGUMENT_INVALID', 'Session id is required.');
    }
    const session = resumeId
      ? await agent.openSession(resumeId)
      : await agent.createSession({
          workspace
        });
    let activeHandle: ExecutionHandle | undefined;
    let titleController: AbortController | undefined;
    let titleTask: Promise<string | undefined> | undefined;
    let interrupts = 0;
    const interrupt = () => {
      interrupts++;
      if (activeHandle) activeHandle.cancel();
      else terminal?.close();
      titleController?.abort();
      process.exitCode = 130;
      if (interrupts > 1) activeHandle?.cancel();
    };
    process.on('SIGINT', interrupt);
    try {
      do {
        if (interactive) prompt = await requireTerminal().question('> ');
        if (!prompt.trim()) break;
        const invocation = parseExecutionInvocation(prompt);
        const executionOptions = {
          ...(permissionMode === undefined ? {} : { permissionMode }),
          ...(modelId === undefined ? {} : { modelId }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort })
        };
        const runInput: RunInput = { ...executionOptions, prompt: invocation.prompt };
        const metadata =
          !resumeId && invocation.mode !== 'compact'
            ? await agent.getSession(session.id).catch(() => undefined)
            : undefined;
        titleController = new AbortController();
        titleTask = undefined;
        const handle =
          invocation.mode === 'plan'
            ? session.plan(runInput)
            : invocation.mode === 'compact'
              ? session.compact(invocation.prompt ? runInput : executionOptions)
              : session.run(runInput);
        activeHandle = handle;
        for await (const event of handle) {
          if (event.type === 'execution.started' && metadata?.automaticTitlePending && !titleTask)
            titleTask = generateSessionTitle({
              models: runtime.models,
              currentModelId:
                modelId ??
                catalog.defaultModelId ??
                runtime.models.find((model) => model.enabled && model.conversationModel !== false)!
                  .id,
              prompt: invocation.prompt,
              signal: titleController.signal
            }).catch(() => undefined);
          if (format === 'stream-json') stdout.write(`${JSON.stringify(event)}\n`);
          else if (event.type === 'message.delta') stdout.write(event.delta);
        }
        const result = await handle.result();
        if (result.status === 'cancelled') titleController.abort();
        const title = await titleTask;
        if (title && !titleController.signal.aborted)
          await agent
            .setSessionTitle(session.id, title, {
              automatic: true,
              expectedTitle: metadata!.title,
              executionId: handle.executionId
            })
            .catch(() => undefined);
        titleController = undefined;
        activeHandle = undefined;
        if (format === 'json') stdout.write(`${JSON.stringify(result)}\n`);
        else if (format === 'text')
          stdout.write(
            result.permissionStop
              ? `\nNot executed (${result.permissionStop.action}): ${result.permissionStop.reason}\n${result.permissionStop.action === 'ask' ? 'Reply with allow or a scoped instruction to continue.\n' : ''}`
              : '\n'
          );
        if (!interactive && result.permissionStop)
          process.exitCode = result.permissionStop.action === 'ask' ? 3 : 1;
        if (result.status !== 'completed') process.exitCode = cliExitCode(result.errorCode);
      } while (interactive);
    } finally {
      titleController?.abort();
      await titleTask;
      process.off('SIGINT', interrupt);
    }
  } finally {
    terminal?.close();
    await agent.dispose();
  }
}

function runtimeModels(
  models: readonly CliModelConfiguration[],
  codexAuthFile: string | undefined
): {
  readonly models: readonly AgentModelConfiguration[];
  readonly providers: readonly CodexAuthFileCredentialProvider[];
} {
  const provider =
    codexAuthFile !== undefined &&
    models.some((model) => model.credentialSource === 'CODEX_AUTH_FILE')
      ? new CodexAuthFileCredentialProvider(codexAuthFile)
      : undefined;
  return {
    models: models.flatMap((model) => {
      const { credentialSource, ...configuration } = model;
      if (credentialSource === undefined) return [configuration];
      return provider === undefined
        ? []
        : [
            {
              ...configuration,
              responsesConfigurationUpdates: true,
              credentialProvider: provider
            }
          ];
    }),
    providers: provider === undefined ? [] : [provider]
  };
}

function assertExternalCredentialAvailable(
  model: CliModelConfiguration,
  codexAuthFile: string | undefined
): void {
  if (model.credentialSource === 'CODEX_AUTH_FILE' && codexAuthFile === undefined)
    throw new AgentError(
      'MAR_AGENT_MODEL_AUTH_FAILED',
      'Codex auth file is required for the selected model.'
    );
}

function cliExitCode(code: string | undefined): number {
  if (code === undefined) return 1;
  if (code.includes('USER_INPUT_UNAVAILABLE') || code.includes('DENIED')) return 3;
  if (
    code.includes('AUTH') ||
    code.includes('CREDENTIAL') ||
    code.includes('CONNECTION') ||
    code.includes('TIMEOUT')
  )
    return 4;
  if (code.includes('ARGUMENT') || code.includes('CONFIG')) return 2;
  return 1;
}

function parseExecutionInvocation(input: string): {
  mode: 'run' | 'plan' | 'compact';
  prompt: string;
} {
  const match = /^\/(plan|compact)(?:\s+([\s\S]*))?$/u.exec(input.trim());
  if (!match) return { mode: 'run', prompt: input };
  const mode = match[1] as 'plan' | 'compact';
  const argument = match[2]?.trim();
  return {
    mode,
    prompt:
      argument ||
      (mode === 'plan'
        ? 'Investigate the current objective, resolve discoverable uncertainty, and produce an executable implementation and verification plan without claiming the work is complete.'
        : '')
  };
}

main().catch((error: unknown) => {
  const diagnostic = describeAgentError(error, 'MAR_AGENT_CLI_FAILED', 'CLI command failed.');
  process.stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
  process.exitCode = cliExitCode(diagnostic.code);
});
