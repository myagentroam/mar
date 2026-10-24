import { createMobileLayerHistoryService } from './MobileLayerHistoryService.js';

export function createMobileMenuHistoryService(options: {
  readonly isOpen: () => boolean;
  readonly close: () => void;
  readonly syncRoute: () => void;
}) {
  return createMobileLayerHistoryService({
    isOpen: options.isOpen,
    close: () => {
      options.close();
      options.syncRoute();
    }
  });
}
