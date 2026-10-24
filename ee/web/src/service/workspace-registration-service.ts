import { createWorkspaceRegistrationService as createCore } from '@myagentroam/web-core/workspace-registration';
import type { WorkspaceRegistrationInput } from '@myagentroam/web-core/workspace-registration';
export type {
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryListing
} from '@myagentroam/web-core/workspace-registration';
export type WorkspaceRegistrationOwnership =
  | { readonly ownerType: 'PERSONAL' }
  | { readonly ownerType: 'ORGANIZATION'; readonly ownerOrganizationId: number };
export function createWorkspaceRegistrationService(
  options: Omit<Parameters<typeof createCore<WorkspaceRegistrationOwnership>>[0], 'submit'>
) {
  return createCore<WorkspaceRegistrationOwnership>({
    ...options,
    submit: (input, ownership) => submitWorkspaceRegistration(options.request, input, ownership)
  });
}

export function submitWorkspaceRegistration(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  input: WorkspaceRegistrationInput,
  ownership: WorkspaceRegistrationOwnership | undefined
): Promise<unknown> {
  return request('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      ...(ownership?.ownerType === 'ORGANIZATION' ? { ownership } : {})
    })
  });
}
