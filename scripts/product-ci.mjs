export function productCheckCommands(runId) {
  return [
    ['frozen-install', 'pnpm', ['install', '--frozen-lockfile']],
    ...[
      'lint',
      'check:versions',
      'check:public-boundary',
      'typecheck',
      'test:unit',
      'build',
      'test:build',
      'check:release-artifacts',
      'test:e2e'
    ].map((script) => [script, 'pnpm', [script]]),
    [
      'server-docker-build',
      'docker',
      [
        'build',
        '--target',
        'server',
        '--tag',
        `myagentroam-server-ci:${runId.toLowerCase().slice(0, 96)}`,
        '.'
      ]
    ]
  ];
}
