import type {
  ManagementPageMetadata,
  NotificationTarget,
  ScheduledNewSession,
  ScheduledTarget,
  ScheduledTaskTargetKind,
  ScheduledTrigger
} from '@myagentroam/protocol';
import type { RunnerProfile, Session, Workspace } from '../model/workbench.js';

export type ScheduleRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export interface ScheduleInvalidation {
  nodeId?: string;
  workspaceId?: string;
  verify?: boolean;
  connectionOnly?: true;
}
export interface ScheduleScope {
  nodeId: string;
  workspaceId: string;
}
export interface ScheduleWorkspaceOption extends ScheduleScope {
  nodeName: string;
  workspaceName: string;
}
export interface ScheduleSessionScope extends ScheduleScope {
  sessionId: string;
}
export interface ScheduleTaskKey extends ScheduleScope {
  id: string;
}
export interface ScheduleTaskLink extends ScheduleTaskKey {
  reference: Extract<NotificationTarget, { targetType: 'SCHEDULED_TASK' }>['reference'];
}
export interface ScheduleNode {
  id: string;
  name: string;
  connected: boolean;
  supported?: boolean;
  newSessionSupported?: boolean;
  hourlySupported?: boolean;
}
export interface ScheduleCard extends ScheduleTaskKey {
  name: string;
  nodeName: string;
  workspaceName: string;
  sessionTitle?: string | null;
  sessionId: string | null;
  targetKind: ScheduledTaskTargetKind;
  mine: boolean;
  ownerName: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  objectivePreview?: string;
  syncedAt?: number;
  offline?: boolean;
}
export interface ScheduleTask {
  id: string;
  name: string;
  objective: string;
  triggers: ScheduledTrigger[];
  timezone: string;
  sessionId: string | null;
  newSession: ScheduledNewSession | null;
  revision: number;
  enabled: boolean;
  notifyOnTerminal: boolean;
  graceMinutes: number;
}
export interface ScheduleProposal {
  id: string;
  baseRevision: number;
  name: string | null;
  objective: string | null;
  triggers: ScheduledTrigger[] | null;
}
export interface ScheduleDetail {
  task: ScheduleTask;
  mine: boolean;
  proposals: ScheduleProposal[];
}
export interface ScheduleOccurrence extends ScheduleScope {
  nodeName: string;
  workspaceName: string;
  occurrenceId: string;
  taskId: string;
  name: string | null;
  dueAt: number;
  state: string;
  reason: string | null;
  startedAt: number | null;
  endedAt: number | null;
  run: { sessionId: string; runId: string } | null;
}
export interface ScheduleOccurrenceDetail extends Omit<
  ScheduleOccurrence,
  'nodeId' | 'workspaceId' | 'nodeName' | 'workspaceName'
