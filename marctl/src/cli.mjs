import { readFile } from 'node:fs/promises';
import { MarctlClient } from './client.mjs';
import { loadConfig } from './config.mjs';
import { MarctlError } from './errors.mjs';
import { createTranslator } from './i18n/index.mjs';
import { runTerminalSession } from './terminal.mjs';
import { runScp } from './scp.mjs';
import { parseSessionArgs } from './session-args.mjs';
import { runSessionCommand, sessionExitCode } from './sessions.mjs';

async function withCommandSignals(run) {
  const controller = new AbortController();
  const onSigint = () => controller.abort('SIGINT');
  const onSigterm = () => controller.abort('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    return await run(controller.signal);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    program = 'marctl',
    client,
    WebSocketClass
  } = {}
) {
  const translate = createTranslator(env);
  let args;
  try {
    args = parseArgs(argv, translate);
    if (args.help) {
      writeLine(
        stdout,
        args.command === undefined
          ? translate('help')
          : translate(`commandHelp.${args.command}`, {
              program: program === 'marctl' ? `marctl ${args.command}` : program
            })
      );
      return 0;
    }
    if (args.version) {
      const { version } = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8')
      );
      writeLine(stdout, `marctl ${version}`);
      return 0;
    }

    const config = await loadConfig({ env, translate });
    const marctlClient = client ?? new MarctlClient({ ...config, translate });
    if (args.command === 'nodes') {
      const nodes = await marctlClient.listNodes();
      writeLine(stdout, translate('nodesHeader'));
      for (const node of nodes) {
        writeLine(
          stdout,
          [
            node.id,
            node.displayName ?? '',
            node.connected ? translate('connected') : translate('disconnected'),
            node.platform ?? ''
          ].join('\t')
        );
      }
      return 0;
    }
    if (args.command === 'sessions') {
      const execute = (signal) =>
        runSessionCommand({
          args,
          client: marctlClient,
          env,
          stdin,
          WebSocketClass,
          translate,
          signal
        });
      const result = args.action === 'wait' ? await withCommandSignals(execute) : await execute();
      writeLine(stdout, JSON.stringify(result, null, args.json ? undefined : 2));
      return 0;
    }
    if (args.command === 'scp') {
      const socketClass = WebSocketClass ?? (await import('ws')).default;
      return await withCommandSignals((signal) =>
        runScp({
          source: args.source,
          destination: args.destination,
          preserve: args.preserve,
          client: marctlClient,
          WebSocketClass: socketClass,
          resolveNodeId: (reference) => resolveNodeId(marctlClient, reference, translate),
          translate,
          signal
        })
      );
    }

    const nodeId = await resolveNodeId(marctlClient, args.nodeId, translate);
    const socketClass = WebSocketClass ?? (await import('ws')).default;
    return await withCommandSignals((signal) =>
      runTerminalSession({
        client: marctlClient,
        WebSocketClass: socketClass,
        nodeId,
        command: args.remoteCommand,
        raceConnections: true,
        stdout,
        stderr,
        translate,
        signal
      })
    );
  } catch (error) {
    if (argv[0] === 'sessions') {
      const failure = {
        code: error.code ?? 'MARCTL_COMMAND_FAILED',
        message: error instanceof MarctlError ? error.message : translate('errors.commandFailed'),
        ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
        ...(error.upstreamRequestId === undefined
          ? {}
          : { upstreamRequestId: error.upstreamRequestId }),
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
        ...(error.runId === undefined ? {} : { runId: error.runId }),
        ...(error.stage === undefined ? {} : { stage: error.stage }),
        ...(error.upstreamCode === undefined ? {} : { upstreamCode: error.upstreamCode }),
        ...(error.progress === undefined ? {} : { progress: error.progress }),
        ...(error.clientMessageId === undefined ? {} : { clientMessageId: error.clientMessageId })
      };
      if (args?.json === true || (args === undefined && argv.includes('--json')))
        writeLine(stdout, JSON.stringify({ error: failure }));
      else {
        writeLine(stderr, program + ': ' + failure.message + ' [' + failure.code + ']');
        if (failure.details !== undefined) writeLine(stderr, failure.details);
        if (failure.progress !== undefined)
          writeLine(stderr, JSON.stringify({ progress: failure.progress }, null, 2));
      }
      return sessionExitCode(error);
    }
    writeLine(
      stderr,
      `${program}: ${error instanceof MarctlError ? error.message : translate('errors.commandFailed')}`
    );
    return 1;
  }
}

