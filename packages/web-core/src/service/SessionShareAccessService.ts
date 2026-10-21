import { ref } from 'vue';
import {
  sessionShareAuthResultSchema,
  sessionShareCredentialSchema,
  sessionShareVisitorSchema,
  type SessionShareAuthResult
} from '@myagentroam/protocol';
import { apiErrorFromResponse, errorCode } from '../util/api-error.js';

const terminalCodes = new Set([
  'SESSION_SHARE_NOT_FOUND',
  'SESSION_SHARE_EXPIRED',
  'SESSION_SHARE_ACCESS_INVALID',
  'NODE_NOT_AUTHORIZED'
]);

/** Owns link-scoped access and a browser-wide display identity, independent of Console authentication. */
export function createSessionShareAccessService(
  shareId: string,
  options: {
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    fetch?: typeof fetch;
  } = {}
) {
  const storage = options.storage ?? localStorage;
  const transport = options.fetch ?? fetch;
  const key = `mar:session-share:${shareId}`;
  const visitorKey = 'mar:session-share:visitor';
  const base = `/api/session-shares/${encodeURIComponent(shareId)}`;
  const session = ref<SessionShareAuthResult>();
  const invalidCode = ref<string>();
  const nameRequired = ref(false);
  let nameResolution: ((value: boolean) => void) | undefined;
  let naming: Promise<boolean> | undefined;
  function cancelName(): void {
    nameRequired.value = false;
    nameResolution?.(false);
    nameResolution = undefined;
    naming = undefined;
  }
  function ensureNamed(): Promise<boolean> {
    refreshVisitor();
    if (visitor.value.name !== undefined) return Promise.resolve(true);
    if (naming !== undefined) return naming;
    nameRequired.value = true;
    naming = new Promise((resolve) => {
      nameResolution = resolve;
    });
    return naming;
  }
  let stored: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value))
      stored = value as Record<string, unknown>;
  } catch {
    /* Storage can be disabled or contain an old value. */
  }
  let storedVisitor: unknown;
  try {
    storedVisitor = JSON.parse(storage.getItem(visitorKey) ?? 'null');
  } catch {
    /* Retain the current tab identity when browser storage is unavailable. */
  }
  const browserVisitor = sessionShareVisitorSchema.safeParse(storedVisitor);
  const parsedVisitor = browserVisitor.success
    ? browserVisitor
    : sessionShareVisitorSchema.safeParse(stored.visitor);
  const visitor = ref(
    parsedVisitor.success ? parsedVisitor.data : { visitorId: crypto.randomUUID() }
  );
  let credential = sessionShareCredentialSchema.safeParse(stored.credential).success
    ? (stored.credential as string)
    : undefined;
  let generation = 0;
  function persist(saveVisitor = false): void {
    try {
      storage.setItem(key, JSON.stringify({ credential, visitor: visitor.value }));
      if (saveVisitor) storage.setItem(visitorKey, JSON.stringify(visitor.value));
    } catch {
      /* The current tab remains usable without persistence. */
    }
  }
  persist(!browserVisitor.success);
  function refreshVisitor(): void {
    try {
      const parsed = sessionShareVisitorSchema.safeParse(
        JSON.parse(storage.getItem(visitorKey) ?? 'null')
      );
      if (!parsed.success || parsed.data.visitorId !== visitor.value.visitorId) return;
      if (visitor.value.name !== parsed.data.name) visitor.value = parsed.data;
      if (parsed.data.name !== undefined && naming !== undefined) {
        nameRequired.value = false;
        nameResolution?.(true);
        nameResolution = undefined;
        naming = undefined;
      }
    } catch {
      /* Keep the current display identity when storage is unavailable. */
    }
  }
  const browser = typeof window === 'undefined' ? undefined : window;
  const onStorage = (event: StorageEvent): void => {
    if (event.key === visitorKey) refreshVisitor();
  };
  browser?.addEventListener?.('storage', onStorage);
  function dispose(): void {
    browser?.removeEventListener?.('storage', onStorage);
    cancelName();
  }
  function invalidate(code: string): void {
    generation += 1;
    cancelName();
    session.value = undefined;
    credential = undefined;
    invalidCode.value = code;
    persist();
  }
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const current = generation;
    const response = await transport(`${base}${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers
      }
    });
    if (current !== generation) throw new DOMException('The share access changed.', 'AbortError');
    if (!response.ok) {
      const error = apiErrorFromResponse(await response.json().catch(() => ({})), response.status);
      if (
        terminalCodes.has(error.code) ||
        (path !== '/auth' && error.code === 'SESSION_SHARE_CREDENTIAL_INVALID')
      )
        invalidate(error.code);
      throw error;
    }
    const result = response.status === 204 ? undefined : await response.json();
    if (current !== generation) throw new DOMException('The share access changed.', 'AbortError');
    return result as T;
  }
  async function authenticate(password?: string): Promise<boolean> {
    if (password === undefined && credential === undefined) return false;
    try {
      const result = sessionShareAuthResultSchema.parse(
        await request('/auth', {
          method: 'POST',
          body: JSON.stringify(password === undefined ? { credential } : { password })
        })
      );
      session.value = result;
      credential = result.credential;
      invalidCode.value = undefined;
      persist();
      return true;
    } catch (error) {
      if (password === undefined && errorCode(error) === 'SESSION_SHARE_CREDENTIAL_INVALID') {
        invalidate('SESSION_SHARE_CREDENTIAL_INVALID');
        invalidCode.value = undefined;
        return false;
      }
      throw error;
    }
  }
  function setName(name: string): void {
    visitor.value = sessionShareVisitorSchema
      .required({ name: true })
      .parse({ ...visitor.value, name });
    persist(true);
    nameRequired.value = false;
    nameResolution?.(true);
    nameResolution = undefined;
    naming = undefined;
  }
  return {
    base,
    session,
    visitor,
    invalidCode,
    nameRequired,
    request,
    authenticate,
    invalidate,
    setName,
    ensureNamed,
    cancelName,
    dispose
  };
}
