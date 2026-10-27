import { markupAttributes, markupText } from '../prompts/markup.js';

// Render message placeholders only; structured GC records keep their JSON shape.
export function contextGcMarkup(kind: string, fields: Record<string, unknown>): string {
  const attributes: Record<string, unknown> = { kind };
  const children: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'retainedInputs' && Array.isArray(value)) {
      for (const input of value)
        children.push(
          markupText('retained_input', typeof input === 'string' ? input : JSON.stringify(input))
        );
    } else if (key === 'contextGc') children.push(markupText('instruction', String(value)));
    else attributes[key] = value;
  }
  const opening = `<mar_context_gc${markupAttributes(attributes)}`;
  return children.length
    ? [opening + '>', ...children.map((child) => '  ' + child), '</mar_context_gc>'].join('\n')
    : opening + ' />';
}
