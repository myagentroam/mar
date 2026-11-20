import { marIcon } from '../util/mar-icons.js';
import { MarMessageBox } from './message-box-service.js';
import { translate } from './locale-preference-service.js';

export async function confirmDiscardFileDraft(): Promise<boolean> {
  try {
    await MarMessageBox.confirm(
      translate('fileEditor.unsavedMessage'),
      translate('fileEditor.unsavedTitle'),
      { icon: marIcon('warning'), type: 'warning' }
    );
    return true;
  } catch {
    return false;
  }
}
