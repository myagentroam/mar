export interface PromptPart {
  readonly id: string;
  readonly text: string | null;
  readonly scope?: 'shared' | 'session';
}
export function renderPromptSections(sections: readonly PromptPart[]): string {
  return sections
    .map((part) => part.text)
    .filter(Boolean)
    .join('\n\n');
}
