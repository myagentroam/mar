import type { DatabaseSync } from 'node:sqlite';
import { applyMigration } from './support.js';

export function up(database: DatabaseSync): void {
  applyMigration(database, 5, '');
}
