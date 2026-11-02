import type { ClientToolDefinition } from '../contracts.js';

import { randomUUID } from 'node:crypto';
import { AgentError } from '../../error.js';
import type { ToolRuntimeContext } from '../runtime-context.js';
import { TOOL_EXECUTION_LIMITS } from '../execution-limits.js';

export const questionToolDefinition: ClientToolDefinition = {
  name: 'question',
  allowedCallers: ['direct'],
  parallelSafety: 'safe',
  description:
    'Pause for one to three tightly related user-owned decisions that materially change the result and cannot be inferred from the request, conversation, or relevant safe discovery. Prefer asking over guessing in Plan mode; do not avoid clarification by inventing configuration, branches, abstractions, or support for multiple outcomes. Provide 2-3 mutually exclusive options with consequences, put the recommended option first and identify it in its label or description, and use another question round if key ambiguity remains. This is not a permission/approval tool and should not interrupt routine in-scope work.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            header: { type: 'string' },
            question: {
              type: 'string',
              maxLength: TOOL_EXECUTION_LIMITS.questionMaxTextCharacters
            },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              description:
                'Provide 2-3 mutually exclusive choices with consequences. Put the recommended option first and identify it in its label or description.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', maxLength: 80 },
                  description: {
                    type: 'string',
                    maxLength: TOOL_EXECUTION_LIMITS.questionMaxOptionCharacters
                  }
                },
                required: ['label', 'description'],
                additionalProperties: false
              }
            }
          },
          required: ['id', 'header', 'question', 'options'],
          additionalProperties: false
        }
      }
    },
    required: ['questions'],
    additionalProperties: false
  }
};

export async function executeQuestion(arguments_: unknown, context: ToolRuntimeContext) {
  const value = parseQuestionInput(arguments_);
  if (!context.host.requestUserInput)
    throw new AgentError(
      'MAR_AGENT_TOOL_INPUT_INVALID',
      'Question Host capability is unavailable.'
    );
  const requestId = randomUUID();
  await context.emit({ type: 'user_input.requested', requestId, questions: value.questions });
  const answers = await context.host.requestUserInput(
    { requestId, questions: value.questions },
    context.signal
  );
  await context.emit({ type: 'user_input.resolved', requestId });
  if (!answers || typeof answers !== 'object' || Array.isArray(answers))
    throw new AgentError('MAR_AGENT_USER_INPUT_INVALID', 'Question answers are invalid.');
  const expectedIds = value.questions.map((question) => question.id).sort();
  const answerIds = Object.keys(answers).sort();
  if (
    expectedIds.length !== answerIds.length ||
    expectedIds.some((id, index) => id !== answerIds[index])
  )
    throw new AgentError('MAR_AGENT_USER_INPUT_INVALID', 'Question answers are incomplete.');
  if (Object.values(answers).some((answer) => typeof answer !== 'string' || !answer.trim()))
    throw new AgentError('MAR_AGENT_USER_INPUT_INVALID', 'Question answers are invalid.');
  return { content: JSON.stringify(answers), data: answers };
}

interface ParsedQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}

function parseQuestionInput(value: unknown): { questions: ParsedQuestion[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidQuestion();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'questions') || !Array.isArray(input.questions))
    return invalidQuestion();
  if (input.questions.length < 1 || input.questions.length > 3) return invalidQuestion();
  const questions = input.questions.map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question))
      return invalidQuestion();
    const record = question as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['id', 'header', 'question', 'options'].includes(key)) ||
      typeof record.id !== 'string' ||
      record.id.trim().length === 0 ||
      record.id.length > 128 ||
      typeof record.header !== 'string' ||
      record.header.trim().length === 0 ||
      record.header.length > 80 ||
      typeof record.question !== 'string' ||
      record.question.trim().length === 0 ||
      record.question.length > TOOL_EXECUTION_LIMITS.questionMaxTextCharacters ||
      !Array.isArray(record.options) ||
      record.options.length < 2 ||
      record.options.length > 3
    )
      return invalidQuestion();
    const options = record.options.map((option) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return invalidQuestion();
      const item = option as Record<string, unknown>;
      if (
        Object.keys(item).some((key) => !['label', 'description'].includes(key)) ||
        typeof item.label !== 'string' ||
        item.label.trim().length === 0 ||
        item.label.length > 80 ||
        typeof item.description !== 'string' ||
        item.description.trim().length === 0 ||
        item.description.length > TOOL_EXECUTION_LIMITS.questionMaxOptionCharacters
      )
        return invalidQuestion();
      return { label: item.label, description: item.description };
    });
    return {
      id: record.id,
      header: record.header,
      question: record.question,
      options
    };
  });
  if (new Set(questions.map((question) => question.id)).size !== questions.length)
    return invalidQuestion();
  return { questions };
}

function invalidQuestion(): never {
  throw new AgentError('MAR_AGENT_TOOL_INPUT_INVALID', 'Question input is invalid.');
}
