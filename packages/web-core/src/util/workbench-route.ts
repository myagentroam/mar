export type WorkbenchView = 'nodes' | 'conversations' | 'settings' | 'management';

const WORKBENCH_VIEWS: readonly WorkbenchView[] = [
  'nodes',
  'conversations',
  'settings',
  'management'
];
export interface WorkbenchRoute {
  readonly nodeId?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly view?: WorkbenchView;
  readonly hostedConversation?: HostedConversationRoute;
}

export interface HostedConversationRoute {
  readonly nodeId: string;
  readonly conversationId: string;
}

export function parseWorkbenchRoute(location: Pick<Location, 'search'>): WorkbenchRoute {
  const query = new URLSearchParams(location.search);
  const value = (name: string): string | undefined => query.get(name) || undefined;
  const nodeId = value('node');
  const workspaceId = value('workspace');
  const sessionId = value('session');
  const rawView = value('view');
  const conversationId = value('conversation');
  const view = WORKBENCH_VIEWS.find((candidate) => candidate === rawView);
  return {
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(view === undefined ? {} : { view }),
    ...(view === 'conversations' && nodeId !== undefined && conversationId !== undefined
      ? { hostedConversation: { nodeId, conversationId } }
      : {})
  };
}
