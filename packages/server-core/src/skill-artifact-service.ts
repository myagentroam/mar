import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillFavoriteSummary } from './skill-favorite-service.js';

interface Ticket {
  nodeId: string;
  contentHash: string;
  expiresAt: number;
}

export class SkillArtifactService {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly cacheDirectory: string,
    private readonly now: () => number = Date.now
  ) {}

  issue(nodeId: string, favorite: SkillFavoriteSummary): string {
    this.cleanup();
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(token, {
      nodeId,
      contentHash: favorite.contentHash,
      expiresAt: this.now() + 60_000
    });
    return token;
  }

  async consume(token: string, nodeId: string): Promise<Buffer> {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (ticket === undefined || ticket.nodeId !== nodeId || ticket.expiresAt < this.now())
      throw new Error('SKILL_ARTIFACT_TICKET_INVALID');
    const file = path.join(this.cacheDirectory, `${ticket.contentHash}.json`);
    if ((await stat(file)).size > 40 * 1024 * 1024) throw new Error('SKILL_CONTENT_INVALID');
    return readFile(file);
  }

  private cleanup(): void {
    const now = this.now();
    for (const [token, ticket] of this.tickets)
      if (ticket.expiresAt < now) this.tickets.delete(token);
  }
}
