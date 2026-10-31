import type { FastifyInstance } from 'fastify';
import type { AuditService } from '../audit/audit-service.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import { databaseError, protectedAdmin, sendError } from '../util/http-request.js';
import { managementPageQuery } from '@myagentroam/server-core/management-pagination';

export function registerAuditRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: MysqlServerDatabase;
  readonly audits: AuditService;
}): void {
  const { app, database, audits } = input;
  app.get<{
    Querystring: { cursor?: string; limit?: string; page?: string; from?: string; to?: string };
  }>('/api/audit-events', async (request, reply) => {
    const actor = protectedAdmin(database, request, reply);
    if (actor === undefined) return;
    let pagination;
    try {
      pagination = managementPageQuery(request.query) ?? { page: 1, limit: 20 };
    } catch {
      return sendError(reply, 400, 'AUDIT_QUERY_INVALID');
    }
    const from = request.query.from === undefined ? undefined : Number(request.query.from);
    const to = request.query.to === undefined ? undefined : Number(request.query.to);
    if (
      request.query.cursor !== undefined ||
      (request.query.from !== undefined &&
        (typeof request.query.from !== 'string' || !/^\d+$/u.test(request.query.from))) ||
      (request.query.to !== undefined &&
        (typeof request.query.to !== 'string' || !/^\d+$/u.test(request.query.to))) ||
      (from !== undefined && (!Number.isSafeInteger(from) || from < 0)) ||
      (to !== undefined && (!Number.isSafeInteger(to) || to < 0)) ||
      (from !== undefined && to !== undefined && from > to)
    )
      return sendError(reply, 400, 'AUDIT_QUERY_INVALID');
    try {
      return reply.send(
        await audits.query(actor.userId, {
          ...pagination,
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to })
        })
      );
    } catch (error) {
      return databaseError(reply, error);
    }
  });

  app.get<{ Querystring: { format?: string; from?: string; to?: string } }>(
    '/api/audit-events/export',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      if (request.query.format !== 'csv')
        return sendError(reply, 400, 'AUDIT_EXPORT_FORMAT_INVALID');
      const from = request.query.from === undefined ? undefined : Number(request.query.from);
      const to = request.query.to === undefined ? undefined : Number(request.query.to);
      if (
        (from !== undefined && (!Number.isSafeInteger(from) || from < 0)) ||
        (to !== undefined && (!Number.isSafeInteger(to) || to < 0)) ||
        (from !== undefined && to !== undefined && from > to)
      )
        return sendError(reply, 400, 'AUDIT_QUERY_INVALID');
      try {
        const body = await audits.export(actor.userId, {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to })
        });
        reply.header('content-type', 'text/csv; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="audit-events.csv"');
        return reply.send(body);
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );

  app.get<{ Params: { auditEventId: string } }>(
    '/api/audit-events/:auditEventId',
    async (request, reply) => {
      const actor = protectedAdmin(database, request, reply);
      if (actor === undefined) return;
      try {
        const event = await audits.detail(actor.userId, request.params.auditEventId);
        if (event === undefined) return sendError(reply, 404, 'AUDIT_EVENT_NOT_FOUND');
        return reply.header('cache-control', 'private, no-store').send(event);
      } catch (error) {
        return databaseError(reply, error);
      }
    }
  );
}
