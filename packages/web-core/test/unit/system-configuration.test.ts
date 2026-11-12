import { describe, expect, it, vi } from 'vitest';
import { createSystemConfigurationService } from '../../src/service/system-configuration-service.js';

describe('Shared system configuration transactions', () => {
  it('defaults resource URLs on and writes the global switch independently', async () => {
    const request = vi.fn(async () => ({ useResourceUrl: false }));
    const service = createSystemConfigurationService(request as never);
    expect(service.snapshot.value.useResourceUrl).toBe(true);
    service.beginEdit('mar-agent-resource-input');
    service.setDraft('mar-agent-resource-input', false);
    expect(await service.save('mar-agent-resource-input')).toBe(true);
    expect(request).toHaveBeenCalledWith('/api/system-settings/mar-agent-resource-input', {
      method: 'PATCH',
      body: JSON.stringify({ useResourceUrl: false })
    });
    expect(service.snapshot.value.useResourceUrl).toBe(false);
  });
  it('defaults Web Push off and updates only the selected administrator switch', async () => {
    const request = vi.fn(async () => ({ webPushEnabled: true }));
    const service = createSystemConfigurationService(request as never);
    expect(service.snapshot.value.webPushEnabled).toBe(false);
    service.beginEdit('web-push');
    service.setDraft('web-push', 'true');
    expect(service.drafts.value.webPushEnabled).toBe(false);
    expect(request).not.toHaveBeenCalled();
    service.setDraft('web-push', true);
    expect(await service.save('web-push')).toBe(true);
    expect(request).toHaveBeenCalledWith('/api/system-settings/web-push', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true })
    });
    expect(service.snapshot.value.webPushEnabled).toBe(true);
  });
  it('saves an optional HTML preview origin and refuses invalid origins', async () => {
    const request = vi.fn(async () => ({
      htmlPreviewOrigin: 'https://preview.example.test',
      skillTlsVerificationDisabled: false
    }));
    const service = createSystemConfigurationService(request as never);
    service.beginEdit('html-preview-origin');
    for (const invalidOrigin of [
      'https://preview.example.test/',
      'https://user:password@preview.example.test',
      'https://preview.example.test?token=hidden',
      'https://preview.example.test#fragment',
      'ftp://preview.example.test'
    ]) {
      service.setDraft('html-preview-origin', invalidOrigin);
      expect(await service.save('html-preview-origin')).toBe(false);
    }
    service.setDraft('html-preview-origin', 'https://preview.example.test');
    expect(await service.save('html-preview-origin')).toBe(true);
    expect(request).toHaveBeenCalledWith('/api/system-settings/html-preview-origin', {
      method: 'PATCH',
      body: JSON.stringify({ origin: 'https://preview.example.test' })
    });
  });

  it('saves an external HTTP HTML preview origin', async () => {
    const request = vi.fn(async () => ({
      htmlPreviewOrigin: 'http://preview.example.test',
      skillTlsVerificationDisabled: false
    }));
    const service = createSystemConfigurationService(request as never);
    service.beginEdit('html-preview-origin');
    service.setDraft('html-preview-origin', 'http://preview.example.test');
    expect(await service.save('html-preview-origin')).toBe(true);
    expect(request).toHaveBeenCalledWith('/api/system-settings/html-preview-origin', {
      method: 'PATCH',
      body: JSON.stringify({ origin: 'http://preview.example.test' })
    });
  });

  it('loads the authority and cancels an edit without writing', async () => {
    const request = vi.fn(async () => ({ skillTlsVerificationDisabled: false }));
    const service = createSystemConfigurationService(request as never);
    await service.load();
    service.beginEdit('skill-tls');
    service.setDraft('skill-tls', true);
    expect(service.drafts.value.skillTlsVerificationDisabled).toBe(true);
    service.cancelEdit('skill-tls');
    expect(service.drafts.value.skillTlsVerificationDisabled).toBe(false);
    expect(service.editingKey.value).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('writes only the selected field and applies the complete returned snapshot', async () => {
    const request = vi.fn(async () => ({ skillTlsVerificationDisabled: true, opaqueSetting: 42 }));
    const service = createSystemConfigurationService(request as never);
    service.beginEdit('skill-tls');
    service.setDraft('skill-tls', true);
    expect(await service.save('skill-tls')).toBe(true);
    expect(request).toHaveBeenCalledWith('/api/system-settings/skill-tls', {
      method: 'PATCH',
      body: JSON.stringify({ verificationDisabled: true })
    });
    expect(service.snapshot.value).toEqual({
      skillTlsVerificationDisabled: true,
      opaqueSetting: 42
    });
    expect(service.editingKey.value).toBeNull();
    expect(service.savingKey.value).toBeNull();
  });

  it('keeps the draft and original failure on rejection and releases the save lock', async () => {
    const failure = new Error('FORBIDDEN');
    const service = createSystemConfigurationService(
      vi.fn(async () => {
        throw failure;
      }) as never
    );
    service.beginEdit('skill-tls');
    service.setDraft('skill-tls', true);
    await expect(service.save('skill-tls')).rejects.toBe(failure);
    expect(service.editingKey.value).toBe('skill-tls');
    expect(service.drafts.value.skillTlsVerificationDisabled).toBe(true);
    expect(service.snapshot.value.skillTlsVerificationDisabled).toBe(false);
    expect(service.savingKey.value).toBeNull();
  });

  it('extends the catalog without interpreting host policy and serializes saves', async () => {
    let finish!: (value: Record<string, number | boolean>) => void;
    const request = vi.fn(
      () =>
        new Promise<Record<string, number | boolean>>((resolve) => {
          finish = resolve;
        })
    );
    const service = createSystemConfigurationService(request as never, [
      {
        key: 'example/window',
        field: 'window',
        payloadField: 'days',
        initialValue: 180,
        nameKey: 'host.name',
        descriptionKey: 'host.description',
        type: 'number',
        min: 1,
        max: 3650
      }
    ]);
    expect(service.settings.map(({ key }) => key)).toEqual([
      'example/window',
      'mar-agent-resource-input',
      'mail-smtp',
      'web-push',
      'html-preview-origin',
      'skill-tls'
    ]);
    service.beginEdit('example/window');
    service.setDraft('example/window', 30);
    const saving = service.save('example/window');
    expect(await service.save('example/window')).toBe(false);
    service.cancelEdit('example/window');
    service.beginEdit('skill-tls');
    expect(service.editingKey.value).toBe('example/window');
    expect(request).toHaveBeenCalledWith('/api/system-settings/example%2Fwindow', {
      method: 'PATCH',
      body: JSON.stringify({ days: 30 })
    });
    finish({ window: 30, skillTlsVerificationDisabled: false });
    await saving;
    expect(service.snapshot.value.window).toBe(30);
  });

  it('rejects invalid drafts and unknown or duplicate catalog entries', async () => {
    const request = vi.fn();
    const service = createSystemConfigurationService(request as never);
    service.beginEdit('unknown');
    expect(await service.save('unknown')).toBe(false);
    service.beginEdit('skill-tls');
    service.setDraft('skill-tls', 'true');
    expect(service.drafts.value.skillTlsVerificationDisabled).toBe(false);
    expect(() =>
      createSystemConfigurationService(request as never, [service.settings[0]!])
    ).toThrow('WEB_SYSTEM_SETTING_DUPLICATE');
    expect(request).not.toHaveBeenCalled();
  });
});
