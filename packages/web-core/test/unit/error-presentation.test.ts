import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../src/util/api-error.js';
import {
  errorMessage,
  errorSummary,
  filePreviewErrorMessage,
  filePreviewErrorSummary
} from '../../src/util/error-presentation.js';
import { localePreferenceService } from '../../src/service/locale-preference-service.js';

afterEach(() => localePreferenceService().setLocale('en-US'));

it.each(['en-US', 'zh-CN'] as const)(
  'uses code-mapped human summaries without diagnostics in file content (%s)',
  (locale) => {
    localePreferenceService().setLocale(locale);
    for (const code of [
      'FILE_NOT_FOUND',
      'PERMISSION_DENIED',
      'CAPABILITY_UNAVAILABLE',
      'HOSTED_CONVERSATION_FILE_NOT_FOUND'
    ]) {
      const error = new ApiError(
        code,
        'Untrusted upstream summary',
        {},
        'diagnostic details',
        'request-id',
        'upstream-id'
      );
      const summary = filePreviewErrorSummary(error, 'src/missing.ts');
      for (const diagnostic of [
        code,
        error.message,
        error.details!,
        error.requestId!,
        error.upstreamRequestId!
      ])
        expect(summary).not.toContain(diagnostic);
      expect(summary).not.toContain('errors.');
      expect(summary.length).toBeGreaterThan(0);
      if (code === 'FILE_NOT_FOUND')
        expect(summary).toBe(locale === 'zh-CN' ? '文件不存在。' : 'File not found.');
      expect(errorMessage(error)).toContain(code);
    }
    expect(filePreviewErrorSummary(new Error('INTERNAL_FAILURE'), 'src/unknown.ts')).toBe(
      locale === 'zh-CN' ? '无法读取此文件，请重试。' : 'Unable to load the file.'
    );
    expect(
      filePreviewErrorSummary(new ApiError('FILE_NOT_FOUND', 'raw'), '.mar/temp-files/image.png')
    ).toBe(locale === 'zh-CN' ? '文件已过期' : 'File has expired');
  }
);

