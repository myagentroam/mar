import { THOUGHT_TOOL_NAME } from '../runtime/context/thought-contract.js';

export function toolUsagePrompt(
  tools: readonly string[],
  directTools: readonly string[] = tools
): string {
  const names = new Set(tools);
  const clauses = [
    `# Tools and execution\nAvailable client tools: ${directTools.join(', ')}.`,
    'Use the tool descriptions and schemas for calling conventions, limits, results, and recovery. Respect dependencies and side effects when combining operations.'
  ];

  if (names.has('code_exec')) {
    const direct = new Set(directTools);
    const programmatic = tools.filter((name) => !direct.has(name));
    if (programmatic.length > 0)
      clauses.push(
        `Code Mode Only: ${programmatic.join(', ')} are callable only as tools.NAME inside code_exec.`
      );
    clauses.push(
      'Tools exposed in both modes may use either permitted entry point; direct-only controls remain direct.'
    );
  }

  if (names.has('exec'))
    clauses.push(
      'You can use the built-in rg through exec to search file contents or rg --files to list file paths.'
    );

  const execution = clauses.join(' ');
  if (!directTools.includes(THOUGHT_TOOL_NAME)) return execution;

  return `${execution}

<reasoning>
During extended reasoning, earlier insights may be lost if left unrecorded.

When you reach a conclusion useful for later reasoning - such as confirming a hypothesis, ruling out an approach, or making a decision - use \`thought\` to record it and its key evidence before moving on.

Skip trivial observations. Do not repeat conclusions already recorded with their supporting evidence.
</reasoning>`;
}
