import { describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../../src/runner/codex-runner.js';
import { codexUserInputQuestions } from '../../src/runner/codex/conversation-parser.js';
import {
  CodexManagedRunController,
  type CodexManagedRunHost
} from '../../src/runner/codex/managed-run-controller.js';
import { RunnerInteractionService } from '../../src/service/runner-interaction-service.js';

describe('Codex user-input identities', () => {
  it.each([
    { name: 'short and boundary-length IDs', ids: ['direction', 'q'.repeat(128)] },
    { name: 'IDs matching object prototype properties', ids: ['__proto__', 'constructor'] },
    { name: 'one oversized ID', ids: ['q'.repeat(129)] },
    {
      name: 'oversized IDs with a shared prefix and a short alias-like ID',
      ids: [`${'q'.repeat(128)}A`, `${'q'.repeat(128)}B`, 'question-0']
    }
  ])('round-trips $name without collisions or exposing native mappings', ({ ids }) => {
    const runner = new CodexRunner();
    const respond = vi.spyOn(runner, 'respond').mockImplementation(() => undefined);
    const emitItem = vi.fn<CodexManagedRunHost<never>['emitItem']>();
    const controller = new CodexManagedRunController(runner, {
      emitItem,
      emit: vi.fn(),
      session: () => undefined
    } as unknown as CodexManagedRunHost<never>);
    const interaction = new RunnerInteractionService({
      codex: () => runner,
      claude: () => ({ execution: { userInputs: new Map() } }),
      runtime: { getRun: () => ({ id: 'run' }) },
      runners: { respondUserInput: () => false },
      emitItem
    } as unknown as ConstructorParameters<typeof RunnerInteractionService>[0]);
    runner.execution.runs.set('run', {
      sessionId: 'session',
      threadId: 'thread',
      turnId: 'turn',
      cwd: '/workspace'
    });
    const nativeQuestions = ids.map((id) => ({
      id,
      question: 'Choose an answer',
      options: [{ label: 'Yes' }, { label: 'No' }]
    }));
    try {
      controller.handleNotification({
        method: 'item/tool/requestUserInput',
        requestId: 42,
        params: { threadId: 'thread', turnId: 'turn', questions: nativeQuestions }
      });
      expect(emitItem).toHaveBeenCalledOnce();
      const payload = emitItem.mock.calls[0]![1].payload;
      const questions = payload.questions as readonly { id: string }[];
      const publicIds = questions.map((question) => question.id);
      expect(questions).toHaveLength(ids.length);
      expect(new Set(publicIds).size).toBe(ids.length);
      expect(publicIds.every((id) => id.length > 0 && id.length <= 128)).toBe(true);
      expect(publicIds).toEqual(codexUserInputQuestions(nativeQuestions).map((q) => q.id));
      expect(questions.every((question) => !('nativeId' in question))).toBe(true);
      if (ids.every((id) => id.length <= 128)) expect(publicIds).toEqual(ids);

      const answers = Object.fromEntries(
        publicIds.map((id, index) => [id, [index % 2 === 0 ? 'Yes' : 'No']])
      );
      if (ids.some((id) => id.length > 128)) {
        expect(() => interaction.respondUserInput('run', '42', {})).toThrow();
        expect(respond).not.toHaveBeenCalled();
        expect(runner.execution.userInputs.has('run\0' + '42')).toBe(true);
      }
      interaction.respondUserInput('run', '42', answers);
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        42,
        {
          answers: Object.fromEntries(
            ids.map((id, index) => [id, { answers: [index % 2 === 0 ? 'Yes' : 'No'] }])
          )
        },
        'run'
      );
      expect(runner.execution.userInputs.size).toBe(0);
      expect(emitItem.mock.calls.at(-1)![1]).toMatchObject({ status: 'COMPLETED' });
      expect(() => interaction.respondUserInput('run', '42', answers)).toThrow(
        'USER_INPUT_NOT_FOUND'
      );
      expect(respond).toHaveBeenCalledOnce();
    } finally {
      runner.stop();
    }
  });
});
