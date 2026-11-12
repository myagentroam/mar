#!/usr/bin/env node
import { cliText } from '@myagentroam-enterprise/server-implementation/cli-locale';
import { parseQuickStartArguments } from './arguments.js';

async function main(): Promise<void> {
  let args: ReturnType<typeof parseQuickStartArguments>;
  try {
    args = parseQuickStartArguments(process.argv.slice(2));
  } catch {
    console.error(cliText('quickInvalidArguments'));
    process.exitCode = 1;
    return;
  }
  if (args.command === 'help') {
    console.log(cliText('quickUsage'));
    return;
  }
  try {
    if (args.command === 'setup') await (await import('./setup.js')).setupQuickStart(args);
    else await (await import('./run.js')).runQuickStart(args);
  } catch (error) {
    const code =
      error instanceof Error ? /^QUICK_START_[A-Z_]+/u.exec(error.message)?.[0] : undefined;
    if (
      code &&
      [
        'QUICK_START_NODE_RECLAIM_FAILED',
        'QUICK_START_MYSQL_RECLAIM_FAILED',
        'QUICK_START_SEARCH_RECLAIM_FAILED'
      ].includes(code)
    )
      console.error(cliText('quickReclaimFailed', { code }));
    else if (code === 'QUICK_START_EXTERNAL_DATABASE_UNSUPPORTED')
      console.error(cliText('quickExternalDatabaseUnsupported'));
    else if (code === 'QUICK_START_SETUP_REQUIRED') console.error(cliText('quickSetupRequired'));
    else if (code === 'QUICK_START_NETWORK_INVALID') console.error(cliText('quickNetworkInvalid'));
    else if (code === 'QUICK_START_NODE_NOT_PREPARED')
      console.error(cliText('quickNodeNotPrepared'));
    else if (code?.startsWith('QUICK_START_NODE_'))
      console.error(cliText('quickNodeInstallFailed', { code }));
    else if (code === 'QUICK_START_SERVER_PORT_IN_USE') console.error(cliText('quickPortInUse'));
    else console.error(cliText('quickFailed', { code: code ?? 'QUICK_START_UNEXPECTED' }));
    process.exitCode = 1;
  }
}

await main();
