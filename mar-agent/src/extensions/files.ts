import type { ExtensionOperationContext } from './operation.js';

import type { ExtensionHooks } from './hooks.js';
import { AgentError } from '../error.js';

export type ExtensionFileType = 'file' | 'directory' | 'symlink' | 'other';
export interface ExtensionFilePath {
  readonly path: string;
}
export interface ExtensionFileInfo {
  readonly path: string;
  readonly type: ExtensionFileType;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly createdAtMs: number;
}
export interface ExtensionFileEntry {
  readonly name: string;
  readonly type: ExtensionFileType;
}
export interface ExtensionFileWrite extends ExtensionFilePath {
  readonly bytes: Uint8Array;
  readonly createParents?: boolean;
}
export interface ExtensionFileRemove extends ExtensionFilePath {
  readonly recursive?: boolean;
  readonly force?: boolean;
}
export interface ExtensionFileTransfer {
  readonly from: string;
  readonly to: string;
}
export interface ExtensionFilesApi {
  read(input: ExtensionFilePath): Promise<Uint8Array>;
  write(input: ExtensionFileWrite): Promise<{ readonly bytesWritten: number }>;
  stat(input: ExtensionFilePath): Promise<ExtensionFileInfo>;
  list(input: ExtensionFilePath): Promise<readonly ExtensionFileEntry[]>;
  mkdir(input: ExtensionFilePath & { readonly recursive?: boolean }): Promise<void>;
  remove(input: ExtensionFileRemove): Promise<void>;
  move(input: ExtensionFileTransfer): Promise<void>;
  copy(input: ExtensionFileTransfer): Promise<void>;
}
type Input<Name extends keyof ExtensionFilesApi> = Parameters<ExtensionFilesApi[Name]>[0];
type Output<Name extends keyof ExtensionFilesApi> = Awaited<ReturnType<ExtensionFilesApi[Name]>>;
export type ExtensionFilesBackend = {
  [Name in keyof ExtensionFilesApi]: (
    input: Input<Name>,
    call: ExtensionOperationContext
  ) => Promise<Output<Name>>;
};
export type ExtensionFileOperations = {
  [Name in keyof ExtensionFilesApi as `files.${Name}`]: {
    input: Input<Name>;
    output: Output<Name>;
  };
};
export type ExtensionFileCompletion = {
  [Name in keyof ExtensionFilesApi]: {
    readonly operation: Name;
    readonly input: Input<Name>;
    readonly output: Output<Name>;
  };
}[keyof ExtensionFilesApi];

export function bindCoreFiles(
  backend: ExtensionFilesBackend,
  run: <Value>(operation: (call: ExtensionOperationContext) => Promise<Value>) => Promise<Value>,
  hooks: Pick<ExtensionHooks<DomainFileOperations, DomainFileFacts>, 'invoke' | 'emit'>
): ExtensionFilesApi {
  const invoke = <Name extends keyof ExtensionFilesApi>(
    name: Name,
    input: Input<Name>
  ): Promise<Output<Name>> =>
    run((call) => {
      const handler = backend[name] as (
        input: Input<Name>,
        call: ExtensionOperationContext
      ) => Promise<Output<Name>>;
      if (typeof handler !== 'function')
        throw new AgentError(
          'MAR_AGENT_HOST_PORT_UNAVAILABLE',
          'Native file port is unavailable.',
          { details: { operation: name } }
        );
      return hooks.invoke(
        `files.${name}`,
        input,
        call,
        async (input, effective): Promise<DomainFileOperations[`files.${Name}`]['output']> => {
          const factInput =
            input && 'bytes' in input && input.bytes instanceof Uint8Array
              ? { ...input, bytes: new Uint8Array(input.bytes) }
              : { ...input };
          const output = await handler.call(backend, input as Input<Name>, effective);
          await hooks.emit(
            'files.completed',
            { operation: name, input: factInput, output } as ExtensionFileCompletion,
            effective
          );
          return output as DomainFileOperations[`files.${Name}`]['output'];
        }
      ) as Promise<Output<Name>>;
    });
  return {
    read: (input) => invoke('read', input),
    write: (input) => invoke('write', input),
    stat: (input) => invoke('stat', input),
    list: (input) => invoke('list', input),
    mkdir: (input) => invoke('mkdir', input),
    remove: (input) => invoke('remove', input),
    move: (input) => invoke('move', input),
    copy: (input) => invoke('copy', input)
  };
}

export interface DomainFileOperations extends ExtensionFileOperations {}
export interface DomainFileFacts {
  'files.completed': ExtensionFileCompletion;
}
