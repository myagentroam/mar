import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

// Refresh the checked-in offline preview after changing MAR artwork, mappings or preview sources.
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').trim();
const output = new URL('preview.html', import.meta.url);
const mapping = JSON.stringify(JSON.parse(read('mapping.json'))).replaceAll('<', '\\u003c');
const matcher = read('resolve-icon-id.mjs').replace(
  'export function resolveMarIconId',
  'function resolveMarIconId'
);
const preview = read('preview.js').replace('export function startPreview', 'function startPreview');
const artwork = read('illustrations.svg').replace(
  '<svg ',
  '<svg aria-hidden="true" width="0" height="0" style="position: absolute;" '
);
const page = read('preview.template.html')
  .replace(
    '<!-- inline-styles -->',
    () => `<style>\n${read('../../styles/theme.css')}\n${read('preview.css')}\n</style>`
  )
  .replace('<!-- inline-artwork -->', () => artwork)
  .replace(
    '<!-- inline-script -->',
    () => `<script>\n${matcher}\n${preview}\nstartPreview(${mapping}, resolveMarIconId);\n</script>`
  );
const filepath = fileURLToPath(output);
const markup = await prettier.format(page, {
  ...(await prettier.resolveConfig(filepath)),
  filepath
});

if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== markup) {
    console.error('The offline MAR icon preview is out of date. Run generate-preview.mjs.');
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, markup);
}
