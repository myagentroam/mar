export type AgentHostCapability =
  | 'workspace.read'
  | 'workspace.patch'
  | 'process.manage'
  | 'code.execute'
  | 'user-input.request'
  | 'event.publish';

export interface HostDescription {
  apiVersion: string;
  mode: 'normal' | 'node';
  homeDirectory: string;
  platform: 'linux' | 'darwin' | 'win32';
  architecture?: string;
  shell?: { readonly name: string; readonly path: string };
  guaranteedCommands?: Readonly<Record<string, string>>;
  capabilities: readonly AgentHostCapability[];
  limits: { maxProcesses: number; maxOutputBytes: number; maxExecutionMs: number };
}
