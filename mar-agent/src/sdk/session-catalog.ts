import { AgentError } from '../error.js';
import {
  createSessionCatalog,
  type AgentSessionCatalog,
  type OpenAgentSessionCatalogInput
} from '../session/catalog.js';
import { JsonlSessionStore } from '../session/store/jsonl/jsonl-store.js';

export async function openAgentSessionCatalog(
  input: OpenAgentSessionCatalogInput
): Promise<AgentSessionCatalog> {
  const borrowed = input.sessionStore !== undefined;
  if (
    input.sessionStore === null ||
    borrowed === (input.homeDirectory !== undefined) ||
    (!borrowed && (typeof input.homeDirectory !== 'string' || !input.homeDirectory))
  )
    throw new AgentError(
      'MAR_AGENT_SESSION_STORE_INVALID',
      'Specify exactly one Session store or home directory.'
    );
  const store = input.sessionStore ?? (await JsonlSessionStore.open(input.homeDirectory!));
  return createSessionCatalog(store, borrowed);
}
