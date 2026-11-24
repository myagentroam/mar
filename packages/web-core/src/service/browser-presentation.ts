import { translate } from './locale-preference-service.js';
import type { BrowserProfileTarget } from '@myagentroam/protocol';

export function browserProfileLabel(target: BrowserProfileTarget): string {
  return translate(
    target.kind === 'stored'
      ? 'browser.stored'
      : target.persistent
        ? 'browser.persistent'
        : 'browser.temporary'
  );
}

export function browserError(code: string): string {
  switch (code) {
    case 'BROWSER_NOT_AUTHORIZED':
      return translate('browser.denied');
    case 'BROWSER_OUTCOME_UNKNOWN':
      return translate('browser.unknown');
    case 'BROWSER_VNC_UNAVAILABLE':
      return translate('browser.unsupported');
    case 'BROWSER_NAVIGATION_FAILED':
    case 'BROWSER_TAB_NAVIGATION_FAILED':
      return translate('browser.navigation');
    case 'BROWSER_HTML_UNAVAILABLE':
      return translate('browser.htmlUnavailable');
    case 'BROWSER_UPLOAD_FAILED':
    case 'BROWSER_UPLOAD_INVALID':
    case 'BROWSER_FILE_CHOOSER_ENDED':
      return translate('browser.uploadFailed');
    case 'BROWSER_DOWNLOAD_INVALID':
    case 'BROWSER_DOWNLOAD_NOT_READY':
    case 'BROWSER_DOWNLOAD_ENDED':
    case 'BROWSER_DOWNLOAD_FAILED':
      return translate('browser.downloadFailed');
    case 'BROWSER_CONTROL_DISCONNECTED':
    case 'BROWSER_DISCONNECTED':
    case 'BROWSER_LEASE_ENDED':
    case 'BROWSER_LEASE_EXPIRED':
      return translate('browser.disconnected');
    case 'BROWSER_NO_FRAME':
      return translate('browser.noFrame');
    case 'BROWSER_SESSION_ENDED':
      return translate('browser.ended');
    case 'BROWSER_RESTORE_NOT_BLANK':
      return translate('browser.restoreNotBlank');
    case 'BROWSER_TAB_RESTORE_INCOMPLETE':
      return translate('browser.restoreIncomplete');
    case 'BROWSER_PROFILE_CHANGED':
      return translate('browser.profileChanged');
    case 'BROWSER_ATTACHMENT_BUSY':
    case 'BROWSER_OCCUPIED':
      return translate('browser.occupied');
    default:
      return translate('browser.failed');
  }
}