export async function resolveNodeId(client, reference, translate = createTranslator()) {
  const nodes = await client.listNodes();
  const byId = nodes.find((node) => node.id === reference);
  if (byId) return byId.id;
  const matches = nodes.filter((node) => node.displayName === reference);
  if (matches.length > 1) throw new MarctlError(translate('errors.nodeNameAmbiguous'));
  if (matches.length === 0) throw new MarctlError(translate('errors.nodeNotFound'));
  return matches[0].id;
}

export function executableArgs(executable, args) {
  const name = String(executable ?? '')
    .split(/[\\/]/u)
    .at(-1)
    .replace(/\.(?:cmd|exe|ps1)$/iu, '');
  const command = { marnodes: 'nodes', marssh: 'ssh', marscp: 'scp' }[name];
  return command === undefined ? args : [command, ...args];
}

export function parseArgs(argv, translate = createTranslator()) {
  if (argv[0] === 'sessions') return parseSessionArgs(argv.slice(1), translate);
  let command;
  let nodeId;
  const remoteArgs = [];
  let separator = false;
  let help = false;
  let version = false;
  let preserve = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      !separator &&
      nodeId === undefined &&
      (argument === '--help' || argument === '-h' || (command === undefined && argument === 'help'))
    ) {
      help = true;
      continue;
    }
    if (!separator && nodeId === undefined && (argument === '--version' || argument === '-V')) {
      version = true;
      continue;
    }
    if (!separator && argument === '--') {
      separator = true;
      continue;
    }
    if (command === undefined) {
      if (
        argument !== 'nodes' &&
        argument !== 'ssh' &&
        argument !== 'scp' &&
        argument !== 'sessions' &&
        argument !== 'version'
      )
        throw unsupportedSshOption(argument, translate);
      command = argument;
      continue;
    }
    if (command === 'nodes' || command === 'version')
      throw new MarctlError(translate('errors.invalidArguments'));
    if (command === 'scp') {
      if (!separator && argument.startsWith('-') && argument !== '-') {
        if (!/^-[pq]+$/u.test(argument))
          throw new MarctlError(translate('errors.scpOptionsUnsupported'));
        if (argument.includes('p')) preserve = true;
        continue;
      }
      if (nodeId === undefined) nodeId = argument;
      else remoteArgs.push(argument);
      continue;
    }
    if (nodeId === undefined) {
      if (!separator && argument.startsWith('-'))
        throw command === 'ssh'
          ? unsupportedSshOption(argument, translate)
          : new MarctlError(translate('errors.invalidArguments'));
      nodeId = argument;
      continue;
    }
    remoteArgs.push(argument);
  }

  if (help) return { help: true, ...(command === undefined ? {} : { command }) };
  if (version || command === 'version') return { version: true };
  if (command === 'nodes' && nodeId === undefined && remoteArgs.length === 0) return { command };
  if (command === 'scp' && nodeId !== undefined && remoteArgs.length === 1)
    return {
      command,
      source: nodeId,
      destination: remoteArgs[0],
      preserve
    };
  if (command === 'ssh' && nodeId !== undefined && nodeId !== '')
    return {
      command,
      nodeId,
      ...(remoteArgs.length === 0
        ? {}
        : { remoteCommand: remoteArgs.length === 1 ? remoteArgs[0] : remoteArgs.join(' ') })
    };
  throw new MarctlError(translate('errors.invalidArguments'));
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function unsupportedSshOption(argument, translate) {
  if (typeof argument === 'string' && argument.startsWith('-'))
    return new MarctlError(translate('errors.sshOptionsUnsupported'));
  return new MarctlError(translate('errors.invalidArguments'));
}
