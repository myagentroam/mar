interface FileWrite {
  readonly uploadId?: string;
  readonly completion: Promise<unknown>;
}

/** Owns file mutation admission and deletion conflict lifetimes. */
export class HostedConversationFileOperations {
  private readonly writes = new Map<string, Set<FileWrite>>();
  private readonly deletes = new Set<string>();

  busy(conversationId: string): boolean {
    return this.writes.has(conversationId);
  }

  async write(
    conversationId: string,
    uploadId: string | undefined,
    operation: () => Promise<unknown>
  ): Promise<unknown> {
    const writes = this.writes.get(conversationId) ?? new Set<FileWrite>();
    if (uploadId !== undefined && [...writes].some((write) => write.uploadId === uploadId))
      throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
    // Admission precedes the operation's first asynchronous preparation.
    const write: FileWrite = {
      ...(uploadId === undefined ? {} : { uploadId }),
      completion: Promise.resolve().then(operation)
    };
    writes.add(write);
    this.writes.set(conversationId, writes);
    try {
      return await write.completion;
    } finally {
      writes.delete(write);
      if (writes.size === 0) this.writes.delete(conversationId);
    }
  }

  beginDelete(key: string): void {
    if (this.deletes.has(key)) throw new Error('HOSTED_CONVERSATION_FILE_CONFLICT');
    this.deletes.add(key);
  }

  endDelete(key: string): void {
    this.deletes.delete(key);
  }

  async wait(conversationId: string): Promise<void> {
    const writes = this.writes.get(conversationId);
    if (writes) await Promise.allSettled([...writes].map((write) => write.completion));
  }

  async close(): Promise<void> {
    await Promise.all([...this.writes.keys()].map((id) => this.wait(id)));
  }
}
