import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillArtifactService } from '../../ee/server/src/skill/skill-artifact-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('Server Skill artifact ticket', () => {
  it('Artifact tickets bind to one Node and can be consumed only once', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-artifact-'));
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const contentHash = 'a'.repeat(64);
    await writeFile(path.join(directory, `${contentHash}.json`), '{"schemaVersion":1,"files":[]}');
    const service = new SkillArtifactService(directory, () => 1_000);
    const ticket = service.issue('node-a', { contentHash } as never);

    await expect(service.consume(ticket, 'node-b')).rejects.toThrow(
      'SKILL_ARTIFACT_TICKET_INVALID'
    );
    await expect(service.consume(ticket, 'node-a')).rejects.toThrow(
      'SKILL_ARTIFACT_TICKET_INVALID'
    );

    const valid = service.issue('node-a', { contentHash } as never);
    const stream = await service.consume(valid, 'node-a');
    expect((await stream.toArray()).join('')).toBe('{"schemaVersion":1,"files":[]}');
    await expect(service.consume(valid, 'node-a')).rejects.toThrow('SKILL_ARTIFACT_TICKET_INVALID');
  });

  it('Rejects expired tickets', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mar-skill-artifact-'));
    temporaryDirectories.push(directory);
    let now = 1_000;
    const service = new SkillArtifactService(directory, () => now);
    const ticket = service.issue('node-a', { contentHash: 'b'.repeat(64) } as never);
    now += 60_001;
    await expect(service.consume(ticket, 'node-a')).rejects.toThrow(
      'SKILL_ARTIFACT_TICKET_INVALID'
    );
  });
});
