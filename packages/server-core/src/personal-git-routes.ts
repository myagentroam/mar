import type { FastifyInstance, FastifyReply } from 'fastify';
import { isAllowedOrigin } from './auth.js';
import { protectedAdmin, validCsrf, type SessionLookup } from './session.js';
import { sendError } from './http-errors.js';
import type { PersonalGitService } from './personal-git-service.js';

export function registerPersonalGitRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: SessionLookup;
  readonly service: PersonalGitService;
  readonly publicOrigin: string | undefined;
  readonly databaseError: (reply: FastifyReply, error: unknown) => FastifyReply;
}): void {
  const { app, database, service, publicOrigin, databaseError } = input;
  for (const [method, url, write, action] of [
    ['GET', '/api/personal-git', false, (user: number) => service.get(user)],
    [
      'POST',
      '/api/personal-git/credentials',
      true,
      (user: number, body: unknown) => service.createCredential(user, body)
    ],
    [
      'PUT',
      '/api/personal-git/credentials/:credentialId',
      true,
      (user: number, body: unknown, id: string) => service.updateCredential(user, id, body)
    ],
    [
      'DELETE',
      '/api/personal-git/credentials/:credentialId',
      true,
      (user: number, _body: unknown, id: string) => service.removeCredential(user, id)
    ]
  ] as const) {
    app.route<{ Params: { credentialId?: string }; Body: unknown }>({
      method,
      url,
      bodyLimit: 128 * 1024,
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        if (write && !isAllowedOrigin(request, publicOrigin))
          return sendError(reply, 403, 'ORIGIN_NOT_ALLOWED');
        const actor = protectedAdmin(database, request, reply);
        if (actor === undefined) return;
        if (write && !validCsrf(request, actor)) return sendError(reply, 403, 'CSRF_INVALID');
        try {
          return reply.code(method === 'POST' ? 201 : 200).send({
            configuration: await action(
              actor.userId,
              request.body,
              request.params.credentialId ?? ''
            )
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'GIT_CREDENTIAL_NOT_FOUND') return sendError(reply, 404, code);
          if (code === 'GIT_CREDENTIAL_SCOPE_CONFLICT') return sendError(reply, 409, code);
          if (code === 'GIT_CONFIGURATION_INVALID' || code === 'GIT_CREDENTIAL_PROTOCOL_IMMUTABLE')
            return sendError(reply, 400, code);
          return databaseError(reply, error);
        }
      }
    });
  }
}
