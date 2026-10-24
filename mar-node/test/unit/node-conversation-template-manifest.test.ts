import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isReservedTemplateSourcePath,
  isTemplateRuntimeLinkTarget,
  parseTemplateVersionManifest,
  templateContentHash,
  templateManifestHash,
  templateMcpConfigHash
} from '../../src/service/conversation-template-manifest.js';

// Captured from the real publisher before extracting the format owner.
const manifestText = readFileSync(
  new URL('./support/template-version-manifest-v2.txt', import.meta.url),
  'utf8'
);
const manifest = parseTemplateVersionManifest(JSON.parse(manifestText));
const file = manifest.entries[1]!;
const link = manifest.entries[0]!;
const runtimeLink = manifest.entries[3]!;
const mcp = manifest.mcpServers[0]!;

describe('template version manifest format', () => {
  it('preserves the original JSON and all three known hashes without sorting', () => {
    expect(templateManifestHash(manifestText)).toBe(
      '888eabbe6c7987c1bb446b6e67098047865dab96bb802602f8d60417bc4ed029'
    );
    expect(templateContentHash(manifest.directories, manifest.entries)).toBe(
      'c182488cea50bb4b8975c47b544e20729671000c49354bf1e2594c720fdab0b8'
    );
    expect(templateMcpConfigHash(manifest.mcpServers)).toBe(
      '1cc721806e02d0c9554fda333d2f02f9554d7d1b87fc8a98827c49f677556d66'
    );
    expect(templateManifestHash(`${manifestText}\n`)).toBe(templateManifestHash(manifestText));
    expect(templateManifestHash(`${manifestText}\n\n`)).not.toBe(
      templateManifestHash(manifestText)
    );
    expect(templateContentHash(manifest.directories, [...manifest.entries].reverse())).not.toBe(
      manifest.contentHash
    );
    const { id, ...remainingMcpFields } = mcp;
    expect(templateMcpConfigHash([{ ...remainingMcpFields, id }])).not.toBe(manifest.mcpConfigHash);
    expect(manifest.entries.map((entry) => entry.kind)).toEqual([
      'SYMLINK',
      'FILE',
      'FILE',
      'SYMLINK'
    ]);
    expect(manifest.entries[2]).toMatchObject({ executable: true });
  });

  it.each([
    ['schema', { schemaVersion: 1 }],
    ['draft', { draft: {} }],
    ['relative source', { sourceWorkspacePath: 'projects/template' }],
    ['noncanonical source', { sourceWorkspacePath: '/projects/../template' }],
    ['reserved source', { sourceWorkspacePath: '/tmp/template' }],
    ['root source', { sourceWorkspacePath: '/' }],
    ['directories type', { directories: null }],
    ['duplicate directories', { directories: ['lib', 'lib'] }],
    ['reserved directory', { directories: ['inbox'] }],
    ['traversal directory', { directories: ['../lib'] }],
    ['empty path segment', { directories: ['lib//data'] }],
    ['backslash path', { directories: ['lib\\data'] }],
    ['duplicate entries', { entries: [file, file] }],
    ['absolute file path', { entries: [{ ...file, relativePath: '/file' }] }],
    ['file size', { entries: [{ ...file, size: -1 }] }],
    ['file hash', { entries: [{ ...file, sha256: 'A'.repeat(64) }] }],
    ['file executable', { entries: [{ ...file, executable: 1 }] }],
    ['entry kind', { entries: [{ ...file, kind: 'DIRECTORY' }] }],
    ['link byte size', { entries: [{ ...link, size: 1 }] }],
    ['link NUL', { entries: [{ ...link, linkTarget: '\0' }] }],
    ['snapshot target escape', { entries: [{ ...link, resolvedTarget: '../lib' }] }],
    ['runtime target escape', { entries: [{ ...runtimeLink, resolvedTarget: '/usr/../etc' }] }],
    ['runtime target prefix', { entries: [{ ...runtimeLink, resolvedTarget: '/usr-other' }] }],
    ['MCP type', { mcpServers: {} }],
    ['MCP unexpected key', { mcpServers: [{ ...mcp, extra: true }] }],
    ['MCP origin', { mcpServers: [{ ...mcp, origin: 'BUILTIN' }] }],
    ['MCP transport', { mcpServers: [{ ...mcp, transport: 'HTTP' }] }],
    ['MCP runtime', { mcpServers: [{ ...mcp, runtime: {} }] }],
    ['MCP configuration', { mcpServers: [{ ...mcp, configuration: null }] }]
  ])('rejects malformed %s with the stable corruption code', (_label, override) => {
    expect(() =>
      parseTemplateVersionManifest({ ...JSON.parse(manifestText), ...override })
    ).toThrow('CONVERSATION_TEMPLATE_VERSION_CORRUPTED');
  });

  it('rejects non-record input and preserves the existing path boundaries', () => {
    expect(() => parseTemplateVersionManifest(null)).toThrow(
      'CONVERSATION_TEMPLATE_VERSION_CORRUPTED'
    );
    for (const root of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
      expect(isTemplateRuntimeLinkTarget(root)).toBe(true);
      expect(isTemplateRuntimeLinkTarget(`${root}/tool`)).toBe(true);
    }
    expect(isTemplateRuntimeLinkTarget('/usr-extra')).toBe(false);
    expect(isTemplateRuntimeLinkTarget('usr/tool')).toBe(false);
    expect(isReservedTemplateSourcePath('/home')).toBe(true);
    expect(isReservedTemplateSourcePath('/home/mar/project')).toBe(true);
    expect(isReservedTemplateSourcePath('/projects/manifest-vector')).toBe(false);
  });
});
