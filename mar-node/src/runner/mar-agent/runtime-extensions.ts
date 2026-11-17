import type { ExtensionSource } from '@myagentroam/agent/extensions';
import { marAgentCompactExtensionSource, type MarAgentCompactState } from './compact-extensions.js';

export function marAgentRuntimeExtensionSource(state: MarAgentCompactState): ExtensionSource {
  const compactSource = marAgentCompactExtensionSource(state);
  return {
    async resolve(request) {
      const snapshot = await compactSource.resolve(request);
      return {
        ...snapshot,
        extensions: [
          ...snapshot.extensions,
          {
            id: 'mar.node.file-links',
            apiVersion: '1.0',
            attachSession(context) {
              context.hooks.intercept('prompt.sections', (input, _call, next) =>
                next({
                  ...input,
                  sections: [
                    ...input.sections,
                    {
                      id: 'mar.node.file-links',
                      text:
                        input.facts?.mode === 'compact'
                          ? null
                          : 'When mentioning key files changed in this task, prefer Markdown links to their absolute paths for easy preview.'
                    }
                  ]
                })
              );
            }
          }
        ]
      };
    }
  };
}
