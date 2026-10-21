import { parseManagementPage } from './ManagementPageService.js';
import type { ManagementPage } from '@myagentroam/protocol';
import { translate } from './LocalePreferenceService.js';

export type EnvironmentSecretScope = 'PERSONAL' | 'NODE' | 'WORKSPACE';

const ENVIRONMENT_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;

export function environmentSecretNameError(name: string): string | undefined {
  if (name.length === 0)
    return translate('generated.environmentSecretService.enterAnEnvironmentVariableName');
  if (name.length > 128)
    return translate(
      'generated.environmentSecretService.theEnvironmentVariableNameCannotExceed128'
    );
  if (!/^[A-Za-z_]/u.test(name))
    return translate('generated.environmentSecretService.theEnvironmentVariableNameMustStartWith');
  if (!ENVIRONMENT_SECRET_NAME.test(name))
    return translate('generated.environmentSecretService.theEnvironmentVariableNameCanContainOnly');
  return undefined;
}

export function environmentSecretValueError(value: string): string | undefined {
  if (value.length === 0) return translate('generated.environmentSecretService.enterASecretValue');
  if (value.includes('\0'))
    return translate(
      'generated.environmentSecretService.theSecretValueCannotContainNullCharacters'
    );
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES)
    return translate('generated.environmentSecretService.theSecretValueCannotExceed16KiB');
  return undefined;
}

export interface EnvironmentSecretSummary<Scope extends string = EnvironmentSecretScope> {
  readonly id: string;
  readonly scope: Scope;
  readonly name: string;
  readonly value: string;
  readonly nodeId: string | null;
  readonly workspaceId?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EnvironmentSecretInput<Scope extends string = EnvironmentSecretScope> {
  readonly scope: Scope;
  readonly name: string;
  readonly value: string;
  readonly nodeId?: string;
  readonly workspaceId?: string;
}

export interface EnvironmentSecretService<
  Summary extends EnvironmentSecretSummary<string> = EnvironmentSecretSummary,
  Input extends EnvironmentSecretInput<string> = EnvironmentSecretInput
> {
  listPage(
    page: number,
    filters: Readonly<Record<string, string | undefined>>
  ): Promise<ManagementPage<Summary>>;
  list(nodeId?: string, workspaceId?: string): Promise<{ readonly secrets: readonly Summary[] }>;
  create(input: Input): Promise<void>;
  replace(id: string, value: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export function createEnvironmentSecretService<
  Summary extends EnvironmentSecretSummary<string> = EnvironmentSecretSummary,
  Input extends EnvironmentSecretInput<string> = EnvironmentSecretInput
>(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
): EnvironmentSecretService<Summary, Input> {
  return {
    async listPage(page, filters) {
      const query = new URLSearchParams({ page: String(page), limit: '20' });
      for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
      return parseManagementPage<Summary>(
        await request<unknown>(`/api/environment-secrets?${query}`),
        'secrets'
      );
    },
    list: (nodeId, workspaceId) =>
      request(
        nodeId === undefined
          ? '/api/environment-secrets'
          : `/api/environment-secrets?nodeId=${encodeURIComponent(nodeId)}${workspaceId === undefined ? '' : `&workspaceId=${encodeURIComponent(workspaceId)}`}`
      ),
    async create(input) {
      await request('/api/environment-secrets', { method: 'POST', body: JSON.stringify(input) });
    },
    async replace(id, value) {
      await request(`/api/environment-secrets/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ value })
      });
    },
    async remove(id) {
      await request(`/api/environment-secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
  };
}
