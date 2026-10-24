import { ref } from 'vue';
import {
  sessionShareSchema,
  sessionSharePasswordSchema,
  type SessionShare,
  type SessionShareTarget
} from '@myagentroam/protocol';

export function createSessionShareManagementService(
  target: SessionShareTarget,
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const shares = ref<SessionShare[]>([]);
  const created = ref<{ share: SessionShare; password: string }>();
  const busy = ref(false);
  const base = `/api/agent-sessions/${encodeURIComponent(target.sessionId)}/shares`;
  const query = new URLSearchParams({ nodeId: target.nodeId, workspaceId: target.workspaceId });
  async function load(): Promise<void> {
    const result = await request<{ shares: unknown }>(`${base}?${query}`);
    shares.value = sessionShareSchema.array().parse(result.shares);
  }
  async function create(expiresAt: string | null): Promise<void> {
    busy.value = true;
    try {
      const response = await request<{ share: unknown; password: unknown }>(base, {
        method: 'POST',
        body: JSON.stringify({ nodeId: target.nodeId, workspaceId: target.workspaceId, expiresAt })
      });
      const result = {
        share: sessionShareSchema.parse(response.share),
        password: sessionSharePasswordSchema.parse(response.password)
      };
      created.value = result;
      shares.value = [result.share, ...shares.value];
    } finally {
      busy.value = false;
    }
  }
  async function remove(id: string): Promise<void> {
    busy.value = true;
    try {
      await request(`${base}/${encodeURIComponent(id)}?${query}`, { method: 'DELETE' });
      shares.value = shares.value.filter((share) => share.id !== id);
      if (created.value?.share.id === id) created.value = undefined;
    } finally {
      busy.value = false;
    }
  }
  async function copyPassword(id: string, password?: string): Promise<string | null> {
    const result = await request<{ password: unknown }>(
      `${base}/${encodeURIComponent(id)}/copy?${query}`,
      {
        method: 'POST',
        body: JSON.stringify(password === undefined ? {} : { password })
      }
    );
    return sessionSharePasswordSchema.nullable().parse(result.password);
  }
  return { shares, created, busy, load, create, remove, copyPassword };
}
