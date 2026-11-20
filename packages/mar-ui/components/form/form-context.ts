import {
  computed,
  inject,
  onScopeDispose,
  useId,
  type AriaAttributes,
  type InjectionKey
} from 'vue';
import type { RuleItem } from 'async-validator';

export type FormItemProp = string | string[];
export type FormItemRule = RuleItem & { trigger?: 'blur' | 'change' | ('blur' | 'change')[] };
export type FormRules<Model extends object = Record<string, unknown>> = Partial<
  Record<Extract<keyof Model, string> | (string & {}), FormItemRule | FormItemRule[]>
>;
export interface FormInstance {
  validate(): Promise<boolean>;
  validateField(prop: FormItemProp): Promise<boolean>;
  clearValidate(prop?: FormItemProp): void;
}

export interface Field {
  key(): string | undefined;
  validate(): Promise<string | undefined>;
  clear(): void;
}
export const formKey: InjectionKey<{
  model(): object | undefined;
  rules(): FormRules | undefined;
  disabled(): boolean;
  register(field: Field): () => void;
  report(prop: FormItemProp, valid: boolean, message: string): void;
}> = Symbol('mar-ui-form');

export const fieldControlKey: InjectionKey<{
  register(control: { id(): string | undefined; validates(): boolean }): () => void;
  invalid(): boolean;
  description(): string | undefined;
  blur(): void;
}> = Symbol('mar-ui-form-field');

export function useMarFormDisabled(local: () => boolean | undefined) {
  const form = inject(formKey, undefined);
  return computed(() => local() ?? form?.disabled() ?? false);
}

// A control supplies the real focus target. The item can then associate its label and error.
export function useMarFormControl(options: {
  id(): string | undefined;
  disabled(): boolean | undefined;
  validateEvent?: () => boolean | undefined;
}) {
  const field = inject(fieldControlKey, undefined);
  const generatedId = field ? useId() : undefined;
  const id = computed(() => options.id() ?? generatedId);
  const validates = () => options.validateEvent?.() !== false;
  if (field) onScopeDispose(field.register({ id: () => id.value, validates }));
  return {
    id,
    disabled: useMarFormDisabled(options.disabled),
    ariaInvalid(existing: unknown): AriaAttributes['aria-invalid'] {
      if (field?.invalid()) return true;
      if (
        typeof existing === 'boolean' ||
        existing === 'true' ||
        existing === 'false' ||
        existing === 'grammar' ||
        existing === 'spelling'
      )
        return existing;
      return undefined;
    },
    describedBy(existing: unknown) {
      const error = field?.description();
      const ids = typeof existing === 'string' ? existing : undefined;
      return ids && error ? `${ids} ${error}` : ids || error;
    },
    blur() {
      if (validates()) field?.blur();
    }
  };
}
