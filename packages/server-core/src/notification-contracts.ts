import type { Pool } from 'mysql2/promise';
export interface NotificationStore {
  readonly raw: Pool;
}
