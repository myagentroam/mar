import { statfs } from 'node:fs/promises';
import {
  conversationHostingCleanupExecuteInputSchema,
  conversationHostingCleanupPreviewInputSchema,
  conversationHostingCleanupPreviewSchema,
  conversationHostingCleanupResultSchema,
  conversationHostingStorageCapacitySchema,
  type ConversationHostingCleanupResult,
  type ConversationHostingStorageCapacity,
  type HostedConversationManifest
} from '@myagentroam/protocol';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import { nodeOperationData } from '../util/node-operation-data.js';
import type { HostedConversationStore } from './hosted-conversation-store.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const AUTOMATIC_CLEANUP_INTERVAL_MS = DAY_MS;

interface FilesystemCapacity {
  readonly totalBytes: number;
  readonly availableBytes: number;
}

interface ConversationHostingMaintenanceOptions {
  readonly store: HostedConversationStore;
  readonly inactiveRetentionDays: number;
  readonly now?: () => number;
  readonly filesystemCapacity?: () => Promise<FilesystemCapacity>;
  readonly isConversationInUse: (conversationId: string) => boolean;
  readonly beginConversationCleanup: (conversationId: string) => (() => void) | undefined;
  readonly releaseConversation: (conversation: HostedConversationManifest) => Promise<void>;
  readonly onAutomaticCleanupError?: (error: unknown) => void;
}

/** Owns aggregate storage watermarks and permanent hosted-conversation cleanup. */
export class ConversationHostingMaintenanceService {
  private readonly now: () => number;
  private readonly filesystemCapacity: () => Promise<FilesystemCapacity>;
  private automaticCleanupTimer: NodeJS.Timeout | undefined;
  private automaticCleanupStarted = false;
  private cleanupTail: Promise<void> = Promise.resolve();
  private pendingCleanupCount = 0;

