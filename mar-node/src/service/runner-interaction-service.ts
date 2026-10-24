import type { NodeRuntimeState } from '../runtime-state.js';
import type { NodeAgentSession } from '../database.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';
import type { ClaudeCodeRunner } from '../runner/claude-code-runner.js';
import { denyPermission } from '../claude-agent-sdk.js';
import type { CodexRunner } from '../runner/codex-runner.js';
import { boundedConversationItemId, isTerminalRunStatus } from '../util/node-operation-parsers.js';
import { claudeUserInputQuestions } from '../util/runner-native-session-parsers.js';
import type { PublicConversationItem } from '../native-transcript-model.js';
import type { RunDomainState } from './run-domain-state.js';

interface RunnerInteractionServiceOptions {
  readonly runtime: NodeRuntimeState;
  readonly state: RunDomainState;
  readonly codex: () => CodexRunner;
  readonly settleCodexUsage: (runId: string, turnId: string) => Promise<void>;
  readonly claude: () => ClaudeCodeRunner;
  readonly runners: RunnerRegistry;
  readonly emitRun: (
    runId: string,
    eventType: string,
    payload: unknown,
    status?: 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
  ) => void;
  readonly emitItem: (runId: string, item: PublicConversationItem) => void;
  readonly approvalTimeoutMs: number;
  readonly publishApproval: (input: {
    readonly runId: string;
    readonly approvalId: string;
    readonly payload: unknown;
    readonly expiresAt: number;
  }) => void;
}

export class RunnerInteractionService {
  constructor(private readonly options: RunnerInteractionServiceOptions) {}

  publishApproval(input: Parameters<RunnerInteractionServiceOptions['publishApproval']>[0]): void {
    const run = this.options.runtime.getRun(this.options.runtime.canonicalRunId(input.runId));
    if (run?.source !== 'SCHEDULED') {
      this.options.publishApproval(input);
      return;
    }
    this.options.emitRun(input.runId, 'approval.request', input);
    queueMicrotask(() => {
      try {
        this.options.runtime.decideApproval(input.approvalId, 'APPROVED');
        this.options.emitRun(input.runId, 'approval.decided', {
          approvalId: input.approvalId,
          decision: 'APPROVED',
          source: 'SCHEDULED'
        });
        this.options.runners.decideApproval({
          runId: input.runId,
          approvalId: input.approvalId,
          decision: 'APPROVED'
        });
      } catch {
        // A cancelled execution cannot receive an approval after its pending request expires.
      }
    });
  }

  requestClaudeApproval(runId: string, toolName: string, toolInput: Record<string, unknown>) {
    const approvalId = `claude:${crypto.randomUUID()}`;
    return new Promise<ReturnType<typeof denyPermission>>((resolve) => {
      const expiresAt = Date.now() + this.options.approvalTimeoutMs;
      const settle = (decision: 'APPROVED' | 'REJECTED') =>
        resolve(
          decision === 'APPROVED'
            ? { behavior: 'allow', updatedInput: toolInput }
            : denyPermission()
        );
      try {
        this.options.runtime.createApproval({
          runId,
          approvalId,
          payload: { toolName, input: toolInput },
          expiresAt
        });
      } catch {
        resolve(denyPermission('APPROVAL_STORE_FAILED'));
        return;
      }
      const expire = () => {
        const approvals = this.options.claude().execution.approvals;
        const active = approvals.get(approvalId);
        if (active === undefined) return;
        try {
          this.options.runtime.expireApproval(approvalId);
        } catch (error) {
          if (error instanceof Error && error.message === 'APPROVAL_NOT_EXPIRED') {
            const timer = setTimeout(expire, Math.max(1, expiresAt - Date.now()));
            approvals.set(approvalId, { ...active, timer });
            return;
          }
        }
        approvals.delete(approvalId);
        this.options.emitRun(active.runId, 'approval.expired', { approvalId });
        resolve(denyPermission('APPROVAL_EXPIRED'));
      };
      const timer = setTimeout(expire, this.options.approvalTimeoutMs);
      this.options.claude().execution.approvals.set(approvalId, {
        runId,
        timer,
        resolve: settle
      });
      this.publishApproval({
        runId,
        approvalId,
        payload: { toolName, input: toolInput },
        expiresAt
      });
    });
  }

