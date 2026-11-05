import { marIcon } from '../util/mar-icons.js';
import { ElMessageBox } from './message-box-service.js';
import { translate } from './locale-preference-service.js';

export async function confirmDiscardFileDraft(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      translate('fileEditor.unsavedMessage'),
      translate('fileEditor.unsavedTitle'),
      { closeIcon: marIcon('close'), icon: marIcon('warning'), type: 'warning' }
    );
    return true;
  } catch {
    return false;
  }
}
