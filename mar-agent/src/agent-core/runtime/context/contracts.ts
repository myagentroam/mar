export interface EnvironmentContextState {
  platform: string;
  architecture?: string;
  shell?: { readonly name: string; readonly path: string };
  guaranteedCommands?: Readonly<Record<string, string>>;
  workspace: string;
  currentDate?: string;
  timezone?: string;
}
