import { withSessionReadPin } from '../../src/session/store/jsonl/read-pins.js';

process.send?.('starting');
try {
  await withSessionReadPin(process.argv[2]!, async () => undefined);
  process.send?.('unexpected success');
} catch (error) {
  process.send?.((error as { code?: string }).code ?? 'unknown');
}
process.disconnect?.();