describe('Public Error Presentation', () => {
  it.each(['en-US', 'zh-CN'] as const)(
    'uses known capability reasons without exposing codes and retains unmapped fallbacks (%s)',
    (locale) => {
      localePreferenceService().setLocale(locale);
      expect(errorSummary(new ApiError('PERMISSION_DENIED', 'Unsupported'))).toBe(
        locale === 'zh-CN'
          ? '没有访问此资源的权限。'
          : 'You do not have permission to access this resource.'
      );
      expect(errorSummary(new ApiError('UNKNOWN_CAPABILITY_REASON', ''), 'Unsupported')).toBe(
        'Unsupported'
      );
      expect(errorSummary(new ApiError('UNMAPPED_CODE', 'Readable upstream reason.'))).toBe(
        'Readable upstream reason.'
      );
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'localizes a missing workspace file while retaining its diagnostics (%s)',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const message = filePreviewErrorMessage(
        new ApiError('FILE_NOT_FOUND', 'Upstream summary.', {}, 'missing document', 'req', 'node'),
        'pages/missing.html'
      );
      expect(message).toContain(locale === 'zh-CN' ? '文件不存在。' : 'File not found.');
      expect(message).not.toContain('Upstream summary.');
      for (const fact of ['FILE_NOT_FOUND', 'missing document', 'req', 'node'])
        expect(message).toContain(fact);
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'localizes share admission failures without losing diagnostics (%s)',
    (locale) => {
      localePreferenceService().setLocale(locale);
      for (const code of [
        'SESSION_SHARE_CREDENTIAL_INVALID',
        'SESSION_SHARE_RATE_LIMITED',
        'SESSION_SHARE_NOT_FOUND',
        'SESSION_SHARE_EXPIRED',
        'SESSION_SHARE_ACCESS_INVALID'
      ]) {
        const message = errorMessage(
          new ApiError(code, 'Upstream share error.', {}, 'admission detail', 'share-request')
        );
        expect(message).not.toContain('Upstream share error.');
        expect(message).not.toContain('errors.');
        for (const fact of [code, 'admission detail', 'share-request'])
          expect(message).toContain(fact);
      }
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'labels only missing temporary attachments as expired and retains diagnostics (%s)',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const error = new ApiError(
        'FILE_NOT_FOUND',
        'File not found.',
        {},
        'missing source',
        'req-1',
        'node-1'
      );
      const message = filePreviewErrorMessage(
        error,
        'mar-attachment://00000000-0000-4000-8000-000000000001/photo.png'
      );
      expect(filePreviewErrorMessage(error, '.mar/temp-files/session/photo.png')).toBe(message);
      expect(message).toContain(locale === 'zh-CN' ? '文件已过期' : 'File has expired');
      for (const fact of ['FILE_NOT_FOUND', 'missing source', 'req-1', 'node-1'])
        expect(message).toContain(fact);
      expect(filePreviewErrorMessage(error, 'src/missing.ts')).toBe(errorMessage(error));
      expect(filePreviewErrorMessage(error, '.mar/temp-files-other/photo.png')).toBe(
        errorMessage(error)
      );
      const denied = new ApiError('FORBIDDEN', 'Access denied.');
      expect(filePreviewErrorMessage(denied, '.mar/temp-files/session/photo.png')).toBe(
        errorMessage(denied)
      );
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'Localizes a known summary while preserving diagnostic facts (%s)',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const message = errorMessage(
        new ApiError(
          'NODE_OFFLINE',
          'upstream summary',
          {},
          'operation detail',
          'server-request',
          'node-request'
        )
      );
      expect(message).not.toContain('upstream summary');
      for (const fact of ['NODE_OFFLINE', 'operation detail', 'server-request', 'node-request']) {
        expect(message).toContain(fact);
      }
      expect(message).not.toContain('errors.');
    }
  );

  it('Shows upstream summaries unchanged for unknown and enterprise codes, while allowing explicit summary overrides', () => {
    for (const code of ['UPSTREAM_NEW_CODE', 'ENTERPRISE_LICENSE_REQUIRED']) {
      const error = new ApiError(code, 'Readable upstream summary');
      expect(errorMessage(error)).toBe(`Readable upstream summary\nCode: ${code}`);
      expect(errorMessage(error, 'Custom summary')).toBe(`Custom summary\nCode: ${code}`);
    }
  });

  it.each(['en-US', 'zh-CN'] as const)(
    'shows the Git reason and both request IDs for Diff failures (%s)',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const message = errorMessage(
        new ApiError(
          'GIT_COMMAND_FAILED',
          'Git command failed.',
          { gitExitCode: 128 },
          "fatal: bad revision 'HEAD'",
          'server-request',
          'node-request'
        )
      );
      expect(message).toBe(
        locale === 'en-US'
          ? "Git command failed.\nCode: GIT_COMMAND_FAILED\nDetails: fatal: bad revision 'HEAD'\nRequest ID: server-request\nNode request ID: node-request"
          : "Git command failed.\n错误码：GIT_COMMAND_FAILED\n详情：fatal: bad revision 'HEAD'\n请求 ID：server-request\nNode 请求 ID：node-request"
      );
      expect(message).not.toContain(' · ');
    }
  );

  it('Keeps the original text for a standard Error and uses the public fallback without an error object', () => {
    expect(errorMessage(new Error('Original message'))).toBe('Original message');
    expect(errorMessage(undefined)).toBe('Unknown error');
    localePreferenceService().setLocale('zh-CN');
    expect(errorMessage(undefined)).not.toBe('common.unknownError');
  });
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  it(`Localizes distinct Watch timeout phases (${locale})`, () => {
    localePreferenceService().setLocale(locale);
    const messages = ['WATCH_REQUEST_TIMEOUT', 'SESSION_WATCH_SNAPSHOT_TIMEOUT'].map((code) => {
      const message = errorMessage(new ApiError(code, 'untranslated fallback'));
      expect(message).toContain(code);
      expect(message).not.toContain('untranslated fallback');
      expect(message).not.toContain('errors.');
      return message.split('\n')[0];
    });
    expect(messages[0]).not.toBe(messages[1]);
  });
}