> {
  snapshot: {
    name?: string;
    revision?: number;
    objective?: string;
    matchedTriggers?: number[];
  } | null;
}
export interface ScheduleRunReceipt {
  id: string;
  status: string;
}
export interface ScheduleDraft {
  name: string;
  objective: string;
  triggers: ScheduledTrigger[];
  target: ScheduledTarget;
  enabled: boolean;
  notifyOnTerminal: boolean;
  graceMinutes: number;
}
/** Encodes resource addresses and keeps HTTP DTOs out of the editor and panel. */
export function scheduledTaskClient(request: ScheduleRequest) {
  const tasks = '/api/scheduled-tasks';
  const occurrences = '/api/scheduled-occurrences';
  const query = (input: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) params.set(key, String(value));
    return params.size ? `?${params}` : '';
  };
  const scope = ({ nodeId, workspaceId }: ScheduleScope) => ({ nodeId, workspaceId });
  const taskPath = (id: string) => `${tasks}/${encodeURIComponent(id)}`;
  const json = (method: string, body: object): RequestInit => ({
    method,
    body: JSON.stringify(body)
  });
  return {
    list: (
      filters: {
        mine: boolean;
        page: number;
        target?: ScheduleScope & { sessionId?: string };
      },
      signal: AbortSignal
    ) =>
      request<
        ManagementPageMetadata & {
          items: ScheduleCard[];
          unavailableNodeIds: string[];
          nodes: ScheduleNode[];
          workspaces?: ScheduleWorkspaceOption[];
        }
      >(`${tasks}${query({ ...filters.target, mine: filters.mine, page: String(filters.page) })}`, {
        signal
      }),
    detail: (key: ScheduleTaskKey, signal: AbortSignal) =>
      request<ScheduleDetail>(`${taskPath(key.id)}${query(scope(key))}`, { signal }),
    history: (
      filters: {
        task?: ScheduleTaskKey;
        workspace?: ScheduleScope;
        page: number;
      },
      signal: AbortSignal
    ) =>
      request<
        ManagementPageMetadata & {
          items: ScheduleOccurrence[];
          unavailableNodeIds: string[];
          workspaces?: ScheduleWorkspaceOption[];
        }
      >(
        `${occurrences}${query({ ...(filters.task ? { ...scope(filters.task), taskId: filters.task.id } : filters.workspace ? scope(filters.workspace) : {}), mine: false, page: String(filters.page) })}`,
        { signal }
      ),
    occurrence: (item: ScheduleScope & { occurrenceId: string }, signal: AbortSignal) =>
      request<ScheduleOccurrenceDetail>(
        `${occurrences}/${encodeURIComponent(item.occurrenceId)}${query(scope(item))}`,
        { signal }
      ),
    async runReceipt(
      target: ScheduleScope,
      run: { runId: string; sessionId: string },
      signal: AbortSignal
    ): Promise<ScheduleRunReceipt | undefined> {
      try {
        const result = await request<{
          run: { id: string; sessionId: string; workspaceId: string; status: string };
        }>(`/api/agent-runs/${encodeURIComponent(run.runId)}${query(scope(target))}`, {
          signal
        });
        if (
          result.run.id === run.runId &&
          result.run.sessionId === run.sessionId &&
          result.run.workspaceId === target.workspaceId
        )
          return { id: result.run.id, status: result.run.status };
      } catch {
        // The occurrence remains useful even when its original Run cannot be read.
      }
    },
    workspaces: (nodeId: string, signal: AbortSignal) =>
      request<{ workspaces: Workspace[] }>(`/api/workspaces${query({ nodeId })}`, { signal }),
    sessions: (target: ScheduleScope, signal: AbortSignal, cursor?: string) =>
      request<{ sessions: Session[]; nextCursor: string | null }>(
        `/api/agent-sessions${query({ ...scope(target), registeredOnly: true, sessionGroup: 'MAIN', limit: '50', cursor })}`,
        { signal }
      ),
    profiles: (target: ScheduleScope, signal: AbortSignal) =>
      request<{ profiles: RunnerProfile[] }>(`/api/runner-profiles${query(scope(target))}`, {
        signal
      }),
    preview: (
      target: ScheduleScope,
      fields: {
        triggers?: ScheduledTrigger[] | undefined;
        taskId?: string | undefined;
        suggestTime?: string | undefined;
      },
      signal: AbortSignal
    ) =>
      request<{ timezone: string; times: { dueAt: number }[]; suggestedDate?: string }>(
        `${tasks}/preview`,
        {
          ...json('POST', { ...scope(target), ...fields }),
          signal
        }
      ),
    create: (target: ScheduleScope, draft: ScheduleDraft) =>
      request(tasks, json('POST', { ...scope(target), ...draft })),
    update: (key: ScheduleTaskKey, expectedRevision: number, patch: Partial<ScheduleDraft>) =>
      request(taskPath(key.id), json('PUT', { ...scope(key), expectedRevision, patch })),
    remove: (key: ScheduleTaskKey, expectedRevision: number) =>
      request(taskPath(key.id), json('DELETE', { ...scope(key), expectedRevision })),
    resolve: (key: ScheduleTaskKey, proposalId: string, accept: boolean) =>
      request(
        `${taskPath(key.id)}/proposals/${encodeURIComponent(proposalId)}/resolve`,
        json('POST', { ...scope(key), accept })
      )
  };
}
