import { X11TopologySource } from '../../src/remote-desktop/x11-topology-source.js';
import { X11Topology } from '../../src/remote-desktop/x11-topology.js';

const [binaryPath, display, xAuthority] = process.argv.slice(2);
if (!binaryPath || !display || !xAuthority)
  throw new Error('Missing native topology test arguments.');
const topology = new X11Topology('native-test-session');
const source = await X11TopologySource.start(
  {
    binaryPath,
    display,
    xAuthority,
    onInvalidated: (event) => {
      topology.invalidate(event);
      console.log(JSON.stringify({ type: 'invalidated', ...event }));
    },
    onSnapshot: (snapshot) =>
      console.log(JSON.stringify({ ...snapshot, layout: topology.accept(snapshot) })),
    onUnavailable: () => {
      topology.unavailable();
      console.error('Native topology source unavailable.');
      process.exitCode = 1;
    }
  },
  AbortSignal.timeout(8_000)
);
process.stdin.resume();
process.stdin.once('end', () => {
  void source.stop().catch(() => {
    process.exitCode = 1;
  });
});
