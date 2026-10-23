// Reviewed static SVG geometry. Shared by Vue and trusted Markdown controls.
export const iconShapes = {
  subtract: '<path d="M5 12h14" />',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4m8-4v4" />',
  'chevrons-left': '<path d="m11 6-6 6 6 6m8-12-6 6 6 6" />',
  'chevrons-right': '<path d="m5 6 6 6-6 6m8-12 6 6-6 6" />',
  workspace: '<rect x="3" y="4.5" width="18" height="15" rx="2.8"/><path d="M3 9h18M8.5 9v10.5" />',
  node: '<rect x="6" y="3.5" width="12" height="17" rx="2.8"/><path d="M9 8h6" /><rect x="10" y="15.5" width="4" height="2" rx="1"/>',
  conversation:
    '<path d="M9 4h6a6 6 0 0 1 6 6v3a6 6 0 0 1-6 6H9l-5 2v-5.5A6 6 0 0 1 3 12v-2a6 6 0 0 1 6-6Z" /><circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="12" cy="11.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="16" cy="11.5" r="0.9" fill="currentColor" stroke="none"/>',
  administration:
    '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.8"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.8"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.8"/><rect x="14" y="14" width="6.5" height="6.5" rx="1.8"/>',
  settings:
    '<path d="M9.7 3.5h4.6l.7 2.7 2 .9 2.5-.8 2.2 3.8-1.9 1.8v2.2l1.9 1.8-2.2 3.8-2.5-.8-2 .9-.7 2.7H9.7L9 19.8l-2-.9-2.5.8-2.2-3.8L4.2 14v-2.2l-1.9-1.8 2.2-3.8 2.5.8 2-.9.7-2.6Z" transform="translate(1.2 .4) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  'recent-sessions':
    '<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M6 4h12M4 6h16m-11 6h6m-6 4h4" />',
  notification:
    '<path d="M6.5 10a5.5 5.5 0 0 1 11 0v3.5l2 3a.7.7 0 0 1-.6 1H5.1a.7.7 0 0 1-.6-1l2-3V10Zm3 11h5" />',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16" />',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.3 9a2.7 2.7 0 0 1 5.4 0c0 1.4-1.2 1.9-2 2.5-.5.4-.7.8-.7 1.5" /><circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/><path d="M12 11v5.5" />',
  power: '<path d="M12 3v8M7 5.5a8 8 0 1 0 10 0" />',
  folder:
    '<path d="M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" />',
  'folder-open':
    '<path d="M3 17V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v1M5 20h13a2 2 0 0 0 2-1.6l1.5-6.3a1.3 1.3 0 0 0-1.3-1.6H7a2 2 0 0 0-2 1.6L3.3 18A1.6 1.6 0 0 0 5 20Z" />',
  'folder-add':
    '<path d="M3 8V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" /><path d="M12 10.5v6m-3-3h6" />',
  document:
    '<path d="M13.5 3.5H6A2 2 0 0 0 4 5.5v13A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2v-8.5l-6.5-6.5Zm0 0V8a2 2 0 0 0 2 2H20" /><path d="M8 14h8m-8 3h5" />',
  'document-add':
    '<path d="M13.5 3.5H6A2 2 0 0 0 4 5.5v13A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2v-8.5l-6.5-6.5Zm0 0V8a2 2 0 0 0 2 2H20" /><path d="M12 12v6m-3-3h6" />',
  'document-save':
    '<path d="M13.5 3.5H6A2 2 0 0 0 4 5.5v13A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2v-8.5l-6.5-6.5Zm0 0V8a2 2 0 0 0 2 2H20" /><path d="m8.5 15 2.5 2.5 5-5" />',
  collection:
    '<rect x="6" y="6.5" width="14" height="14" rx="2.2"/><path d="M16 3.5H5a2 2 0 0 0-2 2v11m7-6h6m-6 4h4" />',
  image:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2.8"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4" />',
  key: '<circle cx="8" cy="8" r="4.5"/><path d="m11.3 11.3 9.2 9.2m-5.8-5.8 2.5-2.5m.3 5.3 2.5-2.5" />',
  connection: '<path d="M8 3.5v4m8-4v4M6 7.5h12v4a6 6 0 0 1-12 0v-4Zm6 10v3" />',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 5.3 5.3" />',
  plus: '<path d="M12 4.5v15M4.5 12h15" />',
  close: '<path d="m6 6 12 12M18 6 6 18" />',
  check: '<path d="m4.5 12 5 5 10-10" />',
  more: '<circle cx="5" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.25" fill="currentColor" stroke="none"/>',
  edit: '<path d="m14.5 4.5 5 5M4 20l1-5 11-11a2 2 0 0 1 3 0l1 1a2 2 0 0 1 0 3L9 19l-5 1Z" />',
  delete:
    '<path d="M4 6.5h16m-11 0v-2h6v2M6 7l1 12a2 2 0 0 0 2 1.5h6a2 2 0 0 0 2-1.5l1-12M10 10.5v6m4-6v6" />',
  copy: '<rect x="8" y="8" width="12.5" height="12.5" rx="2.5"/><path d="M16 8V5.5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2H8" />',
  paste:
    '<path d="M8 5H6a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /><rect x="8" y="3" width="8" height="4" rx="1.3"/><path d="M8 12h8m-8 4h5" />',
  clear:
    '<path d="m13 4 7 7M5 17l8-13a1.8 1.8 0 0 1 2.5-.4l5 5a1.8 1.8 0 0 1-.4 2.5L12 20H8l-3-3Zm3-5 8 5M5 20h15" />',
  'chevron-left': '<path d="m14.5 6-6 6 6 6" />',
  'chevron-right': '<path d="m9.5 6 6 6-6 6" />',
  'chevron-up': '<path d="m6 14.5 6-6 6 6" />',
  'chevron-down': '<path d="m6 9.5 6 6 6-6" />',
  'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6" />',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6" />',
  back: '<path d="M20 12H4m6-6-6 6 6 6" />',
  'to-bottom': '<path d="M12 3.5v12m-5-5 5 5 5-5M5 20h14" />',
  'external-link':
    '<path d="M13 4h7v7m0-7L10 14M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />',
  fullscreen: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />',
  restore: '<path d="M4 9h5V4m6 0v5h5M9 20v-5H4m11 5v-5h5" />',
  'session-add':
    '<path d="M11.5 4H8a5 5 0 0 0-5 5v4a6 6 0 0 0 1 3.3V21l5-2h6a6 6 0 0 0 6-6v-1.5M18.5 2.5v6m-3-3h6" />',
  star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9L12 3Z" />',
  'star-filled':
    '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9L12 3Z" fill="currentColor" stroke-width="1.2"/>',
  pin: '<path d="M8 4h8m-7 0v6l-3 4v2h12v-2l-3-4V4M12 16v5" />',
  'pin-off': '<path d="M10 4h6m-1 0v6l3 4v2h-2M8.5 9l-2.5 5v2h6m0 0v5M3.5 3.5l17 17" />',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2" />',
  share:
    '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.7 7.6-4.4m-7.6 7 7.6 4.4" />',
  link: '<path d="m10 7 2.5-2.5a5 5 0 0 1 7 7L17 14m-3 3-2.5 2.5a5 5 0 0 1-7-7L7 10m1.5 5.5 7-7" />',
  upload: '<path d="M12 16V3.5m-5 5 5-5 5 5M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15" />',
  download: '<path d="M12 3.5V16m-5-5 5 5 5-5M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15" />',
  attachment:
    '<path d="m8.5 12.5 6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7L12.5 4m-4 8.5a1.5 1.5 0 0 0 2.1 2.1l6-6" />',
  send: '<path d="M4.2 3.8 21 11.2a.9.9 0 0 1 0 1.6L4.2 20.2a.7.7 0 0 1-1-.8L6 12 3.2 4.6a.7.7 0 0 1 1-.8ZM6 12h8" />',
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5" fill="currentColor" stroke="none"/>',
  queue:
    '<path d="M8 5h12M8 12h12M8 19h8" /><circle cx="3.5" cy="5" r="0.9" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="0.9" fill="currentColor" stroke="none"/><circle cx="3.5" cy="19" r="0.9" fill="currentColor" stroke="none"/>',
  quote: '<path d="M4 6h6v6a6 6 0 0 1-6 6m0-12v6h6m4-6h6v6a6 6 0 0 1-6 6m0-12v6h6" />',
  adjustments:
    '<path d="M4 7h3m5 0h8M4 17h8m5 0h3" /><circle cx="9.5" cy="7" r="2.5"/><circle cx="14.5" cy="17" r="2.5"/>',
  reasoning:
    '<path d="M12 6a3 3 0 0 0-5.7-1.3A4.2 4.2 0 0 0 4 12a4.3 4.3 0 0 0 2.5 7.7A3 3 0 0 0 12 18V6Zm0 0a3 3 0 0 1 5.7-1.3A4.2 4.2 0 0 1 20 12a4.3 4.3 0 0 1-2.5 7.7A3 3 0 0 1 12 18M7 9c2 0 3 1 3 3m7-3c-2 0-3 1-3 3M8 17h1m7 0h-1" transform="translate(1.2 1.2) scale(.9)"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.8"/><path d="m7 9 3 3-3 3m6 0h4" />',
  'file-change':
    '<path d="M10 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h7.5L20 10v1m-6.5-7.5V8a2 2 0 0 0 2 2H20m-7 7 5.5-5.5 3 3L16 20l-4 1 1-4Zm3.5-3.5 3 3" />',
  skill:
    '<path d="M12 5.5C9 3.5 6 3.5 3.5 4.5v15c3-1 5.5-1 8.5 1 3-2 5.5-2 8.5-1v-15c-2.5-1-5.5-1-8.5 1Zm0 0v15" />',
  web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c-5 4-5 13 0 17 5-4 5-13 0-17Z" />',
  tool: '<path d="M14 4a5.5 5.5 0 0 0-5.5 7.5l-5 5a2.5 2.5 0 0 0 3.5 3.5l5-5A5.5 5.5 0 0 0 20 9.5L16.5 12 12 7.5 14 4Z" />',
  refresh: '<path d="M20 9a8 8 0 0 0-13.5-3L4 8m0-4v4h4m-4 7a8 8 0 0 0 13.5 3L20 16m0 4v-4h-4" />',
  retry: '<path d="M4 9a8 8 0 1 1 .5 7M4 4v5h5" />',
  undo: '<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14" transform="translate(1 -1) scale(.92)"/>',
  success: '<circle cx="12" cy="12" r="8.5"/><path d="m7.5 12 3 3 6-6" />',
  error: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6m0-6-6 6" />',
  warning:
    '<path d="M10.3 4.4a2 2 0 0 1 3.4 0l7 12.2a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3l7-12.2Z" /><path d="M12 9v4" /><circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none"/>',
  'loading-action':
    '<path d="M12 3.5v3" transform="rotate(0 12 12)" opacity="0.250"/><path d="M12 3.5v3" transform="rotate(45 12 12)" opacity="0.344"/><path d="M12 3.5v3" transform="rotate(90 12 12)" opacity="0.438"/><path d="M12 3.5v3" transform="rotate(135 12 12)" opacity="0.531"/><path d="M12 3.5v3" transform="rotate(180 12 12)" opacity="0.625"/><path d="M12 3.5v3" transform="rotate(225 12 12)" opacity="0.719"/><path d="M12 3.5v3" transform="rotate(270 12 12)" opacity="0.812"/><path d="M12 3.5v3" transform="rotate(315 12 12)" opacity="0.906"/>',
  'loading-content': '<path d="M20.5 12a8.5 8.5 0 1 1-8.5-8.5" />',
  lock: '<rect x="4.5" y="10" width="15" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2" />',
  unlock:
    '<rect x="4.5" y="10" width="15" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7.5-2M12 14.5v2" />',
  view: '<path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" /><circle cx="12" cy="12" r="2.8"/>',
  'view-off':
    '<path d="M9.5 5.4A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a18.5 18.5 0 0 1-3 3.8M14.5 18.6A9.6 9.6 0 0 1 12 19c-6 0-9.5-7-9.5-7a18.5 18.5 0 0 1 3-3.8M10 10a2.8 2.8 0 0 0 4 4M3 3l18 18" />',
  'zoom-in':
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 5.3 5.3M10.5 7.5v6m-3-3h6" />',
  'zoom-out': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.2 15.2 5.3 5.3M7.5 10.5h6" />',
  'rotate-left': '<path d="M5.5 6.5A8 8 0 1 1 4 12M5.5 3v3.5H9" />',
  'rotate-right':
    '<path d="M5.5 6.5A8 8 0 1 1 4 12M5.5 3v3.5H9" transform="translate(24 0) scale(-1 1)"/>',
  fit: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M8 3.5H3.5V8M16 3.5h4.5V8M3.5 16v4.5H8M20.5 16v4.5H16" />',
  split:
    '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M12 4.5v15M6.5 9h2m-2 4h2m7-2h2m-2 4h2" />',
  'clear-input': '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6m0-6-6 6" />',
  empty:
    '<path d="m3.5 10 3-5h11l3 5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V10Zm0 0H8l1.5 4h5L16 10h4.5" />',
  'source-code': '<path d="m8 6-5 6 5 6m8-12 5 6-5 6M14 4l-4 16" />',
  symbols:
    '<path d="M9 5h11M9 12h11M9 19h7" /><rect x="3" y="3.5" width="2.5" height="3" rx="0.7"/><rect x="3" y="10.5" width="2.5" height="3" rx="0.7"/><rect x="3" y="17.5" width="2.5" height="3" rx="0.7"/>',
  user: '<circle cx="12" cy="7.5" r="3.5"/><path d="M4.5 20v-1.5a5 5 0 0 1 5-5h5a5 5 0 0 1 5 5V20" />',
  users:
    '<circle cx="9" cy="7.5" r="3.5"/><path d="M3.5 20v-2a4.5 4.5 0 0 1 4.5-4.5h3a4.5 4.5 0 0 1 4.5 4.5v2M16 4.5a3.5 3.5 0 0 1 0 7m2 3a3.5 3.5 0 0 1 2.5 3.5V20" />',
  organization:
    '<rect x="8" y="3" width="8" height="5" rx="1.6"/><path d="M12 8v5M6 16v-3h12v3" /><rect x="3" y="16" width="6" height="5" rx="1.5"/><rect x="15" y="16" width="6" height="5" rx="1.5"/>',
  shield:
    '<path d="M12 3.5 20 7v5.5c0 4-3.5 6.7-8 8.5-4.5-1.8-8-4.5-8-8.5V7l8-3.5Z" /><path d="M12 8v7" />',
  grant:
    '<path d="M12 3.5 20 7v5.5c0 4-3.5 6.7-8 8.5-4.5-1.8-8-4.5-8-8.5V7l8-3.5Z" /><path d="m8.5 12 2.5 2.5 4.5-4.5" />',
  oauth: '<path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5M4 12h11m-4-4 4 4-4 4" />',
  license:
    '<path d="M10 20H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v5M8 7h7m-7 4h3" /><circle cx="16" cy="14.5" r="3.5"/><path d="m13.5 17-1 4 3.5-1.5 3.5 1.5-1-4" />',
  audit:
    '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M9 8h7m-7 4h7m-7 4h4" /><circle cx="7" cy="8" r="0.55" fill="currentColor" stroke="none"/><circle cx="7" cy="12" r="0.55" fill="currentColor" stroke="none"/><circle cx="7" cy="16" r="0.55" fill="currentColor" stroke="none"/>',
  model:
    '<rect x="6" y="6" width="12" height="12" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />',
  secret:
    '<rect x="3.5" y="9" width="17" height="11.5" rx="2.5"/><path d="M8 9V7a4 4 0 0 1 8 0v2" /><circle cx="8" cy="15.5" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="15.5" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="15.5" r="1" fill="currentColor" stroke="none"/>',
  'skill-source':
    '<rect x="4" y="6" width="16" height="15" rx="2.2"/><path d="M7 3h10M9 6v8l3-2 3 2V6" />',
  'mcp-source':
    '<rect x="3.5" y="3.5" width="17" height="7" rx="2"/><path d="M8 7h8M12 10.5V16M5 16h14M5 16v4m7-4v4m7-4v4" />',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.8"/><path d="m3.8 6.5 6.7 5a2.5 2.5 0 0 0 3 0l6.7-5" />',
  system:
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 8h18M12 14v3" /><circle cx="12" cy="11.5" r="0.8" fill="currentColor" stroke="none"/>'
} as const;

export type MarIconName = keyof typeof iconShapes;

/** Only trusted UI code supplies names; no user SVG is accepted. */
export function marIconSvg(name: MarIconName): string {
  return `<svg class="mar-icon" data-mar-icon="${name}" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${iconShapes[name]}</svg>`;
}
