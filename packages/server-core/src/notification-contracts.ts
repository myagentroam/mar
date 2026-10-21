import type { Pool } from 'mysql2/promise';
export interface NotificationStore {
  readonly raw: Pool;
  userCanRequestNode(
    userId: number,
    nodeId: string,
    operation: string,
    data: unknown,
    workspaceId?: string
  ): Promise<boolean>;
}
