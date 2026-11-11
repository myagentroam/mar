import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseComposerTags, serializeComposerTag } from '@myagentroam/protocol';
import {
  composerResourceInputTags,
  prepareComposerResourceInput,
  withSessionMessageOrigin,
  validateComposerSkills
} from '../../src/service/composer-message-input.js';
import { sessionTitleFromFirstMessage } from '../../src/session/input-validation.js';
import { withNonImageAttachmentPrompt } from '../../src/session/attachments.js';
import { GoalRuntime, publicGoalHistoryText } from '../../src/service/goal-runtime.js';

const reference = serializeComposerTag('mar_references', {
  references: [{ type: 'file', path: 'src/main.ts', label: 'main.ts' }]
});
describe('Product resource input preparation', () => {
  it('preserves session references while deriving paths only for files and directories', () => {
    const session = { type: 'session' as const, sessionId: 'session-42', label: 'Review & <fix>' };
    const input = serializeComposerTag('mar_references', {
      references: [
        session,
        { type: 'file', path: 'src/main.ts', label: 'main.ts' },
        { type: 'directory', path: 'test', label: 'test' }
      ]
    });
    const parts = parseComposerTags(prepareComposerResourceInput(input, '/repo/subdir', '/repo'));
    expect(parts.find((part) => part.kind === 'mar_references')?.payload.references).toEqual([
      session,
      { type: 'file', path: 'src/main.ts', label: 'main.ts', runnerPath: '../src/main.ts' },
      { type: 'directory', path: 'test', label: 'test', runnerPath: '../test' }
    ]);
  });

  it('derives Runner paths only for files and directories while preserving quote snapshots', () => {
    const references = [
      { type: 'file' as const, path: 'src/main.ts', label: 'main.ts' },
      { type: 'directory' as const, path: 'test', label: 'test' },
      { type: 'session' as const, sessionId: 'session-42', label: 'Review' },
      {
        type: 'quote' as const,
        id: 'quote-file',
        label: 'history.ts:12–13',
        source: 'file' as const,
        path: 'src/history.ts',
        origin: 'HISTORY' as const,
        revision: 'commit-42',
        startLine: 12,
        endLine: 13,
        unsaved: false,
        text: '  return &lt;cached snapshot&gt;;  '
      },
      {
        type: 'quote' as const,
        id: 'quote-diff',
        label: 'restore.ts:20–21',
        source: 'diff' as const,
        path: 'src/restore.ts',
        origin: 'TOOL_CHANGE' as const,
        side: 'mixed' as const,
        startLine: 20,
        endLine: 21,
        oldStartLine: 19,
        oldEndLine: 20,
        text: '+ return result;\n- return undefined;'
      },
      {
        type: 'quote' as const,
        id: 'quote-assistant',
        label: 'Assistant response',
        source: 'assistant' as const,
        messageId: 'message-42',
        streaming: true,
        text: 'The selected assistant excerpt.'
      }
    ];
    const input = serializeComposerTag('mar_references', { references });
    const parts = parseComposerTags(prepareComposerResourceInput(input, '/repo/subdir', '/repo'));
    const preparedReferences = parts.find((part) => part.kind === 'mar_references')?.payload
      .references;

    expect(preparedReferences).toEqual([
      { ...references[0], runnerPath: '../src/main.ts' },
      { ...references[1], runnerPath: '../test' },
      references[2],
      references[3],
      references[4],
      references[5]
    ]);
    expect(preparedReferences?.slice(3)).toEqual(references.slice(3));
    expect(preparedReferences?.[5]).not.toHaveProperty('path');
    expect(preparedReferences?.[5]).not.toHaveProperty('runnerPath');
  });

  it('rejects Runner-path-expanded references over the byte cap without changing the input', () => {
    const directory = Array.from({ length: 15 }, () => 'a'.repeat(250)).join('/');
    const references = Array.from({ length: 20 }, (_, index) => ({
      type: 'file' as const,
      path: `${directory}/file-${String(index).padStart(2, '0')}-${'b'.repeat(180)}`,
      label: `file-${index}`
    }));
    const input = serializeComposerTag('mar_references', { references });
    const originalInput = input;

    expect(input.length).toBeLessThan(100_000);
    expect(new TextEncoder().encode(input).byteLength).toBeLessThan(128 * 1024);
    expect(() => prepareComposerResourceInput(input, '/repo', '/repo')).toThrow(
      'COMPOSER_TAG_INVALID'
    );
    expect(input).toBe(originalInput);
    expect(parseComposerTags(input)).toMatchObject([
      { kind: 'mar_references', payload: { references } }
    ]);
  });

  it('keeps the admitted origin beside Goal markup without retaining forwarded provenance', () => {
    const oldTag = serializeComposerTag('mar_session_origin', {
      sessionId: 'old',
      name: 'Old sender'
    });
    const origin = { sessionId: 'coordinator', name: 'Coordinator#42 A & <B>' };
    const visible = serializeComposerTag('mar_goal_start', { objective: 'Review' });
    const input = withSessionMessageOrigin(
      visible + '\n' + oldTag + '\n' + reference,
      origin,
      'coordinator'
    );
    const snapshot = { ...origin, relation: 'parent' as const };
    expect(input.startsWith(visible)).toBe(true);
    expect(
      parseComposerTags(input)
        .filter((part) => part.kind === 'mar_session_origin')
        .map((part) => part.payload)
    ).toEqual([snapshot]);
    expect(publicGoalHistoryText(input)).toContain(visible);
    expect(publicGoalHistoryText(input)).toContain(
      serializeComposerTag('mar_session_origin', snapshot)
    );
    expect(sessionTitleFromFirstMessage(withSessionMessageOrigin('Review code', origin))).toBe(
      'Review code'
    );
    expect(prepareComposerResourceInput(input, '/repo', '/repo')).toContain('mar_session_origin');
    expect(withSessionMessageOrigin(input, undefined)).toBe(input);
    expect(withSessionMessageOrigin('From terminal', {})).toContain('Message sent via marctl.');
    const unfinished = '```xml\n<mar_unknown>unfinished';
    const marked = withSessionMessageOrigin(unfinished, origin);
    expect(parseComposerTags(marked)[0]).toMatchObject({
      kind: 'mar_session_origin',
      payload: origin
    });
    expect(marked.endsWith(unfinished)).toBe(true);
  });
  it.each(['child', 'descendant'] as const)(
    'preserves the admitted %s origin beside Goal markup',
    (relation) => {
      const origin = { sessionId: 'source', name: 'Source', relation };
      const input = withSessionMessageOrigin('Report', origin, 'recipient-parent');
      expect(parseComposerTags(input)).toMatchObject([
        { kind: 'mar_session_origin', payload: origin },
        { kind: 'text', text: '\nReport' }
      ]);
      expect(withSessionMessageOrigin('Reply', origin, 'source')).toContain('relation="parent"');
    }
  );

  it('rechecks effective Skill identity and preserves Node Home paths without reading content into input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'composer-skill-'));
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const skillPath = join(home, '.agents/skills/review/SKILL.md');
    const tag = (path: string, source: 'NODE_HOME' | 'WORKSPACE' = 'NODE_HOME') =>
      serializeComposerTag('mar_skills', {
        action: 'use',
        instruction: 'Use selected skills',
        skills: [{ name: 'review', source, path }]
      });
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(join(home, '.agents/skills/review'), { recursive: true });
      await writeFile(
        skillPath,
        '---\nname: review\ndescription: Review code\n---\nPrivate Skill content'
      );
      await expect(
        validateComposerSkills(tag(skillPath), workspace, home)
      ).resolves.toBeUndefined();
      expect(
        prepareComposerResourceInput(tag(skillPath), join(workspace, 'subdir'), workspace)
      ).toBe(tag(skillPath));
      await expect(
        validateComposerSkills(tag(join(home, 'wrong.md')), workspace, home)
      ).rejects.toThrow('MESSAGE_INVALID');
      await mkdir(join(workspace, '.claude/skills/review'), { recursive: true });
      await writeFile(
        join(workspace, '.claude/skills/review/SKILL.md'),
        '---\nname: review\ndescription: Claude-only override\n---\n'
      );
      await expect(
        validateComposerSkills(tag(skillPath), workspace, home)
      ).resolves.toBeUndefined();
      await expect(
        validateComposerSkills(tag('.claude/skills/review/SKILL.md', 'WORKSPACE'), workspace, home)
      ).rejects.toThrow('MESSAGE_INVALID');
      await mkdir(join(workspace, '.agents/skills/review'), { recursive: true });
      await writeFile(join(workspace, '.agents/skills/review/SKILL.md'), 'Workspace Skill');
      await expect(validateComposerSkills(tag(skillPath), workspace, home)).rejects.toThrow(
        'MESSAGE_INVALID'
      );
      await expect(
        validateComposerSkills(tag('.agents/skills/review/SKILL.md', 'WORKSPACE'), workspace, home)
      ).resolves.toBeUndefined();
      await rm(join(workspace, '.agents/skills/review'), { recursive: true });
      await expect(
        validateComposerSkills(tag('.agents/skills/review/SKILL.md', 'WORKSPACE'), workspace, home)
      ).rejects.toThrow('MESSAGE_INVALID');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['/repo', '/repo/subdir'])(
    'keeps the Workspace resource identity and derives the Runner path (%s)',
    (cwd) => {
      const part = parseComposerTags(prepareComposerResourceInput(reference, cwd, '/repo'))[0];
      expect(part).toMatchObject({
        kind: 'mar_references',
        payload: {
          references: [
            { path: 'src/main.ts', runnerPath: cwd === '/repo' ? 'src/main.ts' : '../src/main.ts' }
          ]
        }
      });
    }
  );
  it('replaces old file tags once when rebuilding edited input without losing metadata', () => {
    const path = '.mar/temp-files/q/notes.pdf';
    const files = [
      { name: 'notes.pdf', mime: 'application/pdf', path: `../${path}`, workspacePath: path }
    ];
    const original = withNonImageAttachmentPrompt(`Read\n${reference}`, [path]);
    const rebuilt = withNonImageAttachmentPrompt(original, [path], files);
    expect(parseComposerTags(rebuilt).filter((p) => p.kind === 'mar_attachments')).toEqual([
      expect.objectContaining({ payload: { files } })
    ]);
    expect(rebuilt).toContain('<mar_references>');
    expect(rebuilt).not.toContain('application/octet-stream');
  });
  it('keeps hidden selections outside the Goal objective and safe history in subsequent turns', () => {
    const goals = new GoalRuntime(() => undefined);
    goals.start('session', 'Review the source', reference);
    const start = goals.prompt('session', 'start');
    expect(start.indexOf(reference)).toBeGreaterThan(start.indexOf('</mar_goal_start>'));
    const publicHistory = publicGoalHistoryText(start);
    const publicStart = serializeComposerTag('mar_goal_start', { objective: 'Review the source' });
    expect(publicHistory).toContain(publicStart);
    expect(publicHistory.indexOf(reference)).toBeGreaterThan(publicHistory.indexOf(publicStart));
    expect(publicHistory).not.toContain('Continue executing this Goal');
    expect(
      parseComposerTags(publicHistory)
        .filter((part) => part.kind !== 'text')
        .map((part) => part.kind)
    ).toEqual(['mar_goal_start', 'mar_references']);
    expect(goals.prompt('session', 'continue')).toContain(reference);
    expect(sessionTitleFromFirstMessage(reference)).toBe('');
    expect(sessionTitleFromFirstMessage(`Title\n${reference}`)).toBe('Title');
  });

  it('retains quote and other resource tags through continuous Goal execution', () => {
    const skill = serializeComposerTag('mar_skills', {
      action: 'use',
      instruction: 'Use the selected Skill.',
      skills: [{ name: 'review', source: 'WORKSPACE', path: '.agents/skills/review/SKILL.md' }]
    });
    const quote = serializeComposerTag('mar_references', {
      references: [
        {
          type: 'quote',
          id: 'quote-1',
          label: 'main.ts:8',
          source: 'file',
          path: 'src/main.ts',
          origin: 'WORKING_TREE',
          startLine: 8,
          endLine: 8,
          text: '  return <selected>;  '
        }
      ]
    });
    const attachment = serializeComposerTag('mar_attachments', {
      files: [
        {
          name: 'context.txt',
          mime: 'text/plain',
          path: '.mar/temp-files/input/context.txt'
        }
      ]
    });
    const resources = [skill, quote, attachment].join('\n');
    const goals = new GoalRuntime(() => undefined);

    expect(composerResourceInputTags(`Review the context.\n${resources}`)).toBe(resources);
    goals.start('session', 'Review the selected source', resources);
    expect(goals.prompt('session', 'start')).toContain(resources);
    expect(goals.prompt('session', 'continue')).toContain(resources);
  });
});
