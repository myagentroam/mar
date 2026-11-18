// The generator calls this function with the embedded mapping and shared matcher.
export function startPreview(mapping, resolveMarIconId) {
  const filename = document.querySelector('#filename');
  const appearance = document.querySelector('#appearance');
  const lookup = document.querySelector('#lookup');
  const resolved = document.querySelector('#resolved');
  const catalog = document.querySelector('#catalog');
  const count = document.querySelector('#count');
  const svgNamespace = 'http://www.w3.org/2000/svg';

  const samples = new Map();
  const searchTerms = new Map();

  function addSample(id, name, folder = false, searchTerm = name) {
    if (!samples.has(id)) samples.set(id, { id, name, folder });
    const terms = searchTerms.get(id) ?? [];
    terms.push(searchTerm.toLowerCase());
    searchTerms.set(id, terms);
  }

  addSample(mapping.fallback.folder, 'workspace/', true);
  addSample(mapping.fallback.file, 'example.unknown');
  for (const [name, id] of Object.entries(mapping.fileNames)) addSample(id, name);
  for (const [suffix, id] of Object.entries(mapping.fileExtensions)) {
    addSample(id, `example.${suffix}`, false, `.${suffix}`);
  }
  for (const [name, id] of Object.entries(mapping.folderNames)) addSample(id, `${name}/`, true);

  function renderSample(element, label, id, scheme) {
    const { accent, symbol = id } = mapping.artwork[id];
    const color = mapping.colors[accent][scheme];
    element.className = 'icon-sample';
    for (const size of [16, 32]) {
      const svg = document.createElementNS(svgNamespace, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      svg.style.color = color;
      svg.style.setProperty('--icon-cut', mapping.cutColors[scheme]);
      const use = document.createElementNS(svgNamespace, 'use');
      use.setAttribute('href', `#mar-file-${symbol}`);
      svg.append(use);
      element.append(svg);
    }
    const name = document.createElement('code');
    name.textContent = label;
    element.append(name);
    return element;
  }

  function render() {
    const query = filename.value.trim();
    const extension = query.startsWith('*.');
    const normalized = (extension ? query.slice(1) : query).toLowerCase();
    const scheme = appearance.value === 'vscode-dark-2026' ? 'dark' : 'light';
    document.documentElement.dataset['theme'] = appearance.value;

    lookup.hidden = query.length === 0;
    resolved.replaceChildren();
    let resolvedId;
    if (query) {
      const folder = query.endsWith('/');
      const name = folder ? query.slice(0, -1) : extension ? `example${query.slice(1)}` : query;
      resolvedId = resolveMarIconId(mapping, name, folder);
      resolved.append(renderSample(document.createElement('div'), query, resolvedId, scheme));
    }

    const results = [];
    for (const sample of samples.values()) {
      if (
        normalized &&
        !(sample.id !== mapping.fallback.file && sample.id === resolvedId) &&
        !sample.id.includes(normalized) &&
        !sample.name.toLowerCase().includes(normalized) &&
        !searchTerms.get(sample.id)?.some((term) => term.includes(normalized))
      )
        continue;
      results.push(renderSample(document.createElement('li'), sample.name, sample.id, scheme));
    }
    catalog.replaceChildren(...results);
    count.textContent = `${results.length} ${results.length === 1 ? 'icon' : 'icons'}`;
  }

  filename.addEventListener('input', render);
  appearance.addEventListener('change', render);
  render();
}