  requestClaudeUserInput(runId: string, toolInput: Record<string, unknown>, toolUseId: string) {
    const questions = claudeUserInputQuestions(toolInput);
    if (questions.length === 0) return Promise.resolve(denyPermission('USER_INPUT_INVALID'));
    const requestId = `claude:${runId}:${toolUseId}`;
    return new Promise<ReturnType<typeof denyPermission>>((resolve) => {
      const input = { ...toolInput };
      const timer = setTimeout(() => {
        const pending = this.options.claude().execution.userInputs.get(requestId);
        if (pending === undefined) return;
        this.options.claude().execution.userInputs.delete(requestId);
        pending.reject('USER_INPUT_EXPIRED');
        this.options.emitItem(runId, {
          itemId: boundedConversationItemId('claude-input', requestId),
          kind: 'user_input_request',
          status: 'FAILED',
          payload: { requestId, questions },
          merge: true
        });
      }, this.options.approvalTimeoutMs);
      this.options.claude().execution.userInputs.set(requestId, {
        runId,
        requestId,
        questions,
        input,
        resolve: (answers) => resolve({ behavior: 'allow', updatedInput: { ...input, answers } }),
        reject: (message = 'USER_INPUT_EXPIRED') => resolve(denyPermission(message)),
        timer
      });
      this.options.emitItem(runId, {
        itemId: boundedConversationItemId('claude-input', requestId),
        kind: 'user_input_request',
        status: 'PENDING',
        payload: { requestId, questions }
      });
    });
  }

  deliverChannel(
    runner: NodeAgentSession['runner'],
    sessionId: string,
    messageId: string,
    senderId: string,
    token: string,
    content: string
  ) {
    return this.options.runners
      .require(runner)
      .deliverChannel(
        sessionId,
        messageId,
        senderId,
        token,
        content,
        (runId, deliveredMessageId, delivery) =>
          this.options.emitRun(runId, 'channel.delivery', {
            messageId: deliveredMessageId,
            delivery
          })
      );
  }

  decideCodexApproval(approvalId: string, decision: 'APPROVED' | 'REJECTED'): boolean {
    const codex = this.options.codex();
    const approval = codex.execution.approvals.get(approvalId);
    if (approval === undefined) return false;
    try {
      codex.respond(
        approval.requestId,
        { decision: decision === 'APPROVED' ? 'accept' : 'decline' },
        approval.runId
      );
    } catch {
      // A disconnected App Server cannot safely receive a late approval.
    }
    codex.execution.approvals.delete(approvalId);
    return true;
  }

  decideClaudeApproval(approvalId: string, decision: 'APPROVED' | 'REJECTED'): boolean {
    const approvals = this.options.claude().execution.approvals;
    const approval = approvals.get(approvalId);
    if (approval === undefined) return false;
    clearTimeout(approval.timer);
    approvals.delete(approvalId);
    approval.resolve(decision);
    return true;
  }

  cancelClaudeRun(runId: string, intent: 'CANCEL' | 'INTERRUPT'): boolean {
    const claudeRun = this.options.claude().execution.runs.get(runId);
    if (claudeRun === undefined) return false;
    if (intent === 'CANCEL') claudeRun.handle.cancel();
    else
      void claudeRun.handle.interrupt().then(
        () => {
          const run = this.options.runtime.getRun(runId);
          if (run !== undefined && !isTerminalRunStatus(run.status))
            this.options.emitRun(runId, 'run.completed', { status: 'INTERRUPTED' }, 'INTERRUPTED');
        },
        () => {
          const run = this.options.runtime.getRun(runId);
          if (run !== undefined && !isTerminalRunStatus(run.status))
            this.options.emitRun(
              runId,
              'run.failed',
              { code: 'CLAUDE_INTERRUPT_FAILED' },
              'FAILED'
            );
        }
      );
    return true;
  }

