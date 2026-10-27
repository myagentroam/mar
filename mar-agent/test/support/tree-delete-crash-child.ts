import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  beginTreeDeleteTransaction,
  stageTreeDelete,
  type SessionTreeDeleteTransaction
} from '../../src/session/store/jsonl/transaction-recovery.js';
import { syncJsonlDirectory } from '../../src/session/store/jsonl/fs-durability.js';

const [root, first, second, mode, marker] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string
];
const id = randomUUID();
const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
const members = [first, second].map((sessionId) => {
  const meta = index.sessions.find((entry: { id: string }) => entry.id === sessionId);
  return {
    id: sessionId,
    existed: true,
    identity: {
      createdAt: meta.createdAt,
      workspace: meta.workspace,
      source: meta.source,
      storage: meta.storage,
      storageTransactionId: meta.storageTransactionId,
      nextSequence: meta.nextSequence
    }
  };
});
const transaction: SessionTreeDeleteTransaction = {
  version: 1,
  kind: 'delete',
  id,
  members
};
await beginTreeDeleteTransaction(root, transaction, async (path) => {
  await syncJsonlDirectory(path);
  if (mode === 'preparing' && path === join(root, '.delete-pending')) {
    await writeFile(marker, 'ready', { flush: true });
    process.kill(process.pid, 'SIGKILL');
  }
});
if (mode === 'staged') {
  const directory = join(root, second);
  const trash = join(directory, `.delete-${id}.trash`);
  await mkdir(trash);
  await rename(join(directory, 'v2'), join(trash, 'v2'));
  await syncJsonlDirectory(trash);
  await syncJsonlDirectory(directory);
} else {
  await stageTreeDelete(root, transaction, syncJsonlDirectory);
  const path = join(root, 'index.json');
  const index = JSON.parse(await readFile(path, 'utf8'));
  index.sessions = index.sessions.filter(
    (entry: { id: string }) => entry.id !== first && entry.id !== second
  );
  index.revision++;
  const temporary = join(root, `.index-${id}.tmp`);
  await writeFile(temporary, JSON.stringify(index), { flush: true });
  await rename(temporary, path);
  await syncJsonlDirectory(root);
}
await writeFile(marker, 'ready', { flush: true });
process.kill(process.pid, 'SIGKILL');
