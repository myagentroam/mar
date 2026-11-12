/** All resources remain behind the single binaries dependency. */
export const binariesTargets = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
].map((id) => ({ id, name: `@myagentroam/binaries-${id}`, path: `packages/binaries-${id}` }));
