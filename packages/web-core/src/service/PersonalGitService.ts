import {
  personalGitSummarySchema,
  workspaceGitSettingsSchema,
  type PersonalGitSummary
} from '@myagentroam/protocol';

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Only redacted summaries enter Web state; secret values are write-only request inputs. */
export class PersonalGitService {
  constructor(private readonly request: Request) {}
  read(): Promise<PersonalGitSummary> {
    return this.summary('/api/personal-git');
  }
  createCredential(input: unknown): Promise<PersonalGitSummary> {
    return this.summary('/api/personal-git/credentials', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }
  updateCredential(id: string, input: unknown): Promise<PersonalGitSummary> {
    return this.summary(`/api/personal-git/credentials/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input)
    });
  }
  removeCredential(id: string): Promise<PersonalGitSummary> {
    return this.summary(`/api/personal-git/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }
  async workspacePolicy(nodeId: string, workspaceId: string) {
    return workspaceGitSettingsSchema.parse(
      await this.request(this.policyPath(nodeId, workspaceId), { cache: 'no-store' })
    );
  }
  async saveWorkspacePolicy(
    nodeId: string,
    workspaceId: string,
    preserveGitConfig: boolean,
    includeParentRepository?: boolean
  ) {
    return workspaceGitSettingsSchema.parse(
      await this.request(this.policyPath(nodeId, workspaceId), {
        method: 'PUT',
        cache: 'no-store',
        body: JSON.stringify({
          preserveGitConfig,
          ...(includeParentRepository === undefined ? {} : { includeParentRepository })
        })
      })
    );
  }
  private async summary(path: string, init: RequestInit = {}): Promise<PersonalGitSummary> {
    const response = await this.request<{ configuration?: unknown }>(path, {
      ...init,
      cache: 'no-store'
    });
    const result = personalGitSummarySchema.safeParse(response?.configuration);
    if (!result.success) throw new Error('GIT_CONFIGURATION_INVALID');
    return result.data;
  }
  private policyPath(nodeId: string, workspaceId: string): string {
    return `/api/workspaces/${encodeURIComponent(workspaceId)}/git-policy?nodeId=${encodeURIComponent(nodeId)}`;
  }
}
