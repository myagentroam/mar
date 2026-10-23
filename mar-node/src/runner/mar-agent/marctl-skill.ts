import { hasMarctlContext, marctlDescription, marctlInstructions } from '../../marctl-guidance.js';
import type { HostSkill } from '@myagentroam/agent';

export function marctlExecutionEnvironment(
  environment: Readonly<Record<string, string>> = {}
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key.startsWith('MAR_CTL_'))
  );
}

export function marctlHostSkill(
  environment: Readonly<Record<string, string>> = {}
): HostSkill | undefined {
  if (!hasMarctlContext(environment)) return undefined;
  return {
    name: 'marctl',
    description: marctlDescription,
    requiredTools: ['exec'],
    load: async () => marctlInstructions
  };
}
