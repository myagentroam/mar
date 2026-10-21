export const LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION = 1;

export type LinuxSandboxNetworkMode = 'NONE' | 'UNRESTRICTED';

export interface LinuxSandboxMount {
  readonly source: string;
  readonly destination: string;
  readonly access: 'READ_ONLY' | 'READ_WRITE';
}

export type LinuxSandboxTemporaryDirectory =
  { readonly kind: 'EPHEMERAL' } | { readonly kind: 'MOUNT'; readonly source: string };

export type LinuxSandboxWorkingDirectory =
  { readonly kind: 'REQUEST' } | { readonly kind: 'SANDBOX'; readonly path: string };

export interface BubblewrapSandboxProfile {
  readonly policyVersion: number;
  readonly networkMode?: LinuxSandboxNetworkMode;
  readonly mounts?: readonly LinuxSandboxMount[];
  readonly temporaryDirectory?: LinuxSandboxTemporaryDirectory;
  readonly workingDirectory?: LinuxSandboxWorkingDirectory;
}

export interface BubblewrapSandboxExecutorOptions {
  readonly profile: BubblewrapSandboxProfile;
  readonly bubblewrapPath?: string;
}
