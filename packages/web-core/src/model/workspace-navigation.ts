import type { FileReference } from '@myagentroam/code-navigation';

export interface FileNavigationRequest {
  readonly reference: FileReference;
  readonly sourceContext: {
    readonly text: string;
    readonly position: number;
  };
}

export interface WorkspaceNavigationTarget {
  readonly source: 'DEFINITION' | 'REFERENCE' | 'FILE';
  readonly path: string;
  readonly line: number;
  readonly column?: number | undefined;
  readonly kind?: string | undefined;
  readonly scope?: string | undefined;
  readonly preview?: string | undefined;
}
