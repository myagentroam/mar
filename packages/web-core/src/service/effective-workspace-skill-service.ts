import { ref } from 'vue';

export interface EffectiveWorkspaceSkill {
  readonly name: string;
  readonly description: string;
  readonly localStatus: string;
  readonly source: 'NODE_HOME' | 'WORKSPACE';
  readonly skillFilePath: string;
}

export function createEffectiveWorkspaceSkillService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const skills = ref<readonly EffectiveWorkspaceSkill[]>([]);
  const loading = ref(false);

  async function load(nodeId: string, workspaceId: string): Promise<void> {
    loading.value = true;
    try {
      const result = await request<{ skills: readonly EffectiveWorkspaceSkill[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/effective-skills?nodeId=${encodeURIComponent(nodeId)}`
      );
      skills.value = result.skills;
    } finally {
      loading.value = false;
    }
  }

  return { skills, loading, load };
}
