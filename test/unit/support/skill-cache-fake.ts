import type { Pool } from 'mysql2/promise';
import type { ResolvedSkillBundle } from '../../../packages/server-core/src/github-skill-provider.js';

export function skillBundle(character = 'a'): ResolvedSkillBundle {
  return {
    repositoryIdentity: 'github.com/acme/skills',
    repositoryUrl: 'https://github.com/acme/skills',
    skillPath: 'skills/review',
    name: 'review',
    description: 'Review code',
    commitSha: character.repeat(40),
    contentHash: character.repeat(64),
    archiveHash: 'f'.repeat(64),
    contentBytes: 10,
    tlsVerified: true,
    files: [{ path: 'SKILL.md', contentBase64: 'YQ==' }]
  };
}

export function gate(timeoutMs = 2_000) {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const bounded = (signal: Promise<void>, phase: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SKILL_CACHE_GATE_${phase}_TIMEOUT`)),
        timeoutMs
      );
      void signal.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  return {
    get entered() {
      return bounded(entered, 'ENTRY');
    },
    release,
    wait: async () => {
      enter();
      await bounded(released, 'RELEASE');
    }
  };
}

export const favoriteInput = {
  sourceId: 'repo-1',
  candidateId: 'acme/skills/review',
  skillPath: 'skills/review',
  scope: 'PERSONAL'
};

type Row = Record<string, unknown>;

/** A deterministic SQL/lock fake, not evidence of MySQL exclusion. */
export class SkillCacheFake {
  readonly favorites = new Map<string, Row>();
  readonly versions = new Map<string, Row>();
  readonly locks = new Map<string, Promise<void>>();
  beforeConnection: () => Promise<void> = async () => {};
  beforeSql: (sql: string, values: readonly unknown[]) => Promise<void> = async () => {};
  beforeCommit: () => Promise<void> = async () => {};
  released = 0;
  destroyed = 0;
  raw = {
    execute: async (sql: string, values: readonly unknown[] = []) => {
      await this.beforeSql(sql, values);
      if (sql.includes('COUNT(*)'))
        return [
          [
            {
              total: [...this.favorites.values()].filter((row) => row['owner_key'] === values[0])
                .length
            }
          ],
          []
        ];
      if (sql.includes('SELECT * FROM skill_favorites'))
        return [[this.favorites.get(String(values[0]))].filter(Boolean), []];
      if (sql.includes('SELECT DISTINCT cache_key'))
        return [
          [...this.versions.values()].filter((version) => version['favorite_id'] === values[0]),
          []
        ];
      if (sql.includes('UPDATE skill_versions version')) {
        for (const version of this.versions.values()) {
          const referenced = [...this.favorites.values()].some(
            (favorite) => favorite['current_version_id'] === version['id']
          );
          if (!referenced && version['cache_state'] === 'READY')
            version['unreferenced_at'] ??= values[0];
        }
        return [{ affectedRows: 1 }, []];
      }
      throw new Error(`UNEXPECTED_POOL_SQL: ${sql}`);
    },
    getConnection: async () => {
      await this.beforeConnection();
      const pending: Array<() => void> = [];
      let unlock: (() => void) | undefined;
      return {
        execute: async (sql: string, values: readonly unknown[] = []) => {
          await this.beforeSql(sql, values);
          if (sql.includes('DATABASE()')) return [[{ database_name: 'fake' }], []];
          if (sql.includes('GET_LOCK')) {
            const key = String(values[0]);
            const previous = this.locks.get(key);
            const current = new Promise<void>((resolve) => (unlock = resolve));
            this.locks.set(key, current);
            await previous;
            return [[{ acquired: 1 }], []];
          }
          if (sql.includes('RELEASE_LOCK')) {
            unlock?.();
            return [[{ released: 1 }], []];
          }
          if (sql.includes('cached_versions')) return [[{ total: 0 }], []];
          if (sql.includes('COUNT(*) AS total FROM skill_favorites'))
            return [
              [
                {
                  total: [...this.favorites.values()].filter(
                    (row) => row['owner_key'] === values[0]
                  ).length
                }
              ],
              []
            ];
          if (sql.includes('SELECT id FROM users')) return [[{ id: values[0] }], []];
          if (sql.includes('SELECT id,enabled FROM skill_sources'))
            return [[{ id: values[0], enabled: 1 }], []];
          if (sql.includes('SELECT DISTINCT cache_key'))
            return [
              [...this.versions.values()].filter((version) => version['favorite_id'] === values[0]),
              []
            ];
          if (sql.includes('SELECT version.cache_key'))
            return [
              [...this.favorites.values()]
                .filter(
                  (favorite) =>
                    this.versions.get(String(favorite['current_version_id']))?.['cache_key'] ===
                    values[0]
                )
                .map(() => ({ cache_key: values[0] })),
              []
            ];
          if (sql.includes('MIN(unreferenced_at)')) {
            const versions = [...this.versions.values()].filter(
              (version) => version['cache_key'] === values[0] && version['cache_state'] === 'READY'
            );
            const times = versions
              .filter((v) => v['unreferenced_at'] != null)
              .map((v) => Number(v['unreferenced_at']));
            return [
              [
                {
                  versions: versions.length,
                  unreferenced_at: times.length ? Math.min(...times) : null
                }
              ],
              []
            ];
          }
          if (sql.includes('SELECT favorite.id,version.cache_key')) {
            const favorite = this.favorites.get(String(values[0]));
            return [
              favorite
                ? [
                    {
                      id: favorite['id'],
                      cache_key: this.versions.get(String(favorite['current_version_id']))?.[
                        'cache_key'
                      ]
                    }
                  ]
                : [],
              []
            ];
          }
          if (sql.includes('INSERT INTO skill_favorites')) {
            pending.push(() =>
              this.favorites.set(String(values[0]), {
                id: values[0],
                source_id: values[1],
                scope: values[2],
                owner_user_id: values[4],
                repository_url: values[5],
                skill_path: values[7],
                normalized_name: values[8],
                owner_key: values.at(-1),
                created_at: values[12]
              })
            );
          } else if (sql.includes('INSERT INTO skill_versions')) {
            pending.push(() =>
              this.versions.set(String(values[0]), {
                id: values[0],
                favorite_id: values[1],
                commit_sha: values[2],
                cache_key: values[5],
                cache_state: 'READY',
                unreferenced_at: null
              })
            );
          } else if (sql.includes('UPDATE skill_favorites SET current_version_id')) {
            pending.push(() => {
              this.favorites.get(String(values.at(-1)))!['current_version_id'] = values[0];
            });
          } else if (sql.includes('SELECT id FROM skill_favorites')) {
            return [[this.favorites.get(String(values[0]))].filter(Boolean), []];
          } else if (sql.includes('DELETE FROM skill_versions')) {
            pending.push(() => {
              for (const [id, version] of this.versions)
                if (version['favorite_id'] === values[0]) this.versions.delete(id);
            });
          } else if (sql.includes('DELETE FROM skill_favorites')) {
            pending.push(() => this.favorites.delete(String(values[0])));
          } else if (sql.includes('UPDATE skill_versions version')) {
            pending.push(() => {
              for (const version of this.versions.values()) {
                const referenced = [...this.favorites.values()].some(
                  (favorite) => favorite['current_version_id'] === version['id']
                );
                if (
                  !referenced &&
                  version['cache_key'] === values[1] &&
                  version['cache_state'] === 'READY'
                )
                  version['unreferenced_at'] = values[0];
              }
            });
          } else if (sql.includes('SET unreferenced_at=NULL WHERE content_hash=')) {
            pending.push(() => {
              for (const version of this.versions.values())
                if (version['cache_key'] === values[0] && version['cache_state'] === 'READY')
                  version['unreferenced_at'] = null;
            });
          } else if (sql.includes('SELECT id FROM skill_versions')) {
            return [
              [...this.versions.values()].filter(
                (v) => v['favorite_id'] === values[0] && v['commit_sha'] === values[1]
              ),
              []
            ];
          } else if (sql.includes("SET cache_state='TRASHED'")) {
            pending.push(() => {
              for (const version of this.versions.values())
                if (version['cache_key'] === values[1]) version['cache_state'] = 'TRASHED';
            });
          } else if (sql.includes("SET cache_state='READY'")) {
            pending.push(() =>
              Object.assign(this.versions.get(String(values[0]))!, {
                cache_state: 'READY',
                unreferenced_at: null
              })
            );
          } else throw new Error(`UNEXPECTED_CONNECTION_SQL: ${sql}`);
          return [{ affectedRows: 1 }, []];
        },
        beginTransaction: async () => {},
        commit: async () => {
          await this.beforeCommit();
          pending.forEach((operation) => operation());
        },
        rollback: async () => {
          pending.length = 0;
        },
        on: () => {},
        removeListener: () => {},
        release: () => {
          this.released++;
        },
        destroy: () => {
          this.destroyed++;
          unlock?.();
        }
      };
    }
  } as unknown as Pool;
}
