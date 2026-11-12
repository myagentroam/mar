import { readonly, shallowRef } from 'vue';
import type { RemoteDesktopChannel } from './remote-desktop-channel.js';

export interface RemoteDesktopStatistics {
  readonly path: 'direct' | 'relay';
  readonly controlRoundTripMs: number | undefined;
  readonly framesPerSecond: number | undefined;
  readonly receivedBytesPerSecond: number | undefined;
  readonly sentBytesPerSecond: number | undefined;
}

/** Samples one attachment's painted updates and RFB bytes; never drives its lifecycle. */
export function createRemoteDesktopStatistics(options: {
  readonly frames: EventTarget;
  readonly channel: Pick<RemoteDesktopChannel, 'getStatistics'>;
  readonly path: 'direct' | 'relay';
  readonly controlRoundTripMs: () => number | undefined;
}) {
  const value = shallowRef<RemoteDesktopStatistics>({
    path: options.path,
    controlRoundTripMs: undefined,
    framesPerSecond: undefined,
    receivedBytesPerSecond: undefined,
    sentBytesPerSecond: undefined
  });
  let frames = 0;
  let previous = options.channel.getStatistics();
  let sampledAt = performance.now();
  const painted = () => {
    frames++;
  };
  options.frames.addEventListener('frame', painted);
  const timer = setInterval(() => {
    const now = performance.now();
    const seconds = (now - sampledAt) / 1000;
    if (seconds <= 0) return;
    const bytes = options.channel.getStatistics();
    value.value = {
      path: options.path,
      controlRoundTripMs: options.controlRoundTripMs(),
      framesPerSecond: frames / seconds,
      receivedBytesPerSecond: (bytes.receivedBytes - previous.receivedBytes) / seconds,
      sentBytesPerSecond: (bytes.sentBytes - previous.sentBytes) / seconds
    };
    frames = 0;
    previous = bytes;
    sampledAt = now;
  }, 1000);
  return {
    value: readonly(value),
    close() {
      clearInterval(timer);
      options.frames.removeEventListener('frame', painted);
    }
  };
}
