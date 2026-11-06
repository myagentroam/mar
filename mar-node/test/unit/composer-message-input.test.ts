import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseComposerTags, serializeComposerTag } from '@myagentroam/protocol';
import {
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
});
