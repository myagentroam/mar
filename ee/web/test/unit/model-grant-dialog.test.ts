import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import ModelGrantExtension from '../../src/view/settings/ModelGrantExtension.vue?unit-render';
import { i18n } from '../../../../packages/web-core/src/service/locale-preference-service.js';
import { ElMessageBox } from '../../../../packages/web-core/src/service/message-box-service.js';
import { showMessage } from '../../../../packages/web-core/src/service/message-feedback-service.js';
import {
  flushComponent,
  renderComponent,
  textContent,
  trigger
} from '../../../../packages/web-core/test/unit/support/component-renderer.js';

vi.mock('../../../../packages/web-core/src/service/message-feedback-service.js', () => ({
  showMessage: vi.fn()
}));

const modelA = { id: 'model-a', name: 'Assistant A', modelId: 'vendor/a' };
const modelB = { id: 'model-b', name: 'Assistant B', modelId: 'vendor/b' };
const grantA = { id: 'grant-a', targetType: 'ORGANIZATION', targetOrganizationId: 1 };
const grantB = { id: 'grant/b', targetType: 'ORGANIZATION', targetOrganizationId: 2 };
const organizations = [
  { id: 1, name: 'Engineering', parentOrganizationId: null },
  { id: 2, name: 'Research', parentOrganizationId: null }
];
const originalLocale = i18n.global.locale.value;
// Confirm resolves to the action string at runtime, despite Element Plus's intersection type.
const confirmed = 'confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>;

