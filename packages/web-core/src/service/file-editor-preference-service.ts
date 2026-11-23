import { readonly, ref, type DeepReadonly, type Ref } from 'vue';

export type FileEditorDefaultMode = 'edit' | 'read-only';

const STORAGE_KEY = 'mar.file-editor.default-mode';
const mode = ref<FileEditorDefaultMode>(readStoredMode());

function readStoredMode(): FileEditorDefaultMode {
  return parseFileEditorDefaultMode(
    typeof localStorage === 'undefined' ? undefined : localStorage.getItem(STORAGE_KEY)
  );
}

export function parseFileEditorDefaultMode(value: unknown): FileEditorDefaultMode {
  return value === 'edit' ? 'edit' : 'read-only';
}

export function fileEditorPreferenceService(): {
  readonly mode: DeepReadonly<Ref<FileEditorDefaultMode>>;
  readonly setMode: (value: FileEditorDefaultMode) => void;
} {
  return {
    mode: readonly(mode),
    setMode(value) {
      mode.value = value;
      if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value);
    }
  };
}
