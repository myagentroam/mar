<script setup lang="ts">
import { basicSetup } from 'codemirror';
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { keymap, Decoration, EditorView } from '@codemirror/view';
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { FileReference } from '@myagentroam/code-navigation';
import { translate } from '../../service/locale-preference-service.js';
import { codeEditorLanguage } from '../../util/code-editor-language.js';
import { navigationTargetAtTextPosition } from '../../util/code-navigation-target.js';

export interface EditorSymbol {
  readonly name: string;
  readonly kind: string;
  readonly from: number;
  readonly depth: number;
}
export type { FileNavigationRequest } from '../../model/workspace-navigation.js';
import type { FileNavigationRequest } from '../../model/workspace-navigation.js';

type EditorNavigationTarget =
  | {
      readonly kind: 'symbol';
      readonly value: string;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly kind: 'reference';
      readonly reference: FileReference;
      readonly sourceContext: FileNavigationRequest['sourceContext'];
      readonly from: number;
      readonly to: number;
    };
const props = defineProps<{
  readonly modelValue: string;
  readonly path: string;
  readonly readOnly: boolean;
  readonly targetLine?: number | undefined;
  readonly targetColumn?: number | undefined;
  readonly codeNavigationEnabled?: boolean;
}>();
const emit = defineEmits<{
  viewed: [range: { startLine: number; endLine: number }];
  'update:modelValue': [value: string];
  symbols: [value: readonly EditorSymbol[]];
  'navigate-symbol': [symbol: string];
  'navigate-file': [request: FileNavigationRequest];
}>();
const host = ref<HTMLElement>();
const editable = new Compartment();
const language = new Compartment();
const navigationTarget = new Compartment();
const navigationDestination = new Compartment();
let view: EditorView | undefined;
let applyingExternalValue = false;
function publishViewed(editor: EditorView): void {
  if (
    document.visibilityState !== 'visible' ||
    !document.hasFocus() ||
    editor.dom.getClientRects().length === 0
  )
    return;
  const startLine = editor.state.doc.lineAt(editor.viewport.from).number;
  emit('viewed', {
    startLine,
    endLine: Math.min(startLine + 79, editor.state.doc.lineAt(editor.viewport.to).number)
  });
}
let symbolPublishTimer: ReturnType<typeof setTimeout> | undefined;
let navigationTargetRange: { readonly from: number; readonly to: number } | undefined;
let navigationDestinationTimer: ReturnType<typeof setTimeout> | undefined;
let languageLoadVersion = 0;
const RICH_EDITOR_LIMIT = 1024 * 1024;
const MAX_NAVIGATION_SOURCE_CONTEXT_BYTES = 8 * 1024;
const utf8Encoder = new TextEncoder();
const navigationTargetMark = Decoration.mark({ class: 'cm-code-navigation-target' });
const navigationDestinationMark = Decoration.line({ class: 'cm-code-navigation-destination' });
const vscodeEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--mar-editor-foreground)',
    backgroundColor: 'var(--mar-editor-background)'
  },
  '.cm-content': { caretColor: 'var(--mar-editor-cursor)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--mar-editor-cursor)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground':
    {
      background: 'var(--mar-editor-selection) !important'
    },
  '.cm-content ::selection': { backgroundColor: 'transparent' },
  '.cm-activeLine': {
    backgroundColor: 'var(--mar-editor-active-line)',
    boxShadow: 'inset 2px 0 0 var(--mar-editor-active-line-indicator)'
  },
  '.cm-gutters': {
    color: 'var(--mar-editor-gutter-foreground)',
    backgroundColor: 'var(--mar-editor-gutter-background)',
    borderRightColor: 'var(--mar-editor-border)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--mar-editor-active-line)' },
  '.cm-selectionMatch': {
    backgroundColor: 'var(--mar-editor-selection-match)',
    outline: '1px solid var(--mar-editor-selection-match-border)',
    outlineOffset: '-1px',
    borderRadius: '2px'
  },
  '.cm-selectionMatch.cm-selectionMatch-main': {
    color: 'var(--mar-editor-selection-match-main-foreground)',
    backgroundColor: 'var(--mar-editor-selection-match-main)',
    outlineColor: 'var(--mar-editor-selection-match-main-border)'
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--mar-editor-search-match)',
    outline: '1px solid var(--mar-editor-search-match-border)',
    outlineOffset: '-1px',
    borderRadius: '2px'
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--mar-editor-search-match-active)',
    outlineColor: 'var(--mar-editor-search-match-active-border)'
  }
});

const vscodeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'var(--mar-editor-keyword)' },
  { tag: tags.controlKeyword, color: 'var(--mar-editor-control-keyword)' },
  { tag: [tags.name, tags.variableName], color: 'var(--mar-editor-variable)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--mar-editor-property)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--mar-editor-function)'
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--mar-editor-type)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--mar-editor-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--mar-editor-number)' },
  { tag: [tags.comment, tags.docComment], color: 'var(--mar-editor-comment)' },
  { tag: tags.regexp, color: 'var(--mar-editor-regexp)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--mar-editor-operator)' },
  { tag: tags.invalid, color: 'var(--mar-editor-invalid)' },
  { tag: tags.heading, color: 'var(--mar-editor-heading)', fontWeight: '600' },
  { tag: tags.link, color: 'var(--mar-editor-link)', textDecoration: 'underline' }
]);

function configureLanguage(editor: EditorView, path: string, contentLength: number): void {
  const requestVersion = ++languageLoadVersion;
  const languageDescription =
    contentLength > RICH_EDITOR_LIMIT ? undefined : codeEditorLanguage(path);
  editor.dispatch({
    effects: language.reconfigure(languageDescription?.support ?? [])
  });
  if (languageDescription === undefined || languageDescription.support !== undefined) return;

  void languageDescription.load().then(
    (support) => {
      if (view !== editor || requestVersion !== languageLoadVersion) return;
      editor.dispatch({ effects: language.reconfigure(support) });
    },
    () => undefined
  );
}

function documentCompletions(context: CompletionContext): CompletionResult | null {
  if (context.state.doc.length > RICH_EDITOR_LIMIT) return null;
  const word = context.matchBefore(/[\p{L}\p{N}_$-]*/u);
  if (word === null || (word.from === word.to && !context.explicit)) return null;
  const words = new Set(context.state.doc.toString().match(/[\p{L}_$][\p{L}\p{N}_$-]{2,}/gu) ?? []);
  return {
    from: word.from,
    options: [...words].slice(0, 300).map((label) => ({ label, type: 'text' }))
  };
}

