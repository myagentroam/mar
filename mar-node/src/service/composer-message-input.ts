import {
  parseComposerTags,
  serializeComposerTag,
  sessionMessageOriginSchema
} from '@myagentroam/protocol';
import { relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SkillDirectoryService } from './skill-directory-service.js';

/** Keep the admitted source snapshot beside message and Goal markup. */
export function withSessionMessageOrigin(
  input: string,
  origin: unknown,
  parentSessionId?: string | null
): string {
  if (origin === undefined) return input;
  const parsed = sessionMessageOriginSchema.parse(origin);
  const snapshot =
    parsed.sessionId === undefined
      ? parsed
      : {
          ...parsed,
          relation: parsed.sessionId === parentSessionId ? ('parent' as const) : ('other' as const)
        };
  const tag = serializeComposerTag('mar_session_origin', snapshot);
  const parts = parseComposerTags(input);
  const first = parts[0];
  const goal =
    first?.kind === 'mar_goal_start' || first?.kind === 'mar_goal_continue' ? first : undefined;
  const content = parts
    .map((part) =>
      part === goal || part.kind === 'mar_session_origin'
        ? ''
        : part.kind === 'text'
          ? part.text
          : part.raw
    )
    .join('');
  return [goal?.raw, tag, goal === undefined ? content : content.trimStart()]
    .filter(Boolean)
    .join('\n');
}

export function composerResourceInputTags(input: string): string {
  return parseComposerTags(input)
    .filter(
      (part) =>
        part.kind === 'mar_skills' ||
        part.kind === 'mar_references' ||
        part.kind === 'mar_attachments'
    )
    .map((part) => part.raw)
    .join('\n');
}

/** Product references keep their Workspace identity while tools use the Session's cwd. */
export function prepareComposerResourceInput(
  input: string,
  cwd: string,
  workspacePath: string
): string {
  return parseComposerTags(input)
    .map((part) => {
      if (part.kind === 'text') return part.text;
      if (part.kind !== 'mar_references') return part.raw;
      return serializeComposerTag('mar_references', {
        references: part.payload.references.map((reference) => ({
          ...reference,
          runnerPath: relative(cwd, resolve(workspacePath, reference.path)).replaceAll('\\', '/')
        }))
      });
    })
    .join('');
}

/** Recheck selection identity, without loading Skill content into the message or granting access. */
export async function validateComposerSkills(
  input: string,
  workspacePath: string,
  home = homedir()
): Promise<void> {
  const selected = parseComposerTags(input).flatMap((part) =>
    part.kind === 'mar_skills' ? part.payload.skills : []
  );
  if (selected.length === 0) return;
  const directories = new SkillDirectoryService();
  const [node, workspace] = await Promise.all([
    directories.inspectNodeHome(home),
    directories.inspectWorkspace(workspacePath)
  ]);
  const effective = new Map(
    node.skills.map((skill) => [skill.name, { ...skill, source: 'NODE_HOME' }])
  );
  for (const skill of workspace.skills)
    effective.set(skill.name, { ...skill, source: 'WORKSPACE' });
  for (const skill of selected) {
    const current = effective.get(skill.name);
    if (
      current === undefined ||
      current.source !== skill.source ||
      resolve(workspacePath, skill.path) !== resolve(current.skillFilePath)
    )
      throw new Error('MESSAGE_INVALID');
  }
}
