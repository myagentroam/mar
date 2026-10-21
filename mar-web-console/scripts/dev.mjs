import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const viteArguments = process.argv.slice(2);
const portArgumentIndex = viteArguments.findIndex((argument) => argument === '--port');
const appPort = portArgumentIndex >= 0 ? Number(viteArguments[portArgumentIndex + 1]) : Number.NaN;
const docsPort =
  process.env.MAR_DOCS_PORT ?? (Number.isFinite(appPort) ? String(appPort + 2) : '5092');
const childEnvironment = { ...process.env, MAR_DOCS_PORT: docsPort };
const children = [
  spawn(pnpm, ['run', 'docs:dev', '--port', docsPort, '--strictPort'], {
    env: childEnvironment,
    stdio: 'inherit'
  }),
  spawn(pnpm, ['run', 'dev:app', ...viteArguments], {
    env: childEnvironment,
    stdio: 'inherit'
  })
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(exitCode);
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(
      `Development process exited (${signal ?? code ?? 1}); stopping the remaining processes.`
    );
    stop(code ?? 1);
  });
  child.on('error', (error) => {
    console.error(error);
    stop(1);
  });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