function collectSymbols(state: EditorState): readonly EditorSymbol[] {
  if (state.doc.length > RICH_EDITOR_LIMIT) return [];
  const output: EditorSymbol[] = [];
  const cursor = syntaxTree(state).cursor();
  const symbolTypes =
    /(?:Declaration|Definition|Class|Interface|Function|Method|Heading|Section|TypeAlias|Enum)/u;
  do {
    if (!symbolTypes.test(cursor.name) || cursor.to <= cursor.from) continue;
    const source = state.sliceDoc(cursor.from, Math.min(cursor.to, cursor.from + 240));
    const match =
      /(?:class|interface|function|def|fn|func|type|enum|const|let|var)?\s*([\p{L}_$][\p{L}\p{N}_$-]*)/u.exec(
        source
      );
    const name = match?.[1];
    let depth = 0;
    for (let parent = cursor.node.parent; parent !== null; parent = parent.parent) depth += 1;
    if (name !== undefined && !output.some((item) => item.from === cursor.from))
      output.push({
        name,
        kind: cursor.name,
        from: cursor.from,
        depth: Math.max(0, depth - 1)
      });
  } while (cursor.next());
  const text = state.doc.toString();
  const fallback =
    /^(\s*)(?:#{1,6}\s+(.+)|(?:export\s+)?(?:async\s+)?(?:class|interface|function|def|fn|func|type|enum)\s+([\p{L}_$][\p{L}\p{N}_$-]*)|(?:function\s+)?([\p{L}_$][\p{L}\p{N}_$-]*)\s*\(\)\s*\{)/gmu;
  for (const match of text.matchAll(fallback)) {
    const name = (match[2] ?? match[3] ?? match[4])?.trim();
    if (
      name === undefined ||
      match.index === undefined ||
      output.some((item) => item.from === match.index)
    )
      continue;
    output.push({
      name,
      kind: match[2] === undefined ? 'Declaration' : 'Heading',
      from: match.index + match[1]!.length,
      depth: match[2] === undefined ? Math.min(4, Math.floor(match[1]!.length / 2)) : 0
    });
  }
  output.sort((left, right) => left.from - right.from);
  return output.slice(0, 1000);
}

function publishSymbols(): void {
  if (view !== undefined) emit('symbols', collectSymbols(view.state));
}

function scheduleSymbolPublish(): void {
  if (symbolPublishTimer !== undefined) clearTimeout(symbolPublishTimer);
  symbolPublishTimer = setTimeout(() => {
    symbolPublishTimer = undefined;
    publishSymbols();
  }, 120);
}

function scrollToLine(line: number, column?: number): void {
  if (view === undefined || line < 1 || line > view.state.doc.lines) return;
  const target = view.state.doc.line(line);
  const position =
    column === undefined ? target.from : Math.min(target.to, target.from + Math.max(0, column - 1));
  if (navigationDestinationTimer !== undefined) clearTimeout(navigationDestinationTimer);
  view.dispatch({
    selection: { anchor: position },
    effects: [
      EditorView.scrollIntoView(position, { y: 'center' }),
      navigationDestination.reconfigure(
        EditorView.decorations.of(Decoration.set([navigationDestinationMark.range(position)]))
      )
    ]
  });
  navigationDestinationTimer = setTimeout(() => {
    if (view !== undefined) view.dispatch({ effects: navigationDestination.reconfigure([]) });
    navigationDestinationTimer = undefined;
  }, 1_800);
  view.focus();
}

function goTo(position: number): void {
  if (view === undefined) return;
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: 'center' })
  });
  view.focus();
}

function cursorPosition(): { readonly line: number; readonly column: number } | undefined {
  if (view === undefined) return undefined;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}

function selectedText(): string {
  if (view === undefined) return '';
  const selection = view.state.selection.main;
  return view.state.doc.sliceString(selection.from, selection.to);
}

function insertText(text: string): void {
  if (view === undefined || props.readOnly) return;
  const selection = view.state.selection.main;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: text },
    selection: { anchor: selection.from + text.length }
  });
  view.focus();
}

function positionAt(
  offset: number
): { readonly line: number; readonly column: number } | undefined {
  if (view === undefined) return undefined;
  const line = view.state.doc.lineAt(Math.max(0, Math.min(offset, view.state.doc.length)));
  return { line: line.number, column: Math.max(0, offset - line.from) + 1 };
}

function openFind(): void {
  if (view === undefined) return;
  openSearchPanel(view);
  decorateSearchPanel();
}

function navigationSourceContext(
  editor: EditorView,
  position: number
): FileNavigationRequest['sourceContext'] & { readonly from: number } {
  const from = Math.max(0, position - MAX_NAVIGATION_SOURCE_CONTEXT_BYTES);
  const to = Math.min(editor.state.doc.length, position + MAX_NAVIGATION_SOURCE_CONTEXT_BYTES);
  const bounded = boundedNavigationSourceContext(editor.state.sliceDoc(from, to), position - from);
  return {
    text: bounded.text,
    position: bounded.position,
    from: from + bounded.from
  };
}