  async cancelCodexTurn(
    runId: string,
    threadId: string,
    turnId: string,
    cwd: string,
    terminalStatus: 'CANCELLED' | 'INTERRUPTED'
  ): Promise<void> {
    const codex = this.options.codex();
    let failed = false;
    try {
      await codex.interruptTurn(threadId, turnId, runId);
    } catch {
      failed = true;
    }
    try {
      await this.options.settleCodexUsage(runId, turnId);
      const run = this.options.runtime.getRun(runId);
      if (run !== undefined && !isTerminalRunStatus(run.status)) {
        if (failed)
          this.options.emitRun(runId, 'run.failed', { code: 'CODEX_INTERRUPT_FAILED' }, 'FAILED');
        else
          this.options.emitRun(runId, 'run.completed', { status: terminalStatus }, terminalStatus);
      }
    } finally {
      codex.execution.runs.delete(runId);
      codex.releaseEnvironment(runId);
      this.options.state.active.delete(runId);
    }
  }

  respondUserInput(runId: string, requestId: string, rawAnswers: Record<string, unknown>): void {
    if (this.options.runners.respondUserInput(runId, requestId, rawAnswers)) return;
    if (this.options.codex().execution.userInputs.has(`${runId}\0${requestId}`)) {
      this.respondCodexUserInput(runId, requestId, rawAnswers);
      return;
    }
    const userInputs = this.options.claude().execution.userInputs;
    const pending = userInputs.get(requestId);
    if (pending === undefined || pending.runId !== runId) throw new Error('USER_INPUT_NOT_FOUND');
    const answers: Record<string, string> = {};
    for (const question of pending.questions) {
      const normalized = this.answers(rawAnswers[question.id], question.allowOther, (value) =>
        question.options.some((option) => option.value === value)
      );
      if (!question.multiSelect && normalized.length !== 1) throw new Error('USER_INPUT_INVALID');
      answers[question.prompt] = normalized.join(', ');
    }
    clearTimeout(pending.timer);
    userInputs.delete(requestId);
    pending.resolve(answers);
    this.options.emitItem(runId, {
      itemId: boundedConversationItemId('claude-input', requestId),
      kind: 'user_input_request',
      status: 'COMPLETED',
      payload: { requestId, questions: pending.questions },
      merge: true
    });
  }

  completeCancelledRun(runId: string): boolean {
    const run = this.options.runtime.getRun(runId);
    if (run === undefined) return false;
    if (run.status === 'CANCELLING') {
      const status = this.options.state.interruptRequested.has(runId) ? 'INTERRUPTED' : 'CANCELLED';
      this.options.emitRun(runId, 'run.completed', { status }, status);
    } else if (!isTerminalRunStatus(run.status)) return false;
    this.options.codex().execution.runs.delete(runId);
    this.options.state.active.delete(runId);
    return true;
  }

  private respondCodexUserInput(
    runId: string,
    requestId: string,
    rawAnswers: Record<string, unknown>
  ): void {
    const codex = this.options.codex();
    const pendingKey = `${runId}\0${requestId}`;
    const pending = codex.execution.userInputs.get(pendingKey);
    if (
      pending === undefined ||
      pending.runId !== runId ||
      this.options.runtime.getRun(runId) === undefined
    )
      throw new Error('USER_INPUT_NOT_FOUND');
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of pending.questions)
      answers[question.id] = {
        answers: this.answers(rawAnswers[question.id], question.allowOther, (value) =>
          question.options.includes(value)
        )
      };
    codex.respond(pending.requestId, { answers }, runId);
    codex.execution.userInputs.delete(pendingKey);
    this.options.emitItem(runId, {
      itemId: boundedConversationItemId('codex-input', requestId),
      kind: 'user_input_request',
      status: 'COMPLETED',
      payload: { requestId, questions: [] },
      merge: true
    });
  }

  private answers(
    raw: unknown,
    allowOther: boolean,
    supported: (value: string) => boolean
  ): string[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8)
      throw new Error('USER_INPUT_INVALID');
    return raw.map((value) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > 500)
        throw new Error('USER_INPUT_INVALID');
      if (!allowOther && !supported(value)) throw new Error('USER_INPUT_INVALID');
      return value;
    });
  }
}
