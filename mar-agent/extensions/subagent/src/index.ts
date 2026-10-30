import type { Agent } from '@myagentroam/agent';
import { SESSION_CONTEXT_PROVIDER, type AgentExtension } from '@myagentroam/agent/extensions';
import { SessionObservations } from './observations.js';
import { registerStart, StartAdmission } from './start.js';
import { registerControlTools } from './control.js';
import { registerWait } from './wait.js';
import { registerQueryTools } from './query.js';
import { nativeSubagentService, SUBAGENT_NATIVE_SERVICE } from './native.js';
import { childResources } from './resources.js';
import { sharedSessionHistory } from './history.js';

const delegationPrompt = [
  '# Delegation and coordination',
  'Delegate bounded, self-contained tasks when independent progress or context savings materially helps. Keep simple or tightly coupled work local.',
  'Give each child an objective, necessary context, expected output, and a read-only boundary or non-overlapping write scope.',
  'Follow up through the direct delegate by default; inspect deeper Sessions only when a concrete issue needs independent verification.',
  'While children run, continue meaningful non-overlapping work. Do not redo delegated work. Wait only when the next step needs the result.',
  'Verify consequential findings and changes. Join or stop task-required child work before final delivery, and retain responsibility for the final result.'
].join('\n\n');

export { SUBAGENT_NATIVE_SERVICE } from './native.js';
export type {
  NativeAgentGroup,
  NativeAgentSnapshot,
  NativeSpawnInput,
  NativeWaitInput,
  NativeSubagentClient,
  NativeSubagentService,
  ExtensionAgentSnapshot,
  ExtensionAgentManySnapshot,
  ExtensionAgentSpawnInput,
  ExtensionAgentWaitInput,
  ExtensionAgentsApi
} from './native.js';

export interface SubagentExtensionOptions {
  /** Resolve the Agent after Host composition; it owns all Session execution. */
  readonly agent: () => Agent;
}

/** Optional local consumer of Core Session lifecycle and observation APIs. */
export function createSubagentExtension(options: SubagentExtensionOptions): AgentExtension {
  const admission = new StartAdmission();
  const warmObservations = new Map<string, SessionObservations>();
  return {
    id: 'subagent',
    apiVersion: '1.0',
    provides: [{ key: SUBAGENT_NATIVE_SERVICE }],
    async attachSession(context) {
      const agent = options.agent();
      const parent = await agent.getSession(context.sessionId);
      const history = sharedSessionHistory(agent);
      const observations = new SessionObservations(false, history);
      const native = nativeSubagentService(
        context,
        agent,
        admission,
        warmObservations,
        parent.workspace,
        history
      );
      if (warmObservations.has(context.sessionId))
        throw new Error('SUBAGENT_SESSION_ALREADY_ATTACHED');
      warmObservations.set(context.sessionId, observations);
      let disposed = false;
      let parentUnsubscribe: (() => void) | undefined;
      const observe = (
        session: Parameters<Parameters<Agent['observeSessionExecutions']>[0]>[0]
      ) => {
        if (disposed) return;
        if (session.id === context.sessionId) {
          parentUnsubscribe?.();
          const subscription = session.subscribe((event) => {
            if (
              event.type !== 'execution.completed' &&
              event.type !== 'execution.failed' &&
              event.type !== 'execution.cancelled'
            )
              return;
            admission.finish(event.executionId);
            parentUnsubscribe?.();
            parentUnsubscribe = undefined;
          });
          parentUnsubscribe = subscription.unsubscribe;
          if (subscription.terminalEvent) {
            admission.finish(subscription.terminalEvent.executionId);
            parentUnsubscribe();
            parentUnsubscribe = undefined;
          }
          return;
        }
        if (
          session.source.parentSessionId === context.sessionId &&
          session.workspace === parent.workspace
        )
          observations.observe(session);
      };
      const registration = agent.observeSessionExecutions(observe);
      try {
        for (const session of registration.sessions) observe(session);
        context.services.provide(SUBAGENT_NATIVE_SERVICE, native.service);
        context.services.provide(SESSION_CONTEXT_PROVIDER, {
          collect: (signal) => observations.collect(signal),
          wake: observations.wake,
          async resources(signal) {
            const resources = await childResources(
              agent,
              context.sessionId,
              signal,
              () => disposed,
              history
            );
            return disposed ? [] : resources;
          }
        });
        registerStart(context, agent, admission);
        registerControlTools(context, agent, observations, warmObservations, admission);
        registerWait(context, agent, observations, history);
        registerQueryTools(context, agent);
        context.hooks.intercept('prompt.sections', (input, _call, next) =>
          next({
            ...input,
            sections: [
              ...input.sections,
              {
                id: 'subagent:delegation',
                text:
                  input.facts?.mode !== 'compact' && input.facts?.tools?.includes('agent_start')
                    ? delegationPrompt
                    : null
              }
            ]
          })
        );
      } catch (error) {
        disposed = true;
        void native.close().catch(() => {});
        registration.unsubscribe();
        parentUnsubscribe?.();
        warmObservations.delete(context.sessionId);
        observations.close();
        throw error;
      }
      return async () => {
        disposed = true;
        const closing = native.close();
        registration.unsubscribe();
        parentUnsubscribe?.();
        warmObservations.delete(context.sessionId);
        observations.close();
        await closing;
      };
    }
  };
}
