import { describe, expect, it } from 'vitest';
import { effectiveSkills } from '../../ee/server/src/route/skill-target-routes.js';

describe('Effective Workspace skills', () => {
  it('Merges Node HOME and Workspace skills with Workspace names taking precedence', () => {
    expect(
      effectiveSkills(
        {
          skills: [
            { name: 'review', description: 'Node 版本', localStatus: 'VALID' },
            { name: 'deploy', description: '部署', localStatus: 'VALID' }
          ]
        },
        {
          skills: [{ name: 'review', description: 'Workspace 版本', localStatus: 'PARTIAL' }]
        }
      )
    ).toEqual([
      expect.objectContaining({ name: 'deploy', source: 'NODE_HOME' }),
      expect.objectContaining({
        name: 'review',
        description: 'Workspace 版本',
        localStatus: 'PARTIAL',
        source: 'WORKSPACE'
      })
    ]);
  });
});
