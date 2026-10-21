import articleIcon from './article.svg?raw';
import codeIcon from './code.svg?raw';
import fileIcon from './file.svg?raw';
import folderIcon from './folder.svg?raw';
import imageIcon from './image.svg?raw';
import lockIcon from './lock.svg?raw';
import paletteIcon from './palette.svg?raw';
import storageIcon from './storage.svg?raw';
import terminalIcon from './terminal.svg?raw';
import agentIcon from './upstream/agent.svg?raw';
import claudeIcon from './upstream/claude.svg?raw';
import folderConfigIcon from './upstream/folder-config.svg?raw';
import folderDistIcon from './upstream/folder-dist.svg?raw';
import folderDocsIcon from './upstream/folder-docs.svg?raw';
import folderLibIcon from './upstream/folder-lib.svg?raw';
import folderSourceIcon from './upstream/folder-src.svg?raw';
import folderTestIcon from './upstream/folder-test.svg?raw';
import folderVscodeIcon from './upstream/folder-vscode.svg?raw';
import gitIcon from './upstream/git.svg?raw';
import goIcon from './upstream/go.svg?raw';
import javaIcon from './upstream/java.svg?raw';
import jsonIcon from './upstream/json.svg?raw';
import markdownIcon from './upstream/markdown.svg?raw';
import pythonIcon from './upstream/python.svg?raw';
import readmeIcon from './upstream/readme.svg?raw';
import typescriptIcon from './upstream/typescript.svg?raw';
import vueIcon from './upstream/vue.svg?raw';
import yamlIcon from './upstream/yaml.svg?raw';
import type { FileIcon, FileIconTheme } from '../types.js';

const FILE_COLORS = {
  light: '#546e7a',
  dark: '#b0bec5',
  code: '#42a5f5',
  document: '#5c6bc0',
  image: '#ec407a',
  data: '#26a69a',
  style: '#ab47bc',
  terminal: '#66bb6a',
  lock: '#78909c'
} as const;

function icon(markup: string, color: string, monochrome = false): FileIcon {
  return {
    kind: 'svg',
    markup: monochrome
      ? markup.replace(/<path(?![^>]*\sfill=)/gu, '<path fill="currentColor"')
      : markup,
    color
  };
}

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLocaleLowerCase() : '';
}

function resolveMaterialFileIcon(name: string, light: boolean): FileIcon {
  const normalized = name.toLocaleLowerCase();
  if (normalized === 'agents.md') return icon(agentIcon, FILE_COLORS.document);
  if (normalized === 'claude.md' || normalized === 'claude.local.md')
    return icon(claudeIcon, FILE_COLORS.document);
  if (
    [
      '.gitignore',
      '.gitmodules',
      '.gitattributes',
      '.gitconfig',
      '.gitkeep',
      'commit_editmsg',
      'merge_msg'
    ].includes(normalized)
  )
    return icon(gitIcon, FILE_COLORS.document);
  if (['readme', 'readme.md', 'readme.rst', 'readme.txt'].includes(normalized))
    return icon(readmeIcon, FILE_COLORS.document);
  if (normalized === 'dockerfile') return icon(storageIcon, FILE_COLORS.data, true);
  if (normalized === 'makefile') return icon(storageIcon, FILE_COLORS.data, true);
  if (normalized === 'package-lock.json' || normalized.endsWith('.lock')) {
    return icon(lockIcon, FILE_COLORS.lock, true);
  }
  if (['compose.yaml', 'compose.yml'].includes(normalized)) {
    return icon(storageIcon, FILE_COLORS.data, true);
  }
  const fileExtension = extension(normalized);
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'vue',
      'java',
      'go',
      'py',
      'rb',
      'rs',
      'c',
      'h',
      'cpp',
      'cs'
    ].includes(fileExtension)
  ) {
    if (['ts', 'tsx'].includes(fileExtension)) return icon(typescriptIcon, FILE_COLORS.code);
    if (fileExtension === 'vue') return icon(vueIcon, FILE_COLORS.code);
    if (fileExtension === 'py') return icon(pythonIcon, FILE_COLORS.code);
    if (fileExtension === 'java') return icon(javaIcon, FILE_COLORS.code);
    if (fileExtension === 'go') return icon(goIcon, FILE_COLORS.code);
    return icon(codeIcon, FILE_COLORS.code, true);
  }
  if (['md', 'mdx', 'txt', 'pdf', 'doc', 'docx'].includes(fileExtension)) {
    return fileExtension === 'md' || fileExtension === 'mdx'
      ? icon(markdownIcon, FILE_COLORS.document)
      : icon(articleIcon, FILE_COLORS.document, true);
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(fileExtension)) {
    return icon(imageIcon, FILE_COLORS.image, true);
  }
  if (['json', 'jsonc', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'sql'].includes(fileExtension)) {
    if (['json', 'jsonc', 'jsonl'].includes(fileExtension)) return icon(jsonIcon, FILE_COLORS.data);
    if (['yaml', 'yml'].includes(fileExtension)) return icon(yamlIcon, FILE_COLORS.data);
    return icon(storageIcon, FILE_COLORS.data, true);
  }
  if (['css', 'scss', 'sass', 'less'].includes(fileExtension)) {
    return icon(paletteIcon, FILE_COLORS.style, true);
  }
  if (['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'].includes(fileExtension)) {
    return icon(terminalIcon, FILE_COLORS.terminal, true);
  }
  return icon(fileIcon, light ? FILE_COLORS.light : FILE_COLORS.dark, true);
}

export const materialIconTheme: FileIconTheme = {
  id: 'material',
  labelKey: 'settings.iconThemeMaterial',
  resolveFile: resolveMaterialFileIcon,
  resolveFolder: (light, name = '') => {
    const normalized = name.toLocaleLowerCase();
    if (['.vscode', 'vscode', 'vscode-test'].includes(normalized))
      return icon(folderVscodeIcon, light ? '#1976d2' : '#90caf9');
    if (['src', 'srcs', 'source', 'sources', 'code'].includes(normalized))
      return icon(folderSourceIcon, light ? '#1976d2' : '#90caf9');
    if (['docs', 'doc', 'documentation', 'documents'].includes(normalized))
      return icon(folderDocsIcon, light ? '#1976d2' : '#90caf9');
    if (['build', 'dist', 'release', 'out', 'output', 'bin'].includes(normalized))
      return icon(folderDistIcon, light ? '#1976d2' : '#90caf9');
    if (['test', 'tests', 'testing', 'spec', 'specs'].includes(normalized))
      return icon(folderTestIcon, light ? '#1976d2' : '#90caf9');
    if (['config', 'configs', 'configuration', 'settings'].includes(normalized))
      return icon(folderConfigIcon, light ? '#1976d2' : '#90caf9');
    if (['lib', 'libs', 'library', 'libraries', 'vendor'].includes(normalized))
      return icon(folderLibIcon, light ? '#1976d2' : '#90caf9');
    return icon(folderIcon, light ? '#1976d2' : '#90caf9', true);
  }
};
