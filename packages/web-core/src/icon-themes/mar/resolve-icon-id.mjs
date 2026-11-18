// Shared with the offline preview. Keep the matcher independent of the DOM and asset loading.
export function resolveMarIconId(mapping, path, folder) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const normalized = name.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const lookup = (entries, key) => (Object.hasOwn(entries, key) ? entries[key] : undefined);

  if (folder) {
    return lookup(mapping.folderNames, normalized) ?? mapping.fallback.folder;
  }
  const exact = lookup(mapping.fileNames, normalized);
  if (exact) return exact;

  // Try the longest suffix first, without treating a leading dot as a suffix separator.
  for (let dot = normalized.indexOf('.', 1); dot !== -1; dot = normalized.indexOf('.', dot + 1)) {
    const id = lookup(mapping.fileExtensions, normalized.slice(dot + 1));
    if (id) return id;
  }
  return mapping.fallback.file;
}