function boundedNavigationSourceContext(
  source: string,
  position: number
): { readonly text: string; readonly position: number; readonly from: number } {
  if (utf8Encoder.encode(source).byteLength <= MAX_NAVIGATION_SOURCE_CONTEXT_BYTES)
    return { text: source, position, from: 0 };

  let from = position;
  let to = position;
  if (from > 0 && isLowSurrogate(source.charCodeAt(from))) from -= 1;
  if (to < source.length && isLowSurrogate(source.charCodeAt(to))) to += 1;
  let bytes = 0;
  let preferBefore = true;

  while (from > 0 || to < source.length) {
    const before = from > 0 ? previousCodePoint(source, from) : undefined;
    const after = to < source.length ? nextCodePoint(source, to) : undefined;
    const candidates = preferBefore ? [before, after] : [after, before];
    const candidate = candidates.find(
      (value) =>
        value !== undefined &&
        bytes + utf8Encoder.encode(value.text).byteLength <= MAX_NAVIGATION_SOURCE_CONTEXT_BYTES
    );
    if (candidate === undefined) break;
    if (candidate.direction === 'before') from = candidate.offset;
    else to = candidate.offset;
    bytes += utf8Encoder.encode(candidate.text).byteLength;
    preferBefore = !preferBefore;
  }

  return { text: source.slice(from, to), position: position - from, from };
}

function previousCodePoint(
  source: string,
  to: number
): { readonly direction: 'before'; readonly offset: number; readonly text: string } {
  const offset = to - (to > 1 && isLowSurrogate(source.charCodeAt(to - 1)) ? 2 : 1);
  return { direction: 'before', offset, text: source.slice(offset, to) };
}

function nextCodePoint(
  source: string,
  from: number
): { readonly direction: 'after'; readonly offset: number; readonly text: string } {
  const offset = from + (isHighSurrogate(source.charCodeAt(from)) ? 2 : 1);
  return { direction: 'after', offset, text: source.slice(from, offset) };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function navigationTargetAtEvent(
  event: MouseEvent,
  editor: EditorView
): EditorNavigationTarget | undefined {
  if (!event.ctrlKey && !event.metaKey) return undefined;
  const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) return undefined;
  const context = navigationSourceContext(editor, position);
  const target = navigationTargetAtTextPosition(props.path, context.text, context.position);
  if (target === undefined) return undefined;
  if (target.kind === 'symbol')
    return {
      kind: 'symbol',
      value: target.value,
      from: context.from + target.from,
      to: context.from + target.to
    };
  return {
    kind: 'reference',
    reference: target.reference,
    sourceContext: { text: context.text, position: context.position },
    from: context.from + target.from,
    to: context.from + target.to
  };
}

function navigationTargetExtension(
  range: { readonly from: number; readonly to: number } | undefined
): Extension {
  return range === undefined
    ? []
    : EditorView.decorations.of(Decoration.set([navigationTargetMark.range(range.from, range.to)]));
}

function setNavigationTarget(
  editor: EditorView,
  range: { readonly from: number; readonly to: number } | undefined
): void {
  if (navigationTargetRange?.from === range?.from && navigationTargetRange?.to === range?.to)
    return;
  navigationTargetRange = range;
  editor.dispatch({ effects: navigationTarget.reconfigure(navigationTargetExtension(range)) });
}

function clearNavigationTargetOnModifierRelease(event: KeyboardEvent): void {
  if (!event.ctrlKey && !event.metaKey && view !== undefined) setNavigationTarget(view, undefined);
}

function navigateSymbol(event: MouseEvent, editor: EditorView): boolean {
  if (!props.codeNavigationEnabled) return false;
  const target = navigationTargetAtEvent(event, editor);
  if (target === undefined) return false;
  event.preventDefault();
  event.stopPropagation();
  // The prevented click does not move the cursor in read-only editors. Preserve its source position.
  editor.dispatch({
    selection: {
      anchor: editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? target.from
    }
  });
  if (target.kind === 'reference') emit('navigate-file', target);
  else emit('navigate-symbol', target.value);
  return true;
}

