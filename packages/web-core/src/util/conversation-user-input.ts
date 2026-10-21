import { conversationPayload } from './conversation-history.js';

export function userInputQuestions(payload: unknown): readonly {
  readonly id: string;
  readonly prompt: string;
  readonly input: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'SHORT_TEXT';
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly allowOther: boolean;
  readonly multiSelect: boolean;
}[] {
  const value = conversationPayload(payload);
  if (value === undefined || !Array.isArray(value.questions)) return [];
  return value.questions.flatMap((question) => {
    const record = conversationPayload(question);
    if (record === undefined || typeof record.id !== 'string' || typeof record.prompt !== 'string')
      return [];
    const input =
      record.input === 'MULTI_SELECT' || record.input === 'SHORT_TEXT'
        ? record.input
        : 'SINGLE_SELECT';
    return [
      {
        id: record.id,
        prompt: record.prompt,
        input,
        multiSelect: input === 'MULTI_SELECT',
        options: Array.isArray(record.options)
          ? record.options.flatMap((option) => {
              const optionRecord = conversationPayload(option);
              return optionRecord !== undefined &&
                typeof optionRecord.value === 'string' &&
                typeof optionRecord.label === 'string'
                ? [
                    {
                      value: optionRecord.value,
                      label: optionRecord.label,
                      description:
                        typeof optionRecord.description === 'string'
                          ? optionRecord.description
                          : null
                    }
                  ]
                : [];
            })
          : [],
        allowOther: record.allowOther === true
      }
    ];
  });
}
