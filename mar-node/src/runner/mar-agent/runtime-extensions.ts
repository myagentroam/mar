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
                          : 'When delivering images, show them inline in your final reply using `![short description](/absolute/path/to/image.png)`. ' +
                            'Use the actual absolute path to an image the user can preview in this conversation. If the user asks for links only, use plain links instead. ' +
                            'For other files, you can use `[description](/absolute/path/to/file)` when a link makes the file easier to open or preview.'
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