  constructor(private readonly options: ConversationHostingMaintenanceOptions) {
    this.now = options.now ?? Date.now;
    this.filesystemCapacity =
      options.filesystemCapacity ?? (() => filesystemCapacity(options.store.rootDirectory));
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'conversation.hosting.storage.inspect': () =>
        this.storageCapacity().then((storage) => ({ storage })),
      'conversation.hosting.cleanup.preview': (raw) =>
        this.preview(
          conversationHostingCleanupPreviewInputSchema.parse(nodeOperationData(raw)).inactiveDays
        ).then((preview) => ({ preview })),
      'conversation.hosting.cleanup.execute': (raw) =>
        this.runCleanupExclusive(() =>
          this.execute(
            conversationHostingCleanupExecuteInputSchema.parse(nodeOperationData(raw)).inactiveDays
          )
        ).then((result) => ({ result }))
    };
  }

  async storageCapacity(): Promise<ConversationHostingStorageCapacity> {
    const measuredAt = this.now();
    const filesystem = await this.filesystemStorageCapacity();
    return conversationHostingStorageCapacitySchema.parse({
      ...filesystem,
      hostedStorageUsedBytes: await this.options.store.hostedStorageUsedBytes(),
      automaticCleanupInactiveDays: this.options.inactiveRetentionDays,
      measuredAt
    });
  }

  async assertCanCreate(): Promise<void> {
    if (!(await this.filesystemStorageCapacity()).acceptsNewConversations)
      throw new Error('CONVERSATION_HOSTING_STORAGE_FULL');
  }

  async runAutomaticCleanup(): Promise<void> {
    await this.runCleanupExclusive(() => this.execute(this.options.inactiveRetentionDays));
  }

  async start(): Promise<void> {
    if (this.automaticCleanupStarted) return;
    this.automaticCleanupStarted = true;
    await this.runAutomaticCleanup().catch((error) =>
      this.options.onAutomaticCleanupError?.(error)
    );
    if (!this.automaticCleanupStarted) return;
    this.automaticCleanupTimer = setInterval(() => {
      this.triggerAutomaticCleanup();
    }, AUTOMATIC_CLEANUP_INTERVAL_MS);
    this.automaticCleanupTimer.unref();
  }

  dispose(): Promise<void> | undefined {
    this.automaticCleanupStarted = false;
    if (this.automaticCleanupTimer !== undefined) clearInterval(this.automaticCleanupTimer);
    this.automaticCleanupTimer = undefined;
    return this.pendingCleanupCount === 0 ? undefined : this.cleanupTail;
  }

  private async filesystemStorageCapacity() {
    const filesystem = await this.filesystemCapacity();
    assertFilesystemCapacity(filesystem);
    const usedBytes = filesystem.totalBytes - filesystem.availableBytes;
    const filesystemUsageBasisPoints = Number(
      (BigInt(usedBytes) * 10_000n) / BigInt(filesystem.totalBytes)
    );
    const capacity: ConversationHostingStorageCapacity['capacity'] =
      filesystemUsageBasisPoints >= 9_500
        ? 'FULL'
        : filesystemUsageBasisPoints >= 8_500
          ? 'HIGH'
          : 'AVAILABLE';
    return {
      filesystemTotalBytes: filesystem.totalBytes,
      filesystemAvailableBytes: filesystem.availableBytes,
      filesystemUsageBasisPoints,
      capacity,
      acceptsNewConversations: capacity !== 'FULL'
    };
  }

  private triggerAutomaticCleanup(): void {
    void this.runAutomaticCleanup().catch((error) => this.options.onAutomaticCleanupError?.(error));
  }

  private runCleanupExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingCleanupCount += 1;
    const result = this.cleanupTail.then(operation, operation);
    this.cleanupTail = result.then(
      () => {
        this.pendingCleanupCount -= 1;
      },
      () => {
        this.pendingCleanupCount -= 1;
      }
    );
    return result;
  }

  private async preview(inactiveDays: number) {
    const measuredAt = this.now();
    const cutoffAt = cutoff(measuredAt, inactiveDays);
    const available = this.options.store
      .inactiveCleanupCandidates(cutoffAt)
      .filter((conversation) => !this.options.isConversationInUse(conversation.id));
    let reclaimableBytes = 0;
    for (const conversation of available)
      reclaimableBytes += await this.options.store.conversationStorageBytes(conversation);
    return conversationHostingCleanupPreviewSchema.parse({
      inactiveDays,
      cutoffAt,
      candidateConversationCount: available.length,
      reclaimableBytes,
      measuredAt
    });
  }

  private async execute(inactiveDays: number): Promise<ConversationHostingCleanupResult> {
    const startedAt = this.now();
    const cutoffAt = cutoff(startedAt, inactiveDays);
    let deletedConversationCount = 0;
    let releasedBytes = 0;
    let skippedConversationCount = 0;
    for (const candidate of this.options.store.inactiveCleanupCandidates(cutoffAt)) {
      const finishCleanup = this.options.beginConversationCleanup(candidate.id);
      if (finishCleanup === undefined) {
        skippedConversationCount += 1;
        continue;
      }
      try {
        const current = this.options.store.findConversationById(candidate.id);
        if (
          current === undefined ||
          current.lastActivityAt >= cutoffAt ||
          current.status !== 'ACTIVE'
        ) {
          skippedConversationCount += 1;
          continue;
        }
        await this.options.releaseConversation(current);
        const deleted = await this.options.store.permanentDeleteConversation(current.id);
        deletedConversationCount += 1;
        releasedBytes += deleted.releasedBytes;
      } finally {
        finishCleanup();
      }
    }
    const completedAt = this.now();
    return conversationHostingCleanupResultSchema.parse({
      inactiveDays,
      cutoffAt,
      deletedConversationCount,
      releasedBytes,
      skippedConversationCount,
      completedAt
    });
  }
}

function cutoff(now: number, inactiveDays: number): number {
  return Math.max(0, now - inactiveDays * DAY_MS);
}

async function filesystemCapacity(rootDirectory: string): Promise<FilesystemCapacity> {
  const value = await statfs(rootDirectory);
  return {
    totalBytes: safeFilesystemBytes(value.bsize, value.blocks),
    availableBytes: safeFilesystemBytes(value.bsize, value.bavail, true)
  };
}

function safeFilesystemBytes(blockSize: number, blocks: number, allowZero = false): number {
  if (
    !Number.isSafeInteger(blockSize) ||
    blockSize <= 0 ||
    !Number.isSafeInteger(blocks) ||
    blocks < 0
  )
    throw new Error('CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
  const bytes = BigInt(blockSize) * BigInt(blocks);
  if ((!allowZero && bytes === 0n) || bytes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
  return Number(bytes);
}

function assertFilesystemCapacity(value: FilesystemCapacity): void {
  if (
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes <= 0 ||
    !Number.isSafeInteger(value.availableBytes) ||
    value.availableBytes < 0 ||
    value.availableBytes > value.totalBytes
  )
    throw new Error('CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
}