function updateNavigationCursor(event: MouseEvent, editor: EditorView): boolean {
  if (!props.codeNavigationEnabled) {
    setNavigationTarget(editor, undefined);
    return false;
  }
  const target = navigationTargetAtEvent(event, editor);
  setNavigationTarget(editor, target);
  return false;
}

function decorateSearchPanel(): void {
  queueMicrotask(() => {
    const panel = view?.dom.querySelector('.cm-search');
    panel?.setAttribute('role', 'search');
    panel?.setAttribute('aria-label', translate('inlineFind.label'));
  });
}

function editorMode(readOnly: boolean) {
  return [EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)];
}

function selectAll(): boolean {
  if (view === undefined) return false;
  view.dispatch({
    selection: { anchor: 0, head: view.state.doc.length },
    scrollIntoView: true
  });
  view.focus();
  return true;
}

function isFocused(): boolean {
  return view?.hasFocus ?? false;
}

defineExpose({
  goTo,
  scrollToLine,
  cursorPosition,
  positionAt,
  selectedText,
  insertText,
  openFind,
  isFindOpen: () => view !== undefined && searchPanelOpen(view.state),
  closeFind: () => {
    if (view !== undefined) closeSearchPanel(view);
  },
  selectAll,
  isFocused,
  focus: () => view?.focus()
});

onMounted(() => {
  if (host.value === undefined) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        vscodeEditorTheme,
        syntaxHighlighting(vscodeHighlightStyle),
        language.of([]),
        editable.of(editorMode(props.readOnly)),
        navigationTarget.of([]),
        navigationDestination.of([]),
        EditorState.phrases.of({
          Find: translate('inlineFind.placeholder'),
          Replace: translate('inlineFind.replacePlaceholder'),
          next: translate('inlineFind.next'),
          previous: translate('inlineFind.previous'),
          all: translate('inlineFind.selectAll'),
          'match case': translate('inlineFind.matchCase'),
          regexp: translate('inlineFind.regexp'),
          'by word': translate('inlineFind.wholeWord'),
          replace: translate('inlineFind.replace'),
          'replace all': translate('inlineFind.replaceAll'),
          close: translate('inlineFind.close')
        }),
        autocompletion(),
        EditorState.languageData.of(() => [{ autocomplete: documentCompletions }]),
        keymap.of([
          {
            key: 'Mod-h',
            run: openSearchPanel
          }
        ]),
        EditorView.domEventHandlers({
          mousedown: (event, editor) => navigateSymbol(event, editor),
          mousemove: (event, editor) => updateNavigationCursor(event, editor),
          mouseleave: (_event, editor) => {
            setNavigationTarget(editor, undefined);
            return false;
          },
          keydown: (event, editor) => {
            if (!event.ctrlKey && !event.metaKey) setNavigationTarget(editor, undefined);
            return false;
          },
          keyup: (event, editor) => {
            if (!event.ctrlKey && !event.metaKey) setNavigationTarget(editor, undefined);
            return false;
          },
          blur: (_event, editor) => {
            setNavigationTarget(editor, undefined);
            return false;
          }
        }),
        EditorView.updateListener.of((update) => {
          if (update.viewportChanged || update.selectionSet || update.focusChanged)
            publishViewed(update.view);
          if (update.docChanged && !applyingExternalValue)
            emit('update:modelValue', update.state.doc.toString());
          if (update.docChanged) scheduleSymbolPublish();
          else if (update.transactions.some((transaction) => transaction.reconfigured))
            publishSymbols();
          decorateSearchPanel();
        })
      ]
    })
  });
  configureLanguage(view, props.path, props.modelValue.length);
  view.requestMeasure({ read: publishViewed });
  window.addEventListener('keyup', clearNavigationTargetOnModifierRelease, { capture: true });
  if (props.targetLine !== undefined) scrollToLine(props.targetLine, props.targetColumn);
});

