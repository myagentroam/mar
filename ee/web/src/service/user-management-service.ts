import {
  createManagementPageService,
  parseManagementPage
} from '@myagentroam/web-core/management-page';

export interface UserManagementQuery {
  readonly keyword?: string | undefined;
  readonly role?: string | undefined;
  readonly organizationId?: number | undefined;
  readonly status?: 'enabled' | 'disabled' | undefined;
  readonly sortBy?: string | undefined;
  readonly sortOrder?: 'asc' | 'desc' | undefined;
}

export function createUserManagementService<T extends { readonly id: number }>(input: {
  readonly request: <Response>(path: string, init?: RequestInit) => Promise<Response>;
  readonly endpoint: '/api/management/users' | '/api/enterprise/users';
  readonly query: () => UserManagementQuery;
  readonly reportError: (error: unknown) => void;
}) {
  const context = () => JSON.stringify(input.query());
  return createManagementPageService<T>({
    read: async (page) => {
      const parameters = new URLSearchParams({ page: String(page), limit: '20' });
      for (const [key, value] of Object.entries(input.query()))
        if (value !== undefined && value !== '') parameters.set(key, String(value));
      return parseManagementPage<T>(
        await input.request<unknown>(`${input.endpoint}?${parameters.toString()}`),
        'users'
      );
    },
    key: (user) => user.id,
    context,
    reportError: input.reportError
  });
}
