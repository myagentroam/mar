import { computed, ref, type Ref } from 'vue';
import { translate } from './LocalePreferenceService.js';

export interface WorkspaceDirectoryEntry {
  readonly path: string;
  readonly name: string;
  readonly selectable: boolean;
}

export interface WorkspaceDirectoryListing {
  readonly homePath: string;
  readonly currentPath: string;
  readonly parentPath: string | null;
  readonly browseRoots: readonly string[];
  readonly selectable: boolean;
  readonly entries: readonly WorkspaceDirectoryEntry[];
  readonly truncated: boolean;
}

export interface WorkspaceRegistrationInput {
  readonly nodeId: string;
  readonly path: string;
  readonly createDirectoryName?: string;
  readonly preserveGitConfig?: boolean;
}

export function createWorkspaceRegistrationService<Context = void>(options: {
  readonly submit?: (
    input: WorkspaceRegistrationInput,
    context: Context | undefined
  ) => Promise<unknown>;
  readonly targetNodeId: Ref<string | undefined>;
  readonly globalLoading: Ref<boolean>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly onRegistered: (nodeId: string, workspaceId: string) => Promise<void>;
  readonly notice: (message: string) => void;
  readonly error: (message: string) => void;
  readonly errorMessage: (error: unknown) => string;
}) {
  const path = ref('');
  const preserveGitConfig = ref(false);
  const pendingDirectoryName = ref('');
  const directory = ref<WorkspaceDirectoryListing>();
  const loadingDirectory = ref(false);
  const openTools = ref<string[]>([]);
  let directoryRequestRevision = 0;

  const selectedPathValid = computed(() => {
    const current = directory.value;
    if (current === undefined || path.value.length === 0) return false;
    if (pendingDirectoryName.value.length > 0)
      return (
        current.selectable &&
        path.value === joinDirectoryPath(current.currentPath, pendingDirectoryName.value)
      );
    if (path.value === current.currentPath) return current.selectable;
    return current.entries.some((entry) => entry.path === path.value && entry.selectable);
  });

  function reset(openPicker = false): void {
    directoryRequestRevision += 1;
    path.value = '';
    preserveGitConfig.value = false;
    pendingDirectoryName.value = '';
    directory.value = undefined;
    loadingDirectory.value = false;
    openTools.value = openPicker ? ['register'] : [];
  }

  async function load(nextPath?: string): Promise<void> {
    const nodeId = options.targetNodeId.value;
    if (nodeId === undefined) return;
    const revision = ++directoryRequestRevision;
    loadingDirectory.value = true;
    pendingDirectoryName.value = '';
    path.value = '';
    try {
      const query = new URLSearchParams({ nodeId });
      if (nextPath !== undefined) query.set('path', nextPath);
      const result = (
        await options.request<{ directory: WorkspaceDirectoryListing }>(
          `/api/workspace-directories?${query.toString()}`
        )
      ).directory;
      if (revision !== directoryRequestRevision || options.targetNodeId.value !== nodeId) return;
      directory.value = result;
      path.value = '';
    } catch (error) {
      if (revision !== directoryRequestRevision || options.targetNodeId.value !== nodeId) return;
      options.error(
        translate('generated.workspaceRegistrationService.unableToLoadAvailableDirectories', {
          value0: options.errorMessage(error)
        })
      );
    } finally {
      if (revision === directoryRequestRevision) loadingDirectory.value = false;
    }
  }

  function select(nextPath: string): void {
    pendingDirectoryName.value = '';
    path.value = nextPath;
  }

  function selectPendingDirectory(directoryName: string): void {
    const current = directory.value;
    if (current === undefined) return;
    pendingDirectoryName.value = directoryName;
    path.value = joinDirectoryPath(current.currentPath, directoryName);
  }

  function discardPendingDirectory(): void {
    if (pendingDirectoryName.value.length === 0) return;
    pendingDirectoryName.value = '';
    path.value = '';
  }

  async function register(context?: Context): Promise<void> {
    const nodeId = options.targetNodeId.value;
    const selectedPath = path.value.trim();
    if (nodeId === undefined || selectedPath.length === 0) return;
    const parentPath = directory.value?.currentPath;
    if (pendingDirectoryName.value.length > 0 && parentPath === undefined) return;
    options.globalLoading.value = true;
    options.notice('');
    try {
      const input: WorkspaceRegistrationInput = {
        nodeId,
        path: pendingDirectoryName.value.length > 0 ? parentPath! : selectedPath,
        preserveGitConfig: preserveGitConfig.value,
        ...(pendingDirectoryName.value.length > 0
          ? { createDirectoryName: pendingDirectoryName.value }
          : {})
      };
      const result = (
        options.submit !== undefined
          ? await options.submit(input, context)
          : await options.request('/api/workspaces', {
              method: 'POST',
              body: JSON.stringify(input)
            })
      ) as { workspace?: { id?: unknown } };
      const workspaceId = result?.workspace?.id;
      if (typeof workspaceId !== 'string') throw new Error('WORKSPACE_REGISTER_RESPONSE_INVALID');
      if (options.targetNodeId.value !== nodeId) return;
      reset();
      await options.onRegistered(nodeId, workspaceId);
    } catch (error) {
      options.error(registrationFailureMessage(options.errorMessage(error)));
    } finally {
      options.globalLoading.value = false;
    }
  }

  return {
    path,
    preserveGitConfig,
    pendingDirectoryName,
    directory,
    loadingDirectory,
    openTools,
    selectedPathValid,
    reset,
    load,
    select,
    selectPendingDirectory,
    discardPendingDirectory,
    register
  };
}

function joinDirectoryPath(parent: string, name: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/u, '')}${separator}${name}`;
}

function registrationFailureMessage(code: string): string {
  if (code === 'WORKSPACE_DIRECTORY_EXISTS')
    return translate('generated.workspaceRegistrationService.aDirectoryWithThisNameAlreadyExists');
  if (code === 'WORKSPACE_DIRECTORY_NAME_INVALID')
    return translate('generated.workspaceRegistrationService.theDirectoryNameIsInvalidEnterA');
  if (code === 'WORKSPACE_DIRECTORY_NOT_ALLOWED' || code === 'WORKSPACE_NOT_ALLOWED')
    return translate(
      'generated.workspaceRegistrationService.theSelectedDirectoryIsOutsideTheWorkspace'
    );
  return translate('generated.workspaceRegistrationService.unableToRegisterTheWorkspace', {
    value0: code
  });
}
