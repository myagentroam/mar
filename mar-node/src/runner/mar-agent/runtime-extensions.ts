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
                          : [
                              'Use Markdown links with absolute paths for key files.',
                              'For key deliverables, list their links as bullets in a separate section at the end of the final response.'
                            ].join('\n')
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
