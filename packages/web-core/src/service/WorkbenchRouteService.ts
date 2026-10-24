import type { Ref } from 'vue';
import type { WorkbenchView } from '../util/workbench-route.js';
import { parseWorkbenchRoute } from '../util/workbench-route.js';
import {
  createWorkbenchSelectionPersistenceService,
  type WorkbenchSelectionPersistenceOptions
} from './WorkbenchSelectionPersistenceService.js';

interface WorkbenchRouteServiceOptions extends Omit<
  WorkbenchSelectionPersistenceOptions,
  'isWorkbenchActive'
> {
  readonly selectedHostedNodeId?: Ref<string | undefined>;
  readonly selectedHostedConversationId?: Ref<string | undefined>;
  readonly view: Ref<WorkbenchView>;
  readonly managementSection: Readonly<Ref<string>>;
}

export function createWorkbenchRouteService(options: WorkbenchRouteServiceOptions) {
  const { restore, restoreSession, persist } = createWorkbenchSelectionPersistenceService({
    ...options,
    isWorkbenchActive: () => options.view.value === 'nodes'
  });
  const hostedConversationRoute = parseWorkbenchRoute(window.location).hostedConversation;

  function sync(): void {
    persist();
    const url = new URL(window.location.href);
    if (options.view.value === 'nodes') {
      url.searchParams.delete('view');
      url.searchParams.delete('management');
      url.searchParams.delete('skill');
      url.searchParams.delete('node');
      url.searchParams.delete('conversation');
      window.history.replaceState(
        window.history.state,
        '',
        `${url.pathname}${url.search}${url.hash}`
      );
      return;
    }
    url.searchParams.set('view', options.view.value);
    if (options.view.value === 'management')
      url.searchParams.set('management', options.managementSection.value);
    else url.searchParams.delete('management');
    url.searchParams.delete('skill');
    if (options.view.value === 'conversations') {
      const nodeId = options.selectedHostedNodeId?.value;
      const conversationId = options.selectedHostedConversationId?.value;
      if (nodeId !== undefined && conversationId !== undefined) {
        url.searchParams.set('node', nodeId);
        url.searchParams.set('conversation', conversationId);
      } else {
        url.searchParams.delete('node');
        url.searchParams.delete('conversation');
      }
    } else {
      url.searchParams.delete('node');
      url.searchParams.delete('conversation');
    }
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`
    );
  }

  return { restore, restoreSession, sync, hostedConversationRoute };
}
