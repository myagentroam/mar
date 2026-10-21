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
import {
  withNonImageAttachmentPrompt,
  sessionTitleFromFirstMessage
} from '../../src/util/node-operation-parsers.js';
import { GoalRuntime, publicGoalHistoryText } from '../../src/service/goal-runtime.js';

const reference = serializeComposerTag('mar_references', {
  references: [{ type: 'file', path: 'src/main.ts', label: 'main.ts' }]
});
describe('Product resource input preparation', () => {
  it('keeps the admitted origin beside Goal markup without retaining forwarded provenance', () => {
    const oldTag = serializeComposerTag('mar_session_origin', {
      sessionId: 'old',
      name: 'Old sender'
    });
    const origin = { sessionId: 'coordinator', name: 'Coordinator#42 A & <B>' };
    const visible = serializeComposerTag('mar_goal_start', { objective: 'Review' });
    const input = withSessionMessageOrigin(visible + '\n' + oldTag + '\n' + reference, origin);
    expect(input.startsWith(visible)).toBe(true);
    expect(
      parseComposerTags(input)
        .filter((part) => part.kind === 'mar_session_origin')
        .map((part) => part.payload)
    ).toEqual([origin]);
    expect(publicGoalHistoryText(input)).toContain(visible);
    expect(publicGoalHistoryText(input)).toContain(
      serializeComposerTag('mar_session_origin', origin)
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
