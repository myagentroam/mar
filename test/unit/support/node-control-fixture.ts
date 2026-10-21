import type { ServerDatabase } from '../../../ee/server/src/database.js';

export function registerOwnedNode(database: ServerDatabase): string {
  const token = database.createNodeRegistrationToken(database.getAdmin().id);
  const registered = database.registerNode(token.token, { metadata: '{}' });
  if (registered === undefined) throw new Error('NODE_FIXTURE_REGISTRATION_FAILED');
  return registered.nodeId;
}
