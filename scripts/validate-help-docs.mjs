import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const helpRoot = resolve(root, 'docs/help');

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : extname(entry.name) === '.md' ? [path] : [];
  });
}

const errors = [];
const documents = markdownFiles(helpRoot);
const documentSet = new Set(documents);
const englishRoot = resolve(helpRoot, 'en-US');
const chineseDocuments = documents.filter((file) => !file.startsWith(`${englishRoot}/`));
const englishDocuments = documents.filter((file) => file.startsWith(`${englishRoot}/`));
for (const file of documents) {
  const relative = file.slice(helpRoot.length + 1);
  const source = readFileSync(file, 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source)?.[1];
  if (frontmatter === undefined) {
    errors.push(`${relative}: missing frontmatter`);
    continue;
  }
  if (!/^title:\s*(?:"[^"]+"|'[^']+'|[^\s].*)$/mu.test(frontmatter))
    errors.push(`${relative}: missing title`);
  if (!/^lastUpdated:\s*(?:['"])?\d{4}-\d{2}-\d{2}(?:['"])?\s*$/mu.test(frontmatter))
    errors.push(`${relative}: lastUpdated must use YYYY-MM-DD`);
  if ((source.match(/^#\s+/gmu) ?? []).length !== 1)
    errors.push(`${relative}: exactly one level-one heading is required`);
  if (/\b(?:TODO|TBD)\b/u.test(source))
    errors.push(`${relative}: TODO/TBD placeholders are not allowed`);
  const internalTerms =
    /\b(?:nodeId|workspaceId|SessionLease|ConversationItem|JSONL|FIFO|Turn|Profile)\b/u;
  const internalTerm = internalTerms.exec(source)?.[0];
  if (internalTerm !== undefined)
    errors.push(
      `${relative}: public help must not expose internal implementation terms ${internalTerm}`
    );

  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1]?.trim();
    if (
      rawTarget === undefined ||
      rawTarget.startsWith('#') ||
      /^[a-z][a-z\d+.-]*:/iu.test(rawTarget)
    )
      continue;
    const targetWithoutFragment = rawTarget.split(/[?#]/u)[0];
    if (targetWithoutFragment === '') continue;
    const target = targetWithoutFragment.startsWith('/docs/')
      ? resolve(helpRoot, `${targetWithoutFragment.slice('/docs/'.length)}.md`)
      : resolve(dirname(file), targetWithoutFragment);
    const candidates = extname(target) === '' ? [target, `${target}.md`] : [target];
    if (!candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile()))
      errors.push(`${relative}: missing local link ${rawTarget}`);
  }
}

if (existsSync(resolve(helpRoot, 'index.md')))
  errors.push('index.md: /docs/ must open the first help document, not a separate home page');
for (const chinese of chineseDocuments) {
  const english = resolve(englishRoot, chinese.slice(helpRoot.length + 1));
  if (!documentSet.has(english))
    errors.push(`${chinese.slice(helpRoot.length + 1)}: missing matching English document`);
}
for (const english of englishDocuments) {
  const chinese = resolve(helpRoot, english.slice(englishRoot.length + 1));
  if (!documentSet.has(chinese))
    errors.push(`${english.slice(helpRoot.length + 1)}: missing matching Chinese document`);
}

const docsConfig =
  readFileSync(resolve(root, 'mar-web-console/docs/.vitepress/navigation.zh-CN.ts'), 'utf8') +
  readFileSync(resolve(root, 'mar-web-console/docs/.vitepress/navigation.en-US.ts'), 'utf8');
const sidebarDocuments = new Set(
  [...docsConfig.matchAll(/link:\s*'\/([^']+)'/gu)].map((match) =>
    resolve(helpRoot, `${match[1]}.md`)
  )
);
for (const file of documents) {
  if (!sidebarDocuments.has(file))
    errors.push(`${file.slice(helpRoot.length + 1)}: not registered in the sidebar`);
}
for (const file of sidebarDocuments) {
  if (!documentSet.has(file))
    errors.push(`${file.slice(helpRoot.length + 1)}: missing sidebar target`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Help validation passed (${documents.length} documents)`);
