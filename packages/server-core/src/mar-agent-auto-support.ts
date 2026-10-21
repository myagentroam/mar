import { runnerProfileSchema } from '@myagentroam/protocol';

/** Preflight only; the Node and SDK remain the execution and permission authorities. */
export async function requireMarAgentAutoSupport(input: {
  access: unknown;
  runner?: unknown;
  sessionId?: string;
  request: (operation: string, data: unknown) => Promise<unknown>;
}): Promise<void> {
  if (input.access !== 'auto') return;
  let runner = input.runner;
  if (input.sessionId !== undefined) {
    const result = await input.request('session.get', { sessionId: input.sessionId });
    runner = (result as { session?: { runner?: unknown } } | undefined)?.session?.runner;
    if (runner === undefined) throw new Error('SESSION_INVALID');
  }
  if (runner !== 'mar-agent') return;
  const result = await input.request('node.workbench.capabilities', {});
  const runners = (result as { manifest?: { runners?: unknown } } | undefined)?.manifest?.runners;
  const profiles = runnerProfileSchema.array().safeParse(runners);
  if (
    !profiles.success ||
    !profiles.data.some(
      (profile) =>
        profile.runner === 'mar-agent' &&
        profile.accessOptions.some((option) => option.id === 'auto')
    )
  )
    throw new Error('MAR_AGENT_AUTO_UNSUPPORTED');
}
