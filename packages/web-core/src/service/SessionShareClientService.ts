import type { SessionShareTarget } from '@myagentroam/protocol';
import type { createSessionShareAccessService } from './SessionShareAccessService.js';
import { ApiError } from '../util/api-error.js';

/** Adapts the existing conversation services, never the Workbench authentication client. */
export function createSessionShareClientService(
  access: ReturnType<typeof createSessionShareAccessService>,
  target: SessionShareTarget
) {
  function relative(path: string): string {
    const url = new URL(path, 'http://localhost');
    const session = `/api/agent-sessions/${encodeURIComponent(target.sessionId)}`;
    const workspace = `/api/workspaces/${encodeURIComponent(target.workspaceId)}`;
    let resource: string | undefined;
    if (url.pathname === session) resource = '/session';
    else if (url.pathname.startsWith(session + '/')) resource = url.pathname.slice(session.length);
    else if (url.pathname.startsWith(workspace + '/'))
      resource = url.pathname.slice(workspace.length);
    else if (url.pathname === '/api/runner-profiles') resource = '/profiles';
    else if (url.pathname === '/api/html-preview/grants') resource = '/html-preview/grants';
    else if (url.pathname.startsWith('/api/queue-items/'))
      resource = '/queue/' + url.pathname.slice('/api/queue-items/'.length);
    else if (url.pathname.startsWith('/api/agent-runs/'))
      resource = '/runs/' + url.pathname.slice('/api/agent-runs/'.length);
    if (
      resource === undefined ||
      !new RegExp(
        '^/(?:session|profiles|effective-skills|messages|interrupt|watch|turns|commands|html-preview/grants|files/(?:read|content|search|reference)|uploads(?:/[^/]+(?:/(?:chunks|complete|cancel))?)?|queue(?:/[^/]+(?:/execute)?)?|runs/[^/]+/(?:images/[^/]+|user-input/[^/]+|approvals/[^/]+/decision|interrupt))$',
        'u'
      ).test(resource)
    )
      throw new ApiError(
        'SESSION_SHARE_INPUT_INVALID',
        'This operation is not available in a shared conversation.'
      );
    url.searchParams.delete('nodeId');
    url.searchParams.delete('workspaceId');
    url.searchParams.delete('sessionId');
    return resource + (url.searchParams.size ? '?' + url.searchParams.toString() : '');
  }
  const resourceUrl = (path: string) => access.base + relative(path);
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let body = init.body;
    if (typeof body === 'string') {
      const {
        nodeId: _node,
        workspaceId: _workspace,
        sessionId: _session,
        ...value
      } = JSON.parse(body) as Record<string, unknown>;
      body = JSON.stringify(
        relative(path) === '/messages' ? { ...value, visitor: access.visitor.value } : value
      );
    }
    return access.request(relative(path), { ...init, ...(body === undefined ? {} : { body }) });
  }
  return { request, resourceUrl };
}
