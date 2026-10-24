import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElMessage, type MessageBoxData } from 'element-plus';
import PersonalInstructionsSettings from '../../src/view/settings/PersonalInstructionsSettings.vue?unit-render';
import { ElMessageBox } from '../../src/service/message-box-service.js';
import { flushComponent, renderComponent, trigger } from './support/component-renderer.js';

const initial = {
  common: 'Common saved',
  marAgent: 'MAR saved',
  codex: 'Codex saved',
  claudeCode: '',
  openCode: ''
};

const confirmed = 'confirm' as MessageBoxData;

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Personal instruction draft ownership', () => {
  async function setup(validate?: () => Promise<boolean>) {
    vi.stubGlobal('Document', class {});
    vi.stubGlobal('ShadowRoot', class {});
    const success = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }));
    const error = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }));
    const response = gate<{ instructions: typeof initial }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ instructions: { ...initial } })
      .mockImplementation(() => response.promise);
    const view = renderComponent(
      PersonalInstructionsSettings,
      { request },
      {},
      validate === undefined ? {} : { validate }
    );
    await flushComponent();
    const edit = (value: string) =>
      trigger(view.findAll('textarea')[0]!, 'onUpdate:modelValue', value);
    const select = (index: number) => trigger(view.findAll('ElCheckTag')[index]!, 'onChange');
    const save = () =>
      trigger(
        view.findAll('ElButton').find((node) => node.props['type'] === 'primary')!,
        'onClick'
      );
    const value = () => (view.findAll('textarea')[0]! as unknown as { value: string }).value;
    return { view, response, request, success, error, edit, select, save, value };
  }

  it('merges only the submitted scope and retains active and inactive drafts after switching back', async () => {
    const fixture = await setup();
    const { view, edit, select, save, value, response, request } = fixture;
    try {
      await select(2);
      await edit('Codex unsaved');
      await select(0);
      await edit('Common submitted');
      const pending = save();
      await flushComponent();
      expect(request).toHaveBeenLastCalledWith('/api/personal-instructions/COMMON', {
        method: 'PUT',
        body: JSON.stringify({ content: 'Common submitted' })
      });
      await select(1);
      await edit('MAR unsaved');
      response.resolve({ instructions: { ...initial, common: 'Common authoritative' } });
      await pending;
      expect(value()).toBe('MAR unsaved');
      await select(2);
      expect(value()).toBe('Codex unsaved');
      await select(0);
      expect(value()).toBe('Common authoritative');
      await select(1);
      expect(value()).toBe('MAR unsaved');
      expect(fixture.success).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it('keeps the submission scope and content while validation is pending', async () => {
    const validation = gate<boolean>();
    const { view, edit, select, save, request, response, value } = await setup(
      () => validation.promise
    );
    try {
      await edit('Validated common');
      const pending = save();
      await select(1);
      await edit('MAR during validation');
      validation.resolve(true);
      await flushComponent();
      expect(request).toHaveBeenLastCalledWith('/api/personal-instructions/COMMON', {
        method: 'PUT',
        body: JSON.stringify({ content: 'Validated common' })
      });
      response.resolve({ instructions: { ...initial, common: 'Validated common' } });
      await pending;
      expect(value()).toBe('MAR during validation');
    } finally {
      view.unmount();
    }
  });

  it('retains drafts on failure and allows a normal retry in the submitted scope', async () => {
    const fixture = await setup();
    const { view, edit, select, save, response, value, request } = fixture;
    try {
      await edit('Common retry draft');
      const pending = save();
      await flushComponent();
      await select(1);
      await edit('MAR failure draft');
      response.reject(new Error('Save unavailable'));
      await pending;
      expect(fixture.error).toHaveBeenCalledOnce();
      expect(fixture.success).not.toHaveBeenCalled();
      expect(value()).toBe('MAR failure draft');
      await select(0);
      expect(value()).toBe('Common retry draft');
      request.mockResolvedValueOnce({ instructions: { ...initial, common: 'Common retry saved' } });
      await save();
      expect(value()).toBe('Common retry saved');
      await select(1);
      expect(value()).toBe('MAR failure draft');
    } finally {
      view.unmount();
    }
  });

  it('preserves newer edits when returning to the submitted scope before completion', async () => {
    const { view, edit, select, save, response, value } = await setup();
    try {
      await edit('Common submitted');
      const pending = save();
      await flushComponent();
      await select(1);
      await select(0);
      await edit('Common newer draft');
      await select(2);
      response.resolve({ instructions: { ...initial, common: 'Common submitted' } });
      await pending;
      await select(0);
      expect(value()).toBe('Common newer draft');
    } finally {
      view.unmount();
    }
  });

  it('does not write when form validation fails', async () => {
    const { view, edit, save, request, value } = await setup(async () => false);
    try {
      await edit('');
      await save();
      expect(request).toHaveBeenCalledTimes(1);
      expect(value()).toBe('');
    } finally {
      view.unmount();
    }
  });

  it('clears only the confirmed scope and retains other drafts while its response is pending', async () => {
    const confirmation = gate<MessageBoxData>();
    vi.spyOn(ElMessageBox, 'confirm').mockReturnValue(confirmation.promise);
    const { view, edit, select, response, request, value } = await setup();
    try {
      await edit('Common clear draft');
      const pending = trigger(view.findAll('ElButton')[0]!, 'onClick');
      await select(1);
      await edit('MAR clear draft');
      confirmation.resolve(confirmed);
      await flushComponent();
      expect(request).toHaveBeenLastCalledWith('/api/personal-instructions/COMMON', {
        method: 'DELETE'
      });
      response.resolve({ instructions: { ...initial, common: '' } });
      await pending;
      expect(value()).toBe('MAR clear draft');
      await select(0);
      expect(value()).toBe('');
      await select(1);
      expect(value()).toBe('MAR clear draft');
    } finally {
      view.unmount();
    }
  });

  it('retains drafts on clear failure and does not write after canceling confirmation', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(confirmed);
    const { view, edit, select, response, request, value, error } = await setup();
    try {
      await edit('Common clear retry');
      const pending = trigger(view.findAll('ElButton')[0]!, 'onClick');
      await flushComponent();
      await select(1);
      await edit('MAR retained');
      response.reject(new Error('Clear unavailable'));
      await pending;
      expect(error).toHaveBeenCalledOnce();
      await select(0);
      expect(value()).toBe('Common clear retry');
      confirm.mockRejectedValueOnce('cancel');
      await trigger(view.findAll('ElButton')[0]!, 'onClick');
      expect(request).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledOnce();
      await select(1);
      expect(value()).toBe('MAR retained');
    } finally {
      view.unmount();
    }
  });
});
