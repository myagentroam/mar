import { requestUserNode } from './workspace-http-support.js';
import type { FastifyInstance } from 'fastify';
import type { SessionRunNodeControl } from './session-run-contracts.js';
import type { CatalogResourcePolicy, SkillTargetStore } from './catalog-route-contracts.js';
import type { SkillArtifactService } from './skill-artifact-service.js';
import type { SkillFavoriteService } from './skill-favorite-service.js';
import { databaseError } from './domain-errors.js';
import { protectedAdmin, validCsrf } from './session.js';
import { sendError } from './http-errors.js';
import { isAllowedOrigin } from './auth.js';

export function registerSkillTargetRoutes(input: {
  app: FastifyInstance;
  database: SkillTargetStore;
  nodeControl: Pick<SessionRunNodeControl, 'requestNode'>;
  resources?: CatalogResourcePolicy;
  favorites: SkillFavoriteService;
  artifacts: SkillArtifactService;
  publicOrigin: string | undefined;
}): void {
  const { app, database, nodeControl, resources, favorites, artifacts, publicOrigin } = input;
  const jobs = new Map<
    string,
    { userId: number; nodeId: string; workspaceId?: string; expiresAt: number }
  >();
  app.get<{ Params: { nodeId: string } }>('/api/nodes/:nodeId/skills', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    try {
      if (resources) await resources.assertCanManageNode(actor.userId, request.params.nodeId);
      return reply.send(
        await requestUserNode(nodeControl, actor, request.params.nodeId, 'node.skills.inspect', {})
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.get<{ Params: { workspaceId: string }; Querystring: { nodeId?: string } }>(
    '/api/workspaces/:workspaceId/effective-skills',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      if (typeof request.query.nodeId !== 'string')
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        if (resources)
          await resources.assertCanUseWorkspace(
            actor.userId,
            request.query.nodeId,
            request.params.workspaceId
          );
        const [nodeResult, workspaceResult] = await Promise.all([
          requestUserNode(nodeControl, actor, request.query.nodeId, 'node.skills.inspect', {
            includeClaudeCompatibility: true
          }),
          requestUserNode(
            nodeControl,
            actor,
            request.query.nodeId,
            'workspace.skills.inspect',
            { workspaceId: request.params.workspaceId },
            request.params.workspaceId
          )
        ]);
        return reply.send({ skills: effectiveSkills(nodeResult, workspaceResult) });
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { workspaceId: string }; Querystring: { nodeId?: string } }>(
    '/api/workspaces/:workspaceId/skills',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      if (typeof request.query.nodeId !== 'string')
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        if (resources)
          await resources.assertCanManageWorkspace(
            actor.userId,
            request.query.nodeId,
            request.params.workspaceId
          );
        return reply.send(
          await requestUserNode(
            nodeControl,
            actor,
            request.query.nodeId,
            'workspace.skills.inspect',
            { workspaceId: request.params.workspaceId },
            request.params.workspaceId
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{ Params: { nodeId: string }; Body: { favoriteId?: unknown } }>(
    '/api/nodes/:nodeId/skills',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (typeof request.body?.favoriteId !== 'string')
        return sendError(reply, 400, 'SKILL_FAVORITE_REQUIRED');
      try {
        if (resources) await resources.assertCanManageNode(actor.userId, request.params.nodeId);
        const favorite = await favorites.getVisible(actor.userId, request.body.favoriteId);
        const artifactTicket = artifacts.issue(request.params.nodeId, favorite);
        const result = await requestUserNode(
          nodeControl,
          actor,
          request.params.nodeId,
          'node.skills.install',
          installData(favorite, artifactTicket)
        );
        rememberJob(jobs, result, actor.userId, request.params.nodeId);
        return reply.code(202).send(result);
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.post<{
    Params: { workspaceId: string };
    Querystring: { nodeId?: string };
    Body: { favoriteId?: unknown; confirmTracked?: unknown };
  }>('/api/workspaces/:workspaceId/skills', async (request, reply) => {
    const actor = writable(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    if (typeof request.query.nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
    if (typeof request.body?.favoriteId !== 'string')
      return sendError(reply, 400, 'SKILL_FAVORITE_REQUIRED');
    try {
      if (resources)
        await resources.assertCanManageWorkspace(
          actor.userId,
          request.query.nodeId,
          request.params.workspaceId
        );
      const favorite = await favorites.getVisible(actor.userId, request.body.favoriteId);
      const artifactTicket = artifacts.issue(request.query.nodeId, favorite);
      const result = await requestUserNode(
        nodeControl,
        actor,
        request.query.nodeId,
        'workspace.skills.install',
        {
          ...installData(favorite, artifactTicket),
          workspaceId: request.params.workspaceId,
          confirmTracked: request.body?.confirmTracked === true
        },
        request.params.workspaceId
      );
      rememberJob(jobs, result, actor.userId, request.query.nodeId, request.params.workspaceId);
      return reply.code(202).send(result);
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.delete<{ Params: { nodeId: string; name: string } }>(
    '/api/nodes/:nodeId/skills/:name',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      try {
        if (resources) await resources.assertCanManageNode(actor.userId, request.params.nodeId);
        return reply.send(
          await requestUserNode(nodeControl, actor, request.params.nodeId, 'node.skills.remove', {
            name: request.params.name
          })
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.delete<{
    Params: { workspaceId: string; name: string };
    Querystring: { nodeId?: string };
  }>('/api/workspaces/:workspaceId/skills/:name', async (request, reply) => {
    const actor = writable(database, request, reply, publicOrigin);
    if (actor === undefined) return;
    if (typeof request.query.nodeId !== 'string') return sendError(reply, 400, 'NODE_ID_REQUIRED');
    try {
      if (resources)
        await resources.assertCanManageWorkspace(
          actor.userId,
          request.query.nodeId,
          request.params.workspaceId
        );
      return reply.send(
        await requestUserNode(
          nodeControl,
          actor,
          request.query.nodeId,
          'workspace.skills.remove',
          { workspaceId: request.params.workspaceId, name: request.params.name },
          request.params.workspaceId
        )
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });
  app.post<{ Params: { workspaceId: string }; Querystring: { nodeId?: string } }>(
    '/api/workspaces/:workspaceId/skills/git-exclude-repair',
    async (request, reply) => {
      const actor = writable(database, request, reply, publicOrigin);
      if (actor === undefined) return;
      if (typeof request.query.nodeId !== 'string')
        return sendError(reply, 400, 'NODE_ID_REQUIRED');
      try {
        if (resources)
          await resources.assertCanManageWorkspace(
            actor.userId,
            request.query.nodeId,
            request.params.workspaceId
          );
        return reply.send(
          await requestUserNode(
            nodeControl,
            actor,
            request.query.nodeId,
            'workspace.skills.git-exclude-repair',
            { workspaceId: request.params.workspaceId },
            request.params.workspaceId
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { ticket: string } }>(
    '/api/skill-artifacts/:ticket',
    async (request, reply) => {
      const nodeId = request.headers['x-mar-node-id'];
      const authorization = request.headers.authorization;
      if (typeof nodeId !== 'string' || !authorization?.startsWith('Bearer '))
        return sendError(reply, 401, 'NODE_UNAUTHENTICATED');
      if ((await database.authenticateNode(nodeId, authorization.slice(7))) === undefined)
        return sendError(reply, 401, 'NODE_UNAUTHENTICATED');
      try {
        const content = await artifacts.consume(request.params.ticket, nodeId);
        return reply.type('application/json').send(content);
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
  app.get<{ Params: { jobId: string } }>(
    '/api/skill-install-jobs/:jobId',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      const now = Date.now();
      for (const [id, job] of jobs) if (job.expiresAt < now) jobs.delete(id);
      const job = jobs.get(request.params.jobId);
      if (job === undefined || job.userId !== actor.userId)
        return sendError(reply, 404, 'SKILL_INSTALL_FAILED');
      try {
        return reply.send(
          await requestUserNode(
            nodeControl,
            actor,
            job.nodeId,
            'skill.install.job.get',
            { installJobId: request.params.jobId },
            job.workspaceId
          )
        );
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}

export function effectiveSkills(nodeResult: unknown, workspaceResult: unknown) {
  const merged = new Map<string, Record<string, unknown>>();
  for (const [result, source] of [
    [nodeResult, 'NODE_HOME'],
    [workspaceResult, 'WORKSPACE']
  ] as const) {
    if (typeof result !== 'object' || result === null) continue;
    const skills = (result as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) continue;
    for (const skill of skills) {
      if (typeof skill !== 'object' || skill === null) continue;
      const value = skill as Record<string, unknown>;
      if (typeof value.name !== 'string') continue;
      merged.set(value.name, { ...value, source });
    }
  }
  return [...merged.values()].sort((left, right) =>
    String(left.name).localeCompare(String(right.name), 'zh-CN')
  );
}

function rememberJob(
  jobs: Map<string, { userId: number; nodeId: string; workspaceId?: string; expiresAt: number }>,
  result: unknown,
  userId: number,
  nodeId: string,
  workspaceId?: string
): void {
  if (result === null || typeof result !== 'object') throw new Error('SKILL_INSTALL_FAILED');
  const installJobId = (result as Record<string, unknown>)['installJobId'];
  if (typeof installJobId !== 'string') throw new Error('SKILL_INSTALL_FAILED');
  const now = Date.now();
  for (const [id, job] of jobs) if (job.expiresAt < now) jobs.delete(id);
  while (jobs.size >= 10_000) jobs.delete(jobs.keys().next().value!);
  jobs.set(installJobId, {
    userId,
    nodeId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    expiresAt: now + 5 * 60_000
  });
}

function installData(
  favorite: Awaited<ReturnType<SkillFavoriteService['getVisible']>>,
  artifactTicket: string
) {
  return {
    name: favorite.normalizedName,
    artifactTicket,
    metadata: {
      schemaVersion: 1,
      favoriteId: favorite.id,
      versionId: favorite.currentVersionId,
      commitSha: favorite.commitSha,
      contentHash: favorite.contentHash,
      installedAt: Date.now()
    }
  };
}
function writable(
  database: SkillTargetStore,
  request: Parameters<typeof protectedAdmin>[1],
  reply: Parameters<typeof protectedAdmin>[2],
  origin: string | undefined
) {
  if (!isAllowedOrigin(request, origin)) {
    void sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
    return;
  }
  const actor = protectedAdmin(database, request, reply);
  if (actor === undefined) return;
  if (!validCsrf(request, actor)) {
    void sendError(reply, 403, 'CSRF_INVALID');
    return;
  }
  return actor;
}
