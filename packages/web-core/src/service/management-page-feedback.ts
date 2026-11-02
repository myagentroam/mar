import { watch, type Ref } from 'vue';
import { errorMessage } from '../util/error-presentation.js';
import { showMessage } from './message-feedback-service.js';

/** Ordinary reads use message feedback; mobile incremental failures retry at the boundary. */
export function watchManagementPageFailure(page: {
  readonly failure: Readonly<
    Ref<{ readonly error: unknown; readonly incremental: boolean } | undefined>
  >;
  readonly mobileViewport: Readonly<Ref<boolean>>;
}): void {
  watch(
    page.failure,
    (failure) => {
      if (failure && !(page.mobileViewport.value && failure.incremental))
        showMessage(errorMessage(failure.error), 'error', failure.error);
    },
    { flush: 'sync' }
  );
}
