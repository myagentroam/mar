export const computerRuntimeTargets = [
  { platform: 'win32', architecture: 'x64', executable: 'python.exe' },
  { platform: 'win32', architecture: 'arm64', executable: 'python.exe' },
  { platform: 'darwin', architecture: 'x64', executable: 'bin/python3' },
  { platform: 'darwin', architecture: 'arm64', executable: 'bin/python3' },
  { platform: 'linux', architecture: 'x64', executable: 'bin/python3' },
  { platform: 'linux', architecture: 'arm64', executable: 'bin/python3' }
].map((target) => ({
  ...target,
  id: `${target.platform}-${target.architecture}`,
  name: `@myagentroam/computer-runtime-${target.platform}-${target.architecture}`,
  path: `packages/computer-runtime-${target.platform}-${target.architecture}`
}));

export const computerRuntimeNames = computerRuntimeTargets.map(({ name }) => name);
export const computerRuntimePaths = computerRuntimeTargets.map(({ path }) => path);

// Runtime artifacts are published for all targets. Native Computer Use behavior has
// currently been validated only on win32-x64 and linux-x64; the other targets have
// complete, integrity-checked runtime environments but no native behavior claim.
export const publishedComputerRuntimeTargets = computerRuntimeTargets;

export function computerRuntimeTarget(platform, architecture) {
  return computerRuntimeTargets.find(
    (target) => target.platform === platform && target.architecture === architecture
  );
}
