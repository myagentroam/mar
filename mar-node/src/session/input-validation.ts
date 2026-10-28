import { composerVisibleText } from '@myagentroam/protocol';

export function validSessionOption(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length > 0 && value.length <= 120)
  );
}

export function validSessionEffort(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 120);
}

export function validSessionTitle(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim().length > 0 && value.length <= 160)
  );
}

export function sessionTitleFromFirstMessage(content: string): string {
  return composerVisibleText(content).replace(/\s+/g, ' ').slice(0, 160);
}
