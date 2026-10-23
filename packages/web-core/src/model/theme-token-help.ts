import type { CUSTOM_THEME_TOKENS } from './custom-theme.js';

export const THEME_TOKEN_GROUPS = [
  'surfaces',
  'borders',
  'text',
  'conversation',
  'interaction',
  'controls',
  'status',
  'overlays'
] as const;
export const THEME_TOKEN_HELP = {
  '--mar-table-header-bg': { group: 'surfaces', description: 'table-header-bg' },
  '--mar-table-row-hover-bg': { group: 'surfaces', description: 'table-row-hover-bg' },
  '--mar-color-brand-disabled': { group: 'interaction', description: 'color-brand-disabled' },
  '--mar-control-link-text': { group: 'controls', description: 'control-link-text' },
  '--mar-control-link-hover': { group: 'controls', description: 'control-link-hover' },

  '--mar-bg-page': { group: 'surfaces', description: 'bg-page' },
  '--mar-bg-panel': { group: 'surfaces', description: 'bg-panel' },
  '--mar-bg-chrome': { group: 'surfaces', description: 'bg-chrome' },
  '--mar-bg-subtle': { group: 'surfaces', description: 'bg-subtle' },
  '--mar-bg-tab-inactive': { group: 'surfaces', description: 'bg-tab-inactive' },
  '--mar-fill-subtle': { group: 'surfaces', description: 'fill-subtle' },
  '--mar-fill-muted': { group: 'surfaces', description: 'fill-muted' },
  '--mar-fill-row-hover': { group: 'surfaces', description: 'fill-row-hover' },
  '--mar-fill-soft': { group: 'surfaces', description: 'fill-soft' },
  '--mar-fill-hover': { group: 'surfaces', description: 'fill-hover' },
  '--mar-border-default': { group: 'borders', description: 'border-default' },
  '--mar-border-subtle': { group: 'borders', description: 'border-subtle' },
  '--mar-border-medium': { group: 'borders', description: 'border-medium' },
  '--mar-border-strong': { group: 'borders', description: 'border-strong' },
  '--mar-text-primary': { group: 'text', description: 'text-primary' },
  '--mar-text-secondary': { group: 'text', description: 'text-secondary' },
  '--mar-text-tertiary': { group: 'text', description: 'text-tertiary' },
  '--mar-text-faint': { group: 'text', description: 'text-faint' },
  '--mar-text-muted': { group: 'text', description: 'text-muted' },
  '--mar-text-neutral-control': { group: 'text', description: 'text-neutral-control' },
  '--mar-conversation-canvas': { group: 'conversation', description: 'conversation-canvas' },
  '--mar-conversation-surface': { group: 'conversation', description: 'conversation-surface' },
  '--mar-conversation-process': { group: 'conversation', description: 'conversation-process' },
  '--mar-conversation-border': { group: 'conversation', description: 'conversation-border' },
  '--mar-conversation-process-border': {
    group: 'conversation',
    description: 'conversation-process-border'
  },
  '--mar-conversation-text': { group: 'conversation', description: 'conversation-text' },
  '--mar-conversation-muted': { group: 'conversation', description: 'conversation-muted' },
  '--mar-conversation-code': { group: 'conversation', description: 'conversation-code' },
  '--mar-scrollbar-thumb': { group: 'borders', description: 'scrollbar-thumb' },
  '--mar-scrollbar-thumb-hover': { group: 'borders', description: 'scrollbar-thumb-hover' },
  '--mar-color-brand': { group: 'interaction', description: 'color-brand' },
  '--mar-control-color-primary-light-3': {
    group: 'controls',
    description: 'control-color-primary-light-3'
  },
  '--mar-control-color-primary-light-5': {
    group: 'controls',
    description: 'control-color-primary-light-5'
  },
  '--mar-control-color-primary-light-7': {
    group: 'controls',
    description: 'control-color-primary-light-7'
  },
  '--mar-control-color-primary-light-8': {
    group: 'controls',
    description: 'control-color-primary-light-8'
  },
  '--mar-control-color-primary-light-9': {
    group: 'controls',
    description: 'control-color-primary-light-9'
  },
  '--mar-control-color-primary-dark-2': {
    group: 'controls',
    description: 'control-color-primary-dark-2'
  },
  '--mar-control-color-success': { group: 'controls', description: 'control-color-success' },
  '--mar-control-color-warning': { group: 'controls', description: 'control-color-warning' },
  '--mar-control-color-danger': { group: 'controls', description: 'control-color-danger' },
  '--mar-control-bg-color-overlay': { group: 'controls', description: 'control-bg-color-overlay' },
  '--mar-control-fill-color': { group: 'controls', description: 'control-fill-color' },
  '--mar-control-fill-color-light': { group: 'controls', description: 'control-fill-color-light' },
  '--mar-control-fill-color-lighter': {
    group: 'controls',
    description: 'control-fill-color-lighter'
  },
  '--mar-control-fill-color-extra-light': {
    group: 'controls',
    description: 'control-fill-color-extra-light'
  },
  '--mar-control-border-color-lighter': {
    group: 'controls',
    description: 'control-border-color-lighter'
  },
  '--mar-control-border-color-extra-light': {
    group: 'controls',
    description: 'control-border-color-extra-light'
  },
  '--mar-control-border-color-dark': {
    group: 'controls',
    description: 'control-border-color-dark'
  },
  '--mar-control-border-color-darker': {
    group: 'controls',
    description: 'control-border-color-darker'
  },
  '--mar-color-brand-text': { group: 'interaction', description: 'color-brand-text' },
  '--mar-color-on-accent': { group: 'interaction', description: 'color-on-accent' },
  '--mar-color-brand-hover': { group: 'interaction', description: 'color-brand-hover' },
  '--mar-color-brand-subtle': { group: 'interaction', description: 'color-brand-subtle' },
  '--mar-color-brand-selected': { group: 'interaction', description: 'color-brand-selected' },
  '--mar-color-brand-border': { group: 'interaction', description: 'color-brand-border' },
  '--mar-color-success-text': { group: 'status', description: 'color-success-text' },
  '--mar-color-success-bg': { group: 'status', description: 'color-success-bg' },
  '--mar-color-warning-text': { group: 'status', description: 'color-warning-text' },
  '--mar-color-warning-accent': { group: 'status', description: 'color-warning-accent' },
  '--mar-color-warning-bg': { group: 'status', description: 'color-warning-bg' },
  '--mar-color-danger-text': { group: 'status', description: 'color-danger-text' },
  '--mar-color-danger-bg': { group: 'status', description: 'color-danger-bg' },
  '--mar-color-accent': { group: 'interaction', description: 'color-accent' },
  '--mar-color-accent-bg': { group: 'interaction', description: 'color-accent-bg' },
  '--mar-color-diff-add-text': { group: 'status', description: 'color-diff-add-text' },
  '--mar-color-diff-del-text': { group: 'status', description: 'color-diff-del-text' },
  '--mar-shadow-soft': { group: 'overlays', description: 'shadow-soft' },
  '--mar-shadow-medium': { group: 'overlays', description: 'shadow-medium' },
  '--mar-overlay-scrim': { group: 'overlays', description: 'overlay-scrim' },
  '--mar-overlay-border': { group: 'overlays', description: 'overlay-border' }
} as const satisfies Record<
  (typeof CUSTOM_THEME_TOKENS)[number],
  { group: (typeof THEME_TOKEN_GROUPS)[number]; description: string }
>;
