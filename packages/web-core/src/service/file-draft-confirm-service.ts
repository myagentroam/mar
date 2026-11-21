import { marIcon } from '@myagentroam/mar-ui/icons';
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