watch(
  () => props.modelValue,
  (value) => {
    if (view === undefined || value === view.state.doc.toString()) return;
    applyingExternalValue = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    applyingExternalValue = false;
  }
);
watch(
  () => props.readOnly,
  (value) => view?.dispatch({ effects: editable.reconfigure(editorMode(value)) })
);
watch(
  () => props.path,
  (value) => {
    if (view !== undefined) configureLanguage(view, value, view.state.doc.length);
  }
);
watch(
  () => props.modelValue.length > RICH_EDITOR_LIMIT,
  () => {
    if (view !== undefined) configureLanguage(view, props.path, view.state.doc.length);
  }
);
watch(
  () => [props.targetLine, props.targetColumn] as const,
  ([line, column]) => {
    if (line !== undefined) scrollToLine(line, column);
  }
);
onBeforeUnmount(() => {
  languageLoadVersion += 1;
  if (symbolPublishTimer !== undefined) clearTimeout(symbolPublishTimer);
  if (navigationDestinationTimer !== undefined) clearTimeout(navigationDestinationTimer);
  window.removeEventListener('keyup', clearNavigationTargetOnModifierRelease, { capture: true });
  view?.destroy();
  view = undefined;
});
</script>

<template><div ref="host" class="code-file-editor" /></template>

<style scoped>
.code-file-editor {
  --mar-editor-background: #ffffff;
  --mar-editor-foreground: #1f1f1f;
  --mar-editor-cursor: #000000;
  --mar-editor-selection: color-mix(
    in srgb,
    var(--mar-color-brand) 40%,
    var(--mar-editor-background)
  );
  --mar-editor-selection-match: color-mix(
    in srgb,
    var(--mar-color-brand) 10%,
    var(--mar-editor-background)
  );
  --mar-editor-selection-match-border: color-mix(
    in srgb,
    var(--mar-color-brand) 30%,
    var(--mar-editor-background)
  );
  --mar-editor-selection-match-main: var(--mar-editor-selection);
  --mar-editor-selection-match-main-border: var(--mar-color-brand);
  --mar-editor-selection-match-main-foreground: var(--mar-editor-foreground);
  --mar-editor-active-line: rgb(31 31 31 / 3%);
  --mar-editor-active-line-indicator: #91a3b7;
  --mar-editor-gutter-background: #f8f8f8;
  --mar-editor-gutter-foreground: #6e7681;
  --mar-editor-border: #e5e5e5;
  --mar-editor-search-match: #f8eec7;
  --mar-editor-search-match-border: #d6bd58;
  --mar-editor-search-match-active: #f2c94c;
  --mar-editor-search-match-active-border: #bd8e16;
  --mar-editor-keyword: #0000ff;
  --mar-editor-control-keyword: #af00db;
  --mar-editor-variable: #001080;
  --mar-editor-property: #001080;
  --mar-editor-function: #795e26;
  --mar-editor-type: #267f99;
  --mar-editor-string: #a31515;
  --mar-editor-number: #098658;
  --mar-editor-comment: #008000;
  --mar-editor-regexp: #811f3f;
  --mar-editor-operator: #1f1f1f;
  --mar-editor-invalid: #cd3131;
  --mar-editor-heading: #0451a5;
  --mar-editor-link: #0000ff;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

:global(html[data-theme='vscode-dark-2026'] .code-file-editor) {
  --mar-editor-background: #1e1e1e;
  --mar-editor-foreground: #d4d4d4;
  --mar-editor-cursor: #aeafad;
  --mar-editor-selection: color-mix(
    in srgb,
    var(--mar-color-brand) 55%,
    var(--mar-editor-background)
  );
  --mar-editor-active-line: rgb(255 255 255 / 4%);
  --mar-editor-active-line-indicator: #4e83ac;
  --mar-editor-gutter-background: #1e1e1e;
  --mar-editor-gutter-foreground: #858585;
  --mar-editor-border: #333333;
  --mar-editor-search-match: #5b763e;
  --mar-editor-search-match-border: #9ebf6e;
  --mar-editor-search-match-active: #b7651d;
  --mar-editor-search-match-active-border: #f0a35b;
  --mar-editor-keyword: #569cd6;
  --mar-editor-control-keyword: #c586c0;
  --mar-editor-variable: #9cdcfe;
  --mar-editor-property: #9cdcfe;
  --mar-editor-function: #dcdcaa;
  --mar-editor-type: #4ec9b0;
  --mar-editor-string: #ce9178;
  --mar-editor-number: #b5cea8;
  --mar-editor-comment: #6a9955;
  --mar-editor-regexp: #d16969;
  --mar-editor-operator: #d4d4d4;
  --mar-editor-invalid: #f44747;
  --mar-editor-heading: #569cd6;
  --mar-editor-link: #4daafc;
}

.code-file-editor :deep(.cm-editor) {
  height: 100%;
  color: var(--mar-editor-foreground);
  background: var(--mar-editor-background);
  font-family: var(--mar-font-mono);
  font-size: calc(13px * var(--mar-preview-zoom, 1));
}

.code-file-editor :deep(.cm-code-navigation-target) {
  cursor: pointer;
  color: var(--mar-color-brand);
  text-decoration: underline;
  text-decoration-color: currentColor;
  text-underline-offset: 2px;
}

.code-file-editor :deep(.cm-line.cm-code-navigation-destination) {
  background: color-mix(in srgb, var(--mar-color-brand) 15%, transparent);
  box-shadow: inset 2px 0 0 var(--mar-color-brand);
}

.code-file-editor :deep(.cm-scroller) {
  overflow: auto;
}

.code-file-editor :deep(.cm-gutters) {
  color: var(--mar-editor-gutter-foreground);
  background: var(--mar-editor-gutter-background);
  border-right: 1px solid var(--mar-editor-border);
}

.code-file-editor :deep(.cm-panels) {
  color: var(--mar-editor-foreground);
  background: var(--mar-editor-background);
  border-color: var(--mar-editor-border);
}

.code-file-editor :deep(.cm-search) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem 0.55rem;
}

