import type { CodexModelCatalog } from '@myagentroam/protocol';
import { normalizeCatalog, normalizeChatgptCatalog } from './codex-catalog-adapter.js';
import type { CredentialRecord } from './credential-document.js';
import { safeJson } from './credential-provider-values.js';
import { assertXaiResponse, normalizeXaiCatalog } from './xai-oauth-provider.js';

/** Owns deduplication and freshness of credential-backed catalog reads. */
export class CredentialCatalogService {
  readonly #flights = new Map<string, Promise<CodexModelCatalog>>();

  constructor(
    private readonly input: {
      readonly resolve: (id: string, force: boolean) => Promise<CredentialRecord>;
      readonly response: (credential: CredentialRecord) => Promise<Response>;
      readonly markReauthentication: (id: string, credential: CredentialRecord) => Promise<boolean>;
      readonly accept: (id: string, credential: CredentialRecord) => Promise<boolean>;
      readonly now: () => number;
    }
  ) {}

  load(id: string): Promise<CodexModelCatalog> {
    const existing = this.#flights.get(id);
    if (existing !== undefined) return existing;
    const flight = this.#load(id).finally(() => {
      if (this.#flights.get(id) === flight) this.#flights.delete(id);
    });
    this.#flights.set(id, flight);
    return flight;
  }

  async #load(id: string): Promise<CodexModelCatalog> {
    for (let freshnessAttempt = 0; freshnessAttempt < 2; freshnessAttempt++) {
      let credential = await this.input.resolve(id, false);
      let response = await this.input.response(credential);
      if (response.status === 401) {
        credential = await this.input.resolve(id, true);
        response = await this.input.response(credential);
      }
      if (response.status === 401) {
        if (!(await this.input.markReauthentication(id, credential))) continue;
        throw new Error('CODEX_CREDENTIAL_REAUTH_REQUIRED');
      }
      if (credential.type === 'XAI_OAUTH') assertXaiResponse(response, 'XAI_CATALOG_LOAD_FAILED');
      if (!response.ok) throw new Error('CODEX_CATALOG_LOAD_FAILED');
      const catalog =
        credential.type === 'XAI_OAUTH'
          ? normalizeXaiCatalog(await safeJson(response), this.input.now())
          : credential.type === 'CHATGPT_OAUTH'
            ? normalizeChatgptCatalog(await safeJson(response), this.input.now())
            : normalizeCatalog(await safeJson(response), this.input.now());
      if (await this.input.accept(id, credential)) return catalog;
    }
    throw new Error('CODEX_CATALOG_LOAD_FAILED');
  }
}
