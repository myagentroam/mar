import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMarAgentSessionCatalog } from '@myagentroam/agent';
import type { ModelResourceReadInput } from '@myagentroam/protocol';
import { JsonlSessionStore } from '../../../mar-agent/src/agent-core/session/store/index.js';
import { ModelResourcePublicationService } from '../../src/service/model-resource-publication-service.js';

type ResourceReadInput = Extract<ModelResourceReadInput, { resourceId: string }>;

const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 65, 0]);
const image = { mimeType: 'image/png', dataBase64: imageBytes.toString('base64') };

function createService(directory: string, now: () => number, nodeId = 'node-1') {
  return new ModelResourcePublicationService({
    directory: () => join(directory, 'node-publications'),
    origin: () => 'https://workbench.example.test',
    nodeId: () => nodeId,
    now
  });
}

function readInput(url: string): ResourceReadInput {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  const common = {
    sessionId: decodeURIComponent(parts[7]!),
    resourceId: decodeURIComponent(parts[9]!),
    expiresAt: Number(parsed.searchParams.get('expiresAt')),
    signature: parsed.searchParams.get('signature')!
  };
  return parts[4] === 'workspaces'
    ? { workspaceId: decodeURIComponent(parts[5]!), ...common }
    : { conversationId: decodeURIComponent(parts[5]!), ...common };
}

async function createSessionImage(homeDirectory: string) {
  const store = await JsonlSessionStore.open(homeDirectory);
  try {
    const session = await store.createSession({
      workspace: homeDirectory,
      title: 'Image resource'
    });
    const resource = await store.persistResource(session.id, image);
    await store.append(session.id, {
      type: 'turn.user',
      payload: { text: 'Image fixture', images: [resource] }
    });
    return { sessionId: session.id, resource };
  } finally {
    await store.close();
  }
}

