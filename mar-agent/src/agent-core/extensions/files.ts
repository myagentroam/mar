import type { CoreOperationContext } from './operation.js';
import type { CoreDomainFacts, CoreDomainOperations } from './contracts.js';
import type { ExtensionHooks } from './hooks.js';
import { MarAgentError } from '../error.js';

export type CoreFileType = 'file' | 'directory' | 'symlink' | 'other';
export interface CoreFilePath {
  readonly path: string;
}
export interface CoreFileInfo {
  readonly path: string;
  readonly type: CoreFileType;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly createdAtMs: number;
}
export interface CoreFileEntry {
  readonly name: string;
  readonly type: CoreFileType;
}
export interface CoreFileWrite extends CoreFilePath {
  readonly bytes: Uint8Array;
  readonly createParents?: boolean;
}
export interface CoreFileRemove extends CoreFilePath {
  readonly recursive?: boolean;
  readonly force?: boolean;
}
export interface CoreFileTransfer {
  readonly from: string;
  readonly to: string;
}
export interface CoreFilesApi {
  read(input: CoreFilePath): Promise<Uint8Array>;
  write(input: CoreFileWrite): Promise<{ readonly bytesWritten: number }>;
  stat(input: CoreFilePath): Promise<CoreFileInfo>;
  list(input: CoreFilePath): Promise<readonly CoreFileEntry[]>;
  mkdir(input: CoreFilePath & { readonly recursive?: boolean }): Promise<void>;
  remove(input: CoreFileRemove): Promise<void>;
  move(input: CoreFileTransfer): Promise<void>;
  copy(input: CoreFileTransfer): Promise<void>;
}
type Input<Name extends keyof CoreFilesApi> = Parameters<CoreFilesApi[Name]>[0];
type Output<Name extends keyof CoreFilesApi> = Awaited<ReturnType<CoreFilesApi[Name]>>;
export type CoreFilesBackend = {
  [Name in keyof CoreFilesApi]: (
    input: Input<Name>,
    call: CoreOperationContext
  ) => Promise<Output<Name>>;
};
export type CoreFileOperations = {
  [Name in keyof CoreFilesApi as `files.${Name}`]: { input: Input<Name>; output: Output<Name> };
};
export type CoreFileCompletion = {
  [Name in keyof CoreFilesApi]: {
    readonly operation: Name;
    readonly input: Input<Name>;
    readonly output: Output<Name>;
  };
}[keyof CoreFilesApi];

export function bindCoreFiles(
  backend: CoreFilesBackend,
  run: <Value>(operation: (call: CoreOperationContext) => Promise<Value>) => Promise<Value>,
  hooks: ExtensionHooks<CoreDomainOperations, CoreDomainFacts>
): CoreFilesApi {
  const invoke = <Name extends keyof CoreFilesApi>(
    name: Name,
    input: Input<Name>
  ): Promise<Output<Name>> =>
    run((call) => {
      const handler = backend[name] as (
        input: Input<Name>,
        call: CoreOperationContext
      ) => Promise<Output<Name>>;
      if (typeof handler !== 'function')
        throw new MarAgentError(
          'MAR_AGENT_HOST_PORT_UNAVAILABLE',
          'Native file port is unavailable.',
          { details: { operation: name } }
        );
      return hooks.invoke(
        `files.${name}`,
        input,
        call,
        async (input, effective): Promise<CoreDomainOperations[`files.${Name}`]['output']> => {
          const factInput =
            input && 'bytes' in input && input.bytes instanceof Uint8Array
              ? { ...input, bytes: new Uint8Array(input.bytes) }
              : { ...input };
          const output = await handler.call(backend, input as Input<Name>, effective);
          await hooks.emit(
            'files.completed',
            { operation: name, input: factInput, output } as CoreFileCompletion,
            effective
          );
          return output as CoreDomainOperations[`files.${Name}`]['output'];
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
