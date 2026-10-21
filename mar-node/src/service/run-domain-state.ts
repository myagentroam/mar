export class RunDomainState {
  readonly active = new Set<string>();
  readonly interruptRequested = new Set<string>();
}
