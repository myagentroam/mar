import type { ConversationFileProjection } from '@myagentroam/protocol';

export type HostedConversationFileTreeNode =
  | {
      readonly kind: 'DIRECTORY';
      readonly name: string;
      readonly path: string;
      readonly children: readonly HostedConversationFileTreeNode[];
    }
  | {
      readonly kind: 'FILE';
      readonly name: string;
      readonly path: string;
      readonly file: ConversationFileProjection;
    };

export interface HostedConversationFileTreeRow {
  readonly node: HostedConversationFileTreeNode;
  readonly depth: number;
}

interface MutableDirectory {
  readonly name: string;
  readonly path: string;
  readonly directories: Map<string, MutableDirectory>;
  readonly files: ConversationFileProjection[];
}

export function buildHostedConversationFileTree(
  files: readonly ConversationFileProjection[]
): readonly HostedConversationFileTreeNode[] {
  const root = mutableDirectory('', '');
  for (const file of files) {
    const segments = file.relativePath.split('/');
    let directory = root;
    let path = '';
    for (const name of segments.slice(0, -1)) {
      path = path === '' ? name : `${path}/${name}`;
      const existing = directory.directories.get(name);
      if (existing !== undefined) {
        directory = existing;
        continue;
      }
      const created = mutableDirectory(name, path);
      directory.directories.set(name, created);
      directory = created;
    }
    directory.files.push(file);
  }
  return finalizedChildren(root);
}

export function visibleHostedConversationFileTreeRows(
  nodes: readonly HostedConversationFileTreeNode[],
  expanded: (path: string) => boolean
): readonly HostedConversationFileTreeRow[] {
  const rows: HostedConversationFileTreeRow[] = [];
  appendVisibleRows(nodes, 0, expanded, rows);
  return rows;
}

function appendVisibleRows(
  nodes: readonly HostedConversationFileTreeNode[],
  depth: number,
  expanded: (path: string) => boolean,
  output: HostedConversationFileTreeRow[]
): void {
  for (const node of nodes) {
    output.push({ node, depth });
    if (node.kind === 'DIRECTORY' && expanded(node.path))
      appendVisibleRows(node.children, depth + 1, expanded, output);
  }
}

function mutableDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: [] };
}

function finalizedChildren(directory: MutableDirectory): readonly HostedConversationFileTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((left, right) => compareName(left.name, right.name))
    .map((child): HostedConversationFileTreeNode => ({
      kind: 'DIRECTORY',
      name: child.name,
      path: child.path,
      children: finalizedChildren(child)
    }));
  const files = [...directory.files]
    .sort((left, right) => compareName(left.relativePath, right.relativePath))
    .map((file): HostedConversationFileTreeNode => ({
      kind: 'FILE',
      name: file.displayName,
      path: file.relativePath,
      file
    }));
  return [...directories, ...files];
}

function compareName(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}
