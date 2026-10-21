export function expandGeneratedMessages(
  flat: Readonly<Record<string, string>>
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const messages: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(flat)) {
    const separator = key.indexOf('.');
    if (separator < 1) throw new Error(`INVALID_GENERATED_MESSAGE_KEY:${key}`);
    const namespace = key.slice(0, separator);
    const name = key.slice(separator + 1);
    (messages[namespace] ??= {})[name] = value;
  }
  return messages;
}
