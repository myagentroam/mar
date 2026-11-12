import { createInterface } from 'node:readline';
import { X11DesktopTopology } from '../../src/remote-desktop/x11-desktop-topology.js';

const [binaryPath, display, xAuthority] = process.argv.slice(2);
if (!binaryPath || !display || !xAuthority) throw new Error('Missing native test arguments.');
let topology: X11DesktopTopology;
topology = await X11DesktopTopology.start(
  {
    generation: 'native-session',
    binaryPath,
    display,
    xAuthority,
    fence: () => console.log(JSON.stringify({ type: 'fenced' }))
  },
  AbortSignal.timeout(8_000)
);
const first = topology.describe();
console.log(JSON.stringify({ type: 'ready', layout: first }));
for await (const command of createInterface({ input: process.stdin })) {
  if (command !== 'describe') continue;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const current = topology.describe();
      if (current.topologyRevision > first.topologyRevision) {
        console.log(
          JSON.stringify({
            type: 'layout',
            layout: current,
            oldGrantMatches: topology.matches(
              first.desktopGeneration,
              first.topologyRevision,
              800,
              600
            )
          })
        );
        break;
      }
    } catch {
      /* the native source is between invalidation and rediscovery */
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
await topology.stop();