describe('model image publication', () => {
  let directory: string;
  let now: number;
  let service: ModelResourcePublicationService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mar-model-images-'));
    now = 1_700_000_000_000;
    service = createService(directory, () => now);
  });

  afterEach(async () => {
    service.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it('publishes one URL concurrently, stores only Node metadata, and survives a restart', async () => {
    const { sessionId, resource } = await createSessionImage(directory);
    const source = { workspaceId: 'workspace-1', sessionId, homeDirectory: directory };
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => service.publish(source, resource))
    );
    const first = concurrent[0]!;
    expect(concurrent).toEqual([first, first, first, first]);
    expect(first.urlExpiresAt - now).toBe(24 * 60 * 60_000);
    expect(first.url).toContain(
      `/workspaces/workspace-1/sessions/${sessionId}/resources/${resource.resourceId}`
    );
    expect(await service.publish(source, resource)).toEqual(first);
    await expect(service.read(readInput(first.url))).resolves.toEqual(image);

    const sessionDirectory = join(directory, '.mar', 'agent', 'sessions', sessionId);
    const imageDirectory = join(sessionDirectory, 'resources');
    const imageFiles = await readdir(imageDirectory);
    expect(imageFiles.filter((name) => name.endsWith('.bin'))).toEqual([
      `${resource.resourceId}.bin`
    ]);
    expect(imageFiles).not.toContain(`.${resource.resourceId}.pending`);
    await expect(readFile(join(imageDirectory, `${resource.resourceId}.bin`))).resolves.toEqual(
      imageBytes
    );
    const resourceMetadata = await readFile(
      join(imageDirectory, `${resource.resourceId}.json`),
      'utf8'
    );
    expect(resourceMetadata).not.toContain(image.dataBase64);
    expect(JSON.parse(resourceMetadata)).not.toHaveProperty('dataBase64');
    const sessionJsonl = (
      await Promise.all(
        (await readdir(sessionDirectory))
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => readFile(join(sessionDirectory, name), 'utf8'))
      )
    ).join('\n');
    expect(sessionJsonl).toContain(resource.resourceId);
    expect(sessionJsonl).not.toContain(image.dataBase64);
    const publicationDirectory = join(directory, 'node-publications');
    const publicationFiles = await readdir(publicationDirectory);
    expect(publicationFiles).toContain('signing-key');
    expect(publicationFiles.some((name) => name.endsWith('.bin'))).toBe(false);
    const publicationRecords = publicationFiles.filter((entry) => entry.endsWith('.json'));
    expect(publicationRecords).toHaveLength(1);
    for (const name of publicationRecords)
      expect(await readFile(join(publicationDirectory, name), 'utf8')).not.toContain(
        image.dataBase64
      );
    const signingKey = await readFile(join(publicationDirectory, 'signing-key'));

    service.dispose();
    service = createService(directory, () => now);
    await expect(readFile(join(publicationDirectory, 'signing-key'))).resolves.toEqual(signingKey);
    await expect(service.read(readInput(first.url))).resolves.toEqual(image);
    await expect(service.publish(source, resource)).resolves.toEqual(first);
  });

  it('rejects expired URLs without renewing them or deleting the source image', async () => {
    const { sessionId, resource } = await createSessionImage(directory);
    const source = { workspaceId: 'workspace-1', sessionId, homeDirectory: directory };
    const published = await service.publish(source, resource);
    expect(published).toBeDefined();
    now = published!.urlExpiresAt;
    await expect(service.read(readInput(published!.url))).resolves.toBeUndefined();
    await expect(service.publish(source, resource)).resolves.toEqual(published);
    const store = await JsonlSessionStore.open(directory);
    try {
      await expect(store.readResource(sessionId, resource.resourceId)).resolves.toEqual(image);
    } finally {
      await store.close();
    }
  });

  it('rejects altered workspace, Session, resource, expiry, signature, and Node identity', async () => {
    const { sessionId, resource } = await createSessionImage(directory);
    const source = { workspaceId: 'workspace-1', sessionId, homeDirectory: directory };
    const published = await service.publish(source, resource);
    expect(published).toBeDefined();
    const input = readInput(published!.url);
    if (!('workspaceId' in input)) throw new Error('expected workspace capability');
    const alteredSignature = `${input.signature[0] === 'A' ? 'B' : 'A'}${input.signature.slice(1)}`;
    const altered = [
      { ...input, workspaceId: 'workspace-other' },
      { ...input, sessionId: 'session-other' },
      {
        ...input,
        resourceId: resource.resourceId.replace(/^./u, resource.resourceId[0] === 'a' ? 'b' : 'a')
      },
      { ...input, expiresAt: input.expiresAt + 1 },
      { ...input, signature: alteredSignature }
    ];
    for (const capability of altered)
      await expect(service.read(capability)).resolves.toBeUndefined();
    const otherNode = createService(directory, () => now, 'node-other');
    try {
      await expect(otherNode.read(input)).resolves.toBeUndefined();
    } finally {
      otherNode.dispose();
    }
  });

  it('keeps hosted conversation resources isolated from other conversations and Workspaces', async () => {
    const { sessionId, resource } = await createSessionImage(directory);
    const common = { sessionId, homeDirectory: directory };
    const workspace = await service.publish({ ...common, workspaceId: 'workspace-1' }, resource);
    const conversation = await service.publish(
      { ...common, conversationId: 'conversation-1' },
      resource
    );
    expect(workspace).toBeDefined();
    expect(conversation).toBeDefined();
    expect(conversation!.url).toContain('/conversations/conversation-1/');
    expect(conversation).not.toEqual(workspace);

    const workspaceInput = readInput(workspace!.url);
    const conversationInput = readInput(conversation!.url);
    if (!('workspaceId' in workspaceInput) || !('conversationId' in conversationInput))
      throw new Error('expected separate Workspace and conversation capabilities');
    await expect(service.read(workspaceInput)).resolves.toEqual(image);
    await expect(service.read(conversationInput)).resolves.toEqual(image);
    await expect(
      service.read({ ...conversationInput, conversationId: 'conversation-other' })
    ).resolves.toBeUndefined();
    const conversationAsWorkspace = {
      workspaceId: 'workspace-1',
      sessionId: conversationInput.sessionId,
      resourceId: conversationInput.resourceId,
      expiresAt: conversationInput.expiresAt,
      signature: conversationInput.signature
    };
    await expect(service.read(conversationAsWorkspace)).resolves.toBeUndefined();
  });

  it('does not serve an image after its source Session is deleted', async () => {
    const { sessionId, resource } = await createSessionImage(directory);
    const published = await service.publish(
      { workspaceId: 'workspace-1', sessionId, homeDirectory: directory },
      resource
    );
    expect(published).toBeDefined();
    const catalog = await openMarAgentSessionCatalog({ homeDirectory: directory });
    try {
      await catalog.delete(sessionId);
    } finally {
      await catalog.close();
    }
    await expect(service.read(readInput(published!.url))).resolves.toBeUndefined();
  });
});
