export interface HostSkill {
  readonly name: string;
  readonly description: string;
  readonly requiredTools: readonly string[];
  load(): Promise<string>;
}
