export const integrationTestFiles = [
  'agent-session.spec.ts',
  'codex-credential-scope.spec.ts',
  'fake-runner-recovery.spec.ts',
  'mar-agent-image-generation-flow.spec.ts',
  'mar-agent-tool-change-flow.spec.ts',
  'mar-agent-warm-recovery/mar-agent-warm-recovery.spec.ts',
  'node-control.spec.ts',
  'server-auth.spec.ts',
  'server-web-push-clients.spec.ts',
  'server-web-hosting.spec.ts',
  'server-database-identity.spec.ts',
  'server-management-pagination.spec.ts',
  'server-service-tier-migration.spec.ts',
  'personal-model-usage.spec.ts',
  'server-workspace-secrets.spec.ts',
  'shared-conversation-audit-flow.spec.ts',
  'shared-conversation-audit-storage.spec.ts',
  'terminal-relay.spec.ts',
  'workbench-routes.spec.ts'
];

export const smokeTestTitles = [
  'Release artifacts serve the Console and enforce authentication',
  'Release Node completes a model turn, file access, and Terminal relay',
  'Release Node publishes and runs an isolated hosted conversation'
];

export function smokeTitlesForPlatform(platform = process.platform) {
  if (platform === 'linux') return smokeTestTitles;
  if (platform === 'win32') return smokeTestTitles.slice(0, 2);
  throw new Error('SMOKE_PLATFORM_INVALID');
}

export const smokeBuildFiles = [
  'mar-server/dist/main.js',
  'ee/server/dist/app.js',
  'mar-node/dist/main.js',
  'mar-agent/dist/index.js',
  'mar-web-console/dist/index.html'
];

export function e2eOptions(arguments_, platform = process.platform) {
  const smoke = arguments_.includes('--smoke');
  const integration = arguments_.includes('--integration');
  const windows = arguments_.includes('--windows');
  if ((smoke && integration) || (windows && !smoke)) throw new Error('E2E_MODE_INVALID');
  const argumentsToForward = arguments_.filter(
    (argument) => !['--smoke', '--integration', '--windows'].includes(argument)
  );
  const list = argumentsToForward.includes('--list');
  if (smoke) {
    if (platform !== (windows ? 'win32' : 'linux')) throw new Error('SMOKE_PLATFORM_INVALID');
    if (argumentsToForward.some((argument) => argument !== '--list'))
      throw new Error('SMOKE_SELECTION_FIXED');
  }
  // A focused integration project does not need the shared browser stack.
  const integrationOnly =
    integration ||
    argumentsToForward.some(
      (argument, index) =>
        argument === '--project=integration' ||
        (argument === '--project' && argumentsToForward[index + 1] === 'integration')
    );
  const projects = argumentsToForward.flatMap((argument, index) =>
    argument === '--project'
      ? [argumentsToForward[index + 1]]
      : argument.startsWith('--project=')
        ? [argument.slice('--project='.length)]
        : []
  );
  if (integrationOnly && projects.some((project) => project !== 'integration'))
    throw new Error('E2E_PROJECT_SELECTION_INVALID');
  return {
    mode: smoke ? 'smoke' : integrationOnly ? 'integration' : 'full',
    list,
    arguments:
      integration && projects.length === 0
        ? [...argumentsToForward, '--project=integration']
        : argumentsToForward
  };
}

export function assertSmokeReport(report, platform = process.platform) {
  const requiredTitles = smokeTitlesForPlatform(platform);
  const actual = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (
          test.projectName !== 'chromium' ||
          test.status !== 'expected' ||
          !spec.ok ||
          test.results?.length !== 1 ||
          test.results[0].status !== 'passed'
        )
          throw new Error('SMOKE_REQUIRED_TEST_FAILED');
        actual.push(spec.title);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  if ((report.errors ?? []).length !== 0) throw new Error('SMOKE_RUN_FAILED');
  if (
    actual.length !== requiredTitles.length ||
    requiredTitles.some((title) => actual.filter((item) => item === title).length !== 1)
  )
    throw new Error('SMOKE_REQUIRED_TEST_MISSING');
}
