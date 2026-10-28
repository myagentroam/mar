import { existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { createMarkdownRenderer } from 'vitepress';

// Use the same Markdown renderer as the documentation site, rather than guessing
// heading slugs or interpreting links inside fenced examples as documentation links.
export async function inspectHelpMarkdown(helpRoot, sources) {
  const renderer = await createMarkdownRenderer(helpRoot);
  const parsed = new Map();
  for (const [file, source] of sources) {
    const ids = new Set();
    const links = [];
    const images = [];
    const tokens = renderer
      .parse(source, {})
      .flatMap((token) => [token, ...(token.children ?? [])]);
    for (const token of tokens) {
      if (token.type === 'heading_open') {
        const id = token.attrGet('id');
        if (id !== null) ids.add(id);
      } else if (token.type === 'html_inline' || token.type === 'html_block') {
        // Public help retains old URLs with plain <a id="..."></a> aliases.
        // Match only an actual alias token, never HTML examples or comments.
        const alias = /^<a\s+id=(["'])(.*?)\1\s*>(?:<\/a>)?$/u.exec(token.content.trim());
        if (alias !== null) ids.add(alias[2]);
      } else if (token.type === 'link_open') {
        const href = token.attrGet('href');
        if (href !== null) links.push(href);
      } else if (token.type === 'image') {
        const src = token.attrGet('src');
        if (src !== null) images.push(src);
      }
    }
    parsed.set(file, { ids, links, images });
  }

  const errors = [];
  for (const [file, page] of parsed) {
    for (const href of page.links) {
      if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('//')) continue;
      const hash = href.indexOf('#');
      if (hash < 0 || hash === href.length - 1) continue;
      let fragment;
      try {
        fragment = decodeURIComponent(href.slice(hash + 1));
      } catch {
        errors.push(`${file.slice(helpRoot.length + 1)}: invalid anchor ${href}`);
        continue;
      }
      const path = decodeURIComponent(href.slice(0, hash).split('?')[0]);
      let target = file;
      if (path) {
        target = path.startsWith('/docs/')
          ? resolve(helpRoot, path.slice('/docs/'.length))
          : resolve(dirname(file), path);
        if (extname(target) === '') target += '.md';
      }
      const targetPage = parsed.get(target);
      // Non-Markdown assets and missing files are handled by the existing link check.
      if (targetPage !== undefined && !targetPage.ids.has(fragment))
        errors.push(`${file.slice(helpRoot.length + 1)}: missing anchor ${href}`);
    }
  }
  return { pages: parsed, errors };
}

export async function validateHelpAnchors(helpRoot, sources) {
  return (await inspectHelpMarkdown(helpRoot, sources)).errors;
}

export function missingHelpTargets(helpRoot, file, page) {
  const errors = [];
  for (const reference of [...page.links, ...page.images]) {
    const rawTarget = reference.trim();
    if (
      rawTarget.startsWith('#') ||
      rawTarget.startsWith('//') ||
      /^[a-z][a-z\d+.-]*:/iu.test(rawTarget)
    )
      continue;
    const targetWithoutFragment = decodeURIComponent(rawTarget.split(/[?#]/u)[0]);
    if (targetWithoutFragment === '') continue;
    const target = targetWithoutFragment.startsWith('/docs/')
      ? resolve(helpRoot, targetWithoutFragment.slice('/docs/'.length))
      : resolve(dirname(file), targetWithoutFragment);
    const candidates = extname(target) === '' ? [target, `${target}.md`] : [target];
    if (!candidates.some((candidate) => existsSync(candidate) && statSync(candidate).isFile()))
      errors.push(`${file.slice(helpRoot.length + 1)}: missing local link ${rawTarget}`);
  }
  return errors;
}
