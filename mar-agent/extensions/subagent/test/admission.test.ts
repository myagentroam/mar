import { expect, it } from 'vitest';
import type { Agent, AgentLiveSession } from '@myagentroam/agent';
import { StartAdmission } from '../src/start.js';

it('isolates both active children and pending reservations by parent', () => {
  const sessions = Array.from({ length: 15 }, (_, index) => ({
    id: `child-${index}`,
    source: { parentSessionId: 'parent-a' }
  })) as AgentLiveSession[];
  const agent = {
    observeSessionExecutions: () => ({ sessions, unsubscribe() {} })
  } as unknown as Agent;
  const admission = new StartAdmission();
  const releaseA = admission.reserve(agent, 'parent-a', 'execution-a');
  expect(() => admission.reserve(agent, 'parent-a', 'other-execution-a')).toThrow();
  const releasesB = Array.from({ length: 16 }, (_, index) =>
    admission.reserve(agent, 'parent-b', `execution-b-${index}`)
  );
  expect(() => admission.reserve(agent, 'parent-b', 'overflow')).toThrow();
  releasesB[0]!(false);
  const replacement = admission.reserve(agent, 'parent-b', 'replacement');
  replacement(false);
  releaseA(false);
  for (const release of releasesB.slice(1)) release(false);
});

it('shares a parent capacity between resumption and creation without counting a resume as creation', () => {
  const sessions = Array.from({ length: 15 }, (_, index) => ({
    id: `child-${index}`,
    source: { parentSessionId: 'parent' }
  })) as AgentLiveSession[];
  const agent = {
    observeSessionExecutions: () => ({ sessions, unsubscribe() {} })
  } as unknown as Agent;
  const admission = new StartAdmission();
  const resume = admission.reserveResume(agent, 'parent');
  expect(() => admission.reserve(agent, 'parent', 'execution')).toThrow();
  resume();
  const start = admission.reserve(agent, 'parent', 'execution');
  expect(() => admission.reserveResume(agent, 'parent')).toThrow();
  start(false);
  for (let i = 0; i < 20; i++) admission.reserveResume(agent, 'parent')();
  const afterResumes = admission.reserve(agent, 'parent', 'execution');
  afterResumes(false);
  sessions.push({ id: 'child-15', source: { parentSessionId: 'parent' } } as AgentLiveSession);
  expect(() => admission.reserveResume(agent, 'parent')).toThrow();
});

it('enforces sixteen creations per parent execution independently of concurrent activity', () => {
  const agent = {
    observeSessionExecutions: () => ({ sessions: [], unsubscribe() {} })
  } as unknown as Agent;
  const admission = new StartAdmission();
  for (let i = 0; i < 16; i++) admission.reserve(agent, 'parent', 'execution')(true);
  expect(() => admission.reserve(agent, 'parent', 'execution')).toThrow();
  admission.reserve(agent, 'parent', 'next-execution')(true);
  admission.finish('execution');
  admission.reserve(agent, 'parent', 'execution')(false);
});
