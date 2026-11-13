import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

test(
  'streams a large Skill through cache, artifact download and both Workspace copies',
  { timeout: 90_000 },
  async () => {
    const script = String.raw`
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { createReadStream, createWriteStream } from 'node:fs';
    import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { Readable } from 'node:stream';
    import { pipeline } from 'node:stream/promises';
    import { finalizeSkillBundle } from './packages/server-core/dist/skill-bundle.js';
    import { SkillArtifactService } from './packages/server-core/dist/skill-artifact-service.js';
    import { downloadSkillBundle } from './mar-node/dist/service/skill-bundle-download.js';
    import { SkillInstallService } from './mar-node/dist/service/skill-install-service.js';

    const root = await mkdtemp(path.join(tmpdir(), 'mar-skill-memory-'));
    let bundle;
    let downloaded;
    try {
      const size = 64 * 1024 * 1024;
      const skill = path.join(root, 'SKILL.md');
      const payload = path.join(root, 'large.bin');
      await writeFile(skill, '---\nname: review\ndescription: Review code\n---\n');
      await writeFile(payload, 'binary-start');
      for (const file of [skill, payload]) {
        const handle = await open(file, 'r+');
        try {
          await handle.truncate(size);
          await handle.write(Buffer.from([0xff]), 0, 1, size - 1);
        } finally { await handle.close(); }
      }
      bundle = await finalizeSkillBundle({
        repositoryUrl: 'https://example.com/acme/skills',
        repositoryIdentity: 'example.com/acme/skills',
        skillPath: 'skills/review',
        commitSha: 'a'.repeat(40),
        tlsVerified: true,
        files: [
          { path: 'SKILL.md', open: () => createReadStream(skill) },
          { path: 'large.bin', open: () => createReadStream(payload) }
        ]
      });
      const cache = path.join(root, 'cache');
      await mkdir(cache);
      const archive = path.join(cache, bundle.contentHash + '.json');
      await pipeline(bundle.archive(), createWriteStream(archive));
      await bundle.dispose();
      const artifacts = new SkillArtifactService(cache);
      const token = artifacts.issue('node-a', { contentHash: bundle.contentHash });
      downloaded = await downloadSkillBundle(Readable.toWeb(await artifacts.consume(token, 'node-a')), bundle.contentHash);
      const workspace = path.join(root, 'workspace');
      await mkdir(workspace);
      execFileSync('git', ['init', '--initial-branch=main', workspace], { stdio: 'ignore' });
      await new SkillInstallService().installWorkspace(workspace, 'review', downloaded, {
        schemaVersion: 1, favoriteId: 'favorite-1', versionId: 'version-1',
        commitSha: bundle.commitSha, contentHash: bundle.contentHash, installedAt: 1
      });
      for (const target of ['.agents', '.claude']) {
        for (const name of ['SKILL.md', 'large.bin']) {
          const file = path.join(workspace, target, 'skills', 'review', name);
          assert.equal((await stat(file)).size, size);
          const handle = await open(file, 'r');
          try {
            const byte = Buffer.alloc(1);
            await handle.read(byte, 0, 1, size - 1);
            assert.equal(byte[0], 0xff);
          } finally { await handle.close(); }
        }
      }
      console.log(JSON.stringify({ contentBytes: bundle.contentBytes, archiveBytes: (await stat(archive)).size, fileCount: bundle.fileCount }));
    } finally {
      await downloaded?.dispose();
      await bundle?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  `;
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../..', import.meta.url),
      timeout: 85_000,
      maxBuffer: 128 * 1024
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.contentBytes, 128 * 1024 * 1024);
    assert.ok(result.archiveBytes > result.contentBytes);
    assert.equal(result.fileCount, 2);
    console.log(JSON.stringify(result));
  }
);
