import { describe, expect, it } from 'vitest';
import {
  skillFavoriteSchema,
  skillFavoriteCreateInputSchema,
  skillFavoritePresentationInputSchema,
  skillInstallMetadataSchema,
  skillSourceInputSchema,
  skillTargetInspectionSchema,
  workbenchNodeOperationSchema
} from '../../src/index.js';

describe('Skill protocol', () => {
  it('strictly distinguishes source scope owners and accepts HTTPS or git@ repositories', () => {
    expect(
      skillSourceInputSchema.parse({
        kind: 'REPOSITORY',
        scope: 'ORGANIZATION',
        organizationId: 3,
        name: 'Team skills',
        locator: 'https://github.com/acme/skills'
      })
    ).toMatchObject({ scope: 'ORGANIZATION', organizationId: 3 });
    expect(
      skillSourceInputSchema.parse({
        kind: 'REPOSITORY',
        scope: 'PERSONAL',
        name: 'Private skills',
        locator: 'git@git.example.com:team/private-skills.git'
      }).locator
    ).toBe('git@git.example.com:team/private-skills.git');
    expect(
      skillSourceInputSchema.safeParse({
        kind: 'REPOSITORY',
        scope: 'PERSONAL',
        organizationId: 3,
        name: 'bad',
        locator: 'file:///tmp/skills'
      }).success
    ).toBe(false);
    expect(
      skillFavoriteCreateInputSchema.safeParse({
        sourceId: 'source-1',
        candidateId: 'acme/skills/review',
        scope: 'PERSONAL',
        featured: true,
        tags: ['Review', 'review']
      }).success
    ).toBe(false);
  });

  it('accepts a repository root as a standard Skill path', () => {
    expect(
      skillFavoriteCreateInputSchema.parse({
        sourceId: 'repo',
        candidateId: 'acme/root-skill',
        skillPath: '.',
        scope: 'PERSONAL'
      }).skillPath
    ).toBe('.');
  });

  it('allows editing only the featured flag and unique tags in catalog presentation metadata', () => {
    expect(
      skillFavoritePresentationInputSchema.parse({ featured: true, tags: ['quality', 'review'] })
    ).toEqual({ featured: true, tags: ['quality', 'review'] });
    expect(
      skillFavoritePresentationInputSchema.safeParse({
        featured: false,
        tags: ['Review', 'review']
      }).success
    ).toBe(false);
    expect(
      skillFavoritePresentationInputSchema.safeParse({
        featured: false,
        tags: [],
        scope: 'ENTERPRISE'
      }).success
    ).toBe(false);
  });

  it('accepts only fixed commits and normalized Skill paths for favorites', () => {
    const favorite = skillFavoriteSchema.parse({
      id: 'favorite-1',
      sourceId: 'source-1',
      scope: 'PERSONAL',
      ownerUserId: 7,
      repositoryIdentity: 'github.com/acme/skills',
      skillPath: 'skills/review',
      normalizedName: 'review',
      featured: true,
      tags: ['quality'],
      currentVersion: {
        id: 'version-1',
        commitSha: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        createdAt: 1
      },
      createdAt: 1,
      updatedAt: 1
    });
    expect(favorite.currentVersion.commitSha).toHaveLength(40);
  });

  it('does not leak repository locator details in installation metadata', () => {
    expect(
      skillInstallMetadataSchema.safeParse({
        schemaVersion: 1,
        favoriteId: 'favorite-1',
        versionId: 'version-1',
        commitSha: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        installedAt: 1,
        repositoryUrl: 'https://example.com/private'
      }).success
    ).toBe(false);
  });

  it('uses closed statuses and allowlisted fixed operations for scan results', () => {
    expect(
      skillTargetInspectionSchema.parse({
        targetKind: 'WORKSPACE',
        compatibilityMode: 'MANAGED_COPY',
        skills: [
          {
            name: 'review',
            description: 'Review code',
            status: 'UPDATE_AVAILABLE',
            installedCommitSha: 'a'.repeat(40),
            favoriteCurrentCommitSha: 'c'.repeat(40)
          }
        ]
      }).skills[0]?.status
    ).toBe('UPDATE_AVAILABLE');
    for (const operation of [
      'node.skills.inspect',
      'node.skills.install',
      'node.skills.remove',
      'workspace.skills.inspect',
      'workspace.skills.install',
      'workspace.skills.remove',
      'workspace.skills.git-exclude-repair'
    ])
      expect(workbenchNodeOperationSchema.safeParse(operation).success).toBe(true);
  });
});
