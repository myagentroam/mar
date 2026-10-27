import { AgentError } from '../error.js';
import type {
  ExtensionCallbackRunner,
  ExtensionOperationContext,
  ExtensionOperationRunner
} from './operation.js';
import type { ExtensionResourceRegistration, ExtensionResourceScope } from './resources.js';

export interface ExtensionCommandSpec {
  readonly name: string;
  readonly description?: string;
  readonly override?: 'replace';
  handler(args: unknown, call: ExtensionOperationContext): unknown | Promise<unknown>;
}
export interface ExtensionCommandsApi {
  register(spec: ExtensionCommandSpec): ExtensionResourceRegistration;
  list(): readonly Pick<ExtensionCommandSpec, 'name' | 'description'>[];
  run(input: { readonly name: string; readonly args?: unknown }): Promise<unknown>;
}

/** Session command definitions follow the contributing Extension scope. */
export class ExtensionCommands {
  readonly #entries: {
    readonly value: ExtensionCommandSpec;
    readonly scope: ExtensionResourceScope;
  }[] = [];
  constructor(private readonly callback: ExtensionCallbackRunner) {}
  bind(scope: ExtensionResourceScope, run: ExtensionOperationRunner): ExtensionCommandsApi {
    return {
      register: (spec) => {
        if (
          typeof spec.name !== 'string' ||
          !spec.name.trim() ||
          typeof spec.handler !== 'function' ||
          (spec.override !== undefined && spec.override !== 'replace')
        )
          throw new AgentError(
            'MAR_AGENT_EXTENSION_COMMAND_INVALID',
            'Command definition is invalid.'
          );
        if (
          spec.override !== 'replace' &&
          this.#entries.some((entry) => entry.value.name === spec.name)
        )
          throw new AgentError('MAR_AGENT_EXTENSION_COMMAND_CONFLICT', 'Command name conflicts.');
        const entry = { value: Object.freeze({ ...spec }), scope };
        const registration = scope.effect(() => () => {
          const index = this.#entries.indexOf(entry);
          if (index !== -1) this.#entries.splice(index, 1);
        });
        this.#entries.push(entry);
        return registration;
      },
      list: () =>
        [
          ...new Map(
            this.#entries
              .filter((entry) => entry.scope.state === 'ACTIVE')
              .map((entry) => [entry.value.name, entry] as const)
          ).values()
        ].map(({ value }) => ({
          name: value.name,
          ...(value.description ? { description: value.description } : {})
        })),
      run: (input) =>
        run(async (context) => {
          const entry = this.#entries.findLast(
            (entry) => entry.scope.state === 'ACTIVE' && entry.value.name === input.name
          );
          if (!entry)
            throw new AgentError(
              'MAR_AGENT_EXTENSION_COMMAND_UNAVAILABLE',
              'Command is unavailable.'
            );
          return entry.scope.run(
            (signal) =>
              this.callback(
                Object.freeze({ ...context, signal, ownerInstanceId: entry.scope.instanceId }),
                (call) => entry.value.handler(input.args, call)
              ),
            context.signal
          );
        })
    };
  }
}