describe('Model grant dialog', () => {
  const exposed = ref<{ open: (row: typeof modelA) => Promise<void> }>();
  const readGrants = vi.fn<(modelId: string) => Promise<{ grants: (typeof grantA)[] }>>();
  const writeGrant = vi.fn<(path: string, init: RequestInit) => Promise<object>>();
  const refresh = vi.fn<() => Promise<(typeof modelA)[]>>();
  const validate = vi.fn<() => Promise<boolean>>();
  let view: ReturnType<typeof renderComponent>;

  beforeEach(() => {
    i18n.global.locale.value = 'en-US';
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    });
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue(confirmed);
    readGrants.mockReset().mockImplementation(async (id) => ({
      grants: id === modelA.id ? [grantA] : [grantB]
    }));
    writeGrant.mockReset().mockResolvedValue({});
    refresh.mockReset().mockResolvedValue([modelA, modelB]);
    validate.mockReset().mockResolvedValue(true);
    const request = (path: string, init?: RequestInit) => {
      if (path === '/api/organizations') return Promise.resolve({ organizations });
      if (path === '/api/enterprise/users') return Promise.resolve({ users: [] });
      if (path.startsWith('/api/resource-grants?')) {
        const query = new URLSearchParams(path.split('?')[1]);
        expect(query.get('resourceType')).toBe('MODEL');
        return readGrants(query.get('modelId')!);
      }
      if (init?.method === 'POST' || init?.method === 'DELETE') return writeGrant(path, init);
      throw new Error(`Unexpected request: ${path}`);
    };
    view = renderComponent(
      defineComponent({
        setup: () => () =>
          h(ModelGrantExtension, { ref: exposed, request, writable: true, refresh })
      }),
      {},
      {},
      { validate }
    );
  });

  afterEach(() => {
    view.unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(showMessage).mockClear();
    i18n.global.locale.value = originalLocale;
  });

  function dialog() {
    const dialogs = view.findAll('ElDialog');
    expect(dialogs).toHaveLength(1);
    return dialogs[0]!;
  }

  function button(label: string) {
    const buttons = view.findAll('ElButton').filter((node) => textContent(node).trim() === label);
    expect(buttons, label).toHaveLength(1);
    return buttons[0]!;
  }

  async function open(model: typeof modelA) {
    await exposed.value!.open(model);
    await flushComponent();
  }

  async function chooseOrganization(id: number) {
    await trigger(view.findAll('el-cascader')[0]!, 'onUpdate:modelValue', id);
  }

  it('keeps B context, rows and revoke target when the closed A read returns last', async () => {
    const readA = Promise.withResolvers<{ grants: (typeof grantA)[] }>();
    readGrants.mockReturnValueOnce(readA.promise);
    const openingA = exposed.value!.open(modelA);
    await flushComponent();
    await trigger(button('Close'), 'onClick');
    await open(modelB);
    readA.resolve({ grants: [grantA] });
    await openingA;
    await flushComponent();

    expect(textContent(dialog())).toContain('Assistant B');
    expect(textContent(dialog())).toContain('vendor/b');
    expect(textContent(dialog())).toContain('Research');
    expect(textContent(dialog())).not.toContain('Engineering');
    expect(button('Revoke').props.disabled).toBe(false);
    readGrants.mockResolvedValueOnce({ grants: [] });
    refresh.mockResolvedValueOnce([{ ...modelB, name: 'Refreshed B' }]);
    await trigger(button('Revoke'), 'onClick');

    expect(writeGrant.mock.calls).toEqual([
      ['/api/resource-grants/grant%2Fb', { method: 'DELETE' }]
    ]);
    expect(readGrants.mock.calls).toEqual([[modelA.id], [modelB.id], [modelB.id]]);
    expect(textContent(dialog())).toContain('Refreshed B');
    expect(view.findAll('ElButton').map(textContent)).not.toContain('Revoke');
  });

  it('ignores a closed A read failure without changing B loading or reporting a stale error', async () => {
    const readA = Promise.withResolvers<{ grants: (typeof grantA)[] }>();
    const readB = Promise.withResolvers<{ grants: (typeof grantB)[] }>();
    readGrants.mockReturnValueOnce(readA.promise).mockReturnValueOnce(readB.promise);
    const openingA = exposed.value!.open(modelA);
    await flushComponent();
    await trigger(button('Close'), 'onClick');
    const openingB = exposed.value!.open(modelB);
    await flushComponent();
    expect(button('Grant').props.disabled).toBe(true);
    expect(view.findAll('ElButton').map(textContent)).not.toContain('Revoke');
    readA.reject(new Error('Late A read failure'));
    await openingA;
    await flushComponent();

    expect(textContent(dialog())).toContain('Assistant B');
    expect(button('Grant').props.disabled).toBe(true);
    expect(showMessage).not.toHaveBeenCalled();
    readB.resolve({ grants: [grantB] });
    await openingB;
    await flushComponent();
    expect(button('Grant').props.disabled).toBe(false);
    expect(textContent(dialog())).toContain('Research');
  });

  it.each([
    ['a different model', modelB, 'Research'],
    ['the same model', modelA, 'Engineering']
  ] as const)(
    'keeps a reopened dialog for %s independent of an already submitted grant',
    async (_, model, label) => {
      const oldWrite = Promise.withResolvers<object>();
      const newWrite = Promise.withResolvers<object>();
      writeGrant.mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
      await open(modelA);
      await chooseOrganization(2);
      const savingA = trigger(button('Grant'), 'onClick');
      await flushComponent();
      expect(writeGrant).toHaveBeenNthCalledWith(1, '/api/resource-grants', {
        method: 'POST',
        body: JSON.stringify({
          resourceType: 'MODEL',
          modelId: modelA.id,
          targetType: 'ORGANIZATION',
          targetOrganizationId: 2
        })
      });
      await trigger(button('Close'), 'onClick');
      await open(model);
      expect(button('Grant').props.loading).toBe(false);
      expect(view.findAll('el-cascader')[0]!.props.modelValue).toBeUndefined();
      await chooseOrganization(1);
      const savingNew = trigger(button('Grant'), 'onClick');
      await flushComponent();
      expect(writeGrant).toHaveBeenNthCalledWith(2, '/api/resource-grants', {
        method: 'POST',
        body: JSON.stringify({
          resourceType: 'MODEL',
          modelId: model.id,
          targetType: 'ORGANIZATION',
          targetOrganizationId: 1
        })
      });

      refresh.mockResolvedValueOnce([{ ...modelA, name: 'Expired A refresh' }]);
      oldWrite.resolve({});
      await savingA;
      expect(refresh).toHaveBeenCalledOnce();
      expect(showMessage).toHaveBeenCalledWith('“Assistant A”: Model access granted.', 'success');
      expect(textContent(dialog())).toContain(model.name);
      expect(textContent(dialog())).toContain(label);
      expect(button('Grant').props.loading).toBe(true);
      expect(readGrants.mock.calls).toEqual([[modelA.id], [model.id]]);

      newWrite.resolve({});
      await savingNew;
      expect(button('Grant').props.loading).toBe(false);
    }
  );

  it('does not reopen a closed dialog when its submitted revoke finishes', async () => {
    const write = Promise.withResolvers<object>();
    writeGrant.mockReturnValueOnce(write.promise);
    await open(modelA);
    const revoking = trigger(button('Revoke'), 'onClick');
    await flushComponent();
    expect(writeGrant).toHaveBeenCalledWith('/api/resource-grants/grant-a', { method: 'DELETE' });
    await trigger(button('Close'), 'onClick');
    write.resolve({});
    await revoking;
    expect(view.findAll('ElDialog')).toHaveLength(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(showMessage).toHaveBeenCalledWith('“Assistant A”: Model access revoked.', 'success');
  });

  it('does not replace a reopened same-model dialog with a late post-write grant read', async () => {
    const staleRead = Promise.withResolvers<{ grants: (typeof grantA)[] }>();
    await open(modelA);
    readGrants.mockReturnValueOnce(staleRead.promise);
    const revoking = trigger(button('Revoke'), 'onClick');
    await flushComponent();
    expect(readGrants.mock.calls).toEqual([[modelA.id], [modelA.id]]);
    await trigger(button('Close'), 'onClick');
    readGrants.mockResolvedValueOnce({ grants: [] });
    await open({ ...modelA, name: 'Current A' });

    staleRead.resolve({ grants: [grantA] });
    await revoking;
    expect(textContent(dialog())).toContain('Current A');
    expect(textContent(dialog())).not.toContain('Engineering');
    expect(view.findAll('ElButton').map(textContent)).not.toContain('Revoke');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not submit a grant when validation completes after the dialog is reopened', async () => {
    const validation = Promise.withResolvers<boolean>();
    validate.mockReturnValueOnce(validation.promise);
    await open(modelA);
    await chooseOrganization(1);
    const saving = trigger(button('Grant'), 'onClick');
    await trigger(button('Close'), 'onClick');
    await open(modelB);
    await chooseOrganization(2);
    validation.resolve(true);
    await saving;

    expect(validate).toHaveBeenCalledOnce();
    expect(writeGrant).not.toHaveBeenCalled();
    expect(textContent(dialog())).toContain('Assistant B');
    expect(view.findAll('el-cascader')[0]!.props.modelValue).toBe(2);
  });

  it('does not revoke when confirmation completes after the dialog is reopened', async () => {
    const confirmation = Promise.withResolvers<typeof confirmed>();
    vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(confirmation.promise);
    await open(modelA);
    const revoking = trigger(button('Revoke'), 'onClick');
    await trigger(button('Close'), 'onClick');
    await open(modelB);
    confirmation.resolve(confirmed);
    await revoking;

    expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
    expect(writeGrant).not.toHaveBeenCalled();
    expect(textContent(dialog())).toContain('Assistant B');
    expect(textContent(dialog())).toContain('Research');
  });

  it('does not retarget handlers from the previous opening even when the same grant is visible', async () => {
    await open(modelA);
    const previousGrant = button('Grant');
    const previousRevoke = button('Revoke');
    await trigger(button('Close'), 'onClick');
    await open(modelA);
    await chooseOrganization(2);

    await trigger(previousRevoke, 'onClick');
    await trigger(previousGrant, 'onClick');

    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(writeGrant).not.toHaveBeenCalled();
    expect(textContent(dialog())).toContain('Engineering');
  });
});