.code-file-editor :deep(.cm-search label) {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin: 0;
  color: var(--mar-editor-foreground);
}

.code-file-editor :deep(.cm-textfield) {
  min-height: 1.75rem;
  padding: 0.2rem 0.45rem;
  color: var(--mar-editor-foreground);
  background: var(--mar-editor-background);
  border: 1px solid var(--mar-editor-border);
  border-radius: 3px;
  outline: none;
}

.code-file-editor :deep(.cm-textfield:focus) {
  border-color: var(--mar-color-brand);
}

.code-file-editor :deep(.cm-button) {
  min-height: 1.75rem;
  padding: 0.2rem 0.55rem;
  color: var(--mar-editor-foreground);
  background: var(--mar-editor-active-line);
  border: 1px solid var(--mar-editor-border);
  border-radius: 3px;
  background-image: none;
}

.code-file-editor :deep(.cm-button:hover) {
  border-color: var(--mar-color-brand);
}

.code-file-editor :deep(.cm-panel.cm-search [name='close']) {
  position: static;
  order: 20;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  color: var(--mar-editor-foreground);
  font-size: 1.1rem;
}

.code-file-editor :deep(.cm-tooltip-autocomplete) {
  overflow: hidden;
  color: var(--mar-editor-foreground);
  background: var(--mar-editor-background);
  border: 1px solid var(--mar-editor-border);
  border-radius: 3px;
  box-shadow: var(--el-box-shadow-light);
}

.code-file-editor :deep(.cm-tooltip-autocomplete > ul) {
  font-family: var(--mar-font-mono);
}

.code-file-editor :deep(.cm-tooltip-autocomplete > ul > li) {
  padding: 0.2rem 0.45rem;
}

.code-file-editor :deep(.cm-tooltip-autocomplete > ul > li[aria-selected]) {
  color: var(--mar-editor-foreground);
  background: var(--mar-editor-selection);
}
</style>
