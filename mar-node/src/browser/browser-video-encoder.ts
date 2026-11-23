/// <reference lib="dom" />
import { BROWSER_VIDEO_CODEC } from '@myagentroam/protocol';
import type { Page } from 'playwright';

/** One AVC encoder per attached view stream. The caller supplies a blank page
 * in a trusted encoder context, never a user-controlled navigation target.
 * The stream grants one encode at a time. Its owner closes this encoder before
 * releasing the trusted page; only the stream's send path consumes an AbortSignal.
 */
export async function createBrowserVideoEncoder(
  page: Page,
  options: { width: number; height: number; bitrate: number; framerate: number }
) {
  const handle = await page.evaluateHandle(
    async (options) => {
      const config: VideoEncoderConfig = {
        ...options,
        latencyMode: 'realtime',
        avc: { format: 'annexb' }
      };
      if (!globalThis.VideoEncoder || !(await VideoEncoder.isConfigSupported(config)).supported) {
        throw new Error('BROWSER_H264_ENCODER_UNAVAILABLE');
      }
      type Encoded = { data: string; key: boolean };
      let pending: ReturnType<typeof Promise.withResolvers<Encoded>> | undefined;
      const canvas = new OffscreenCanvas(options.width, options.height);
      const context = canvas.getContext('2d')!;
      const encoder = new VideoEncoder({
        output(chunk) {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          let binary = '';
          for (let offset = 0; offset < data.length; offset += 8192) {
            binary += String.fromCharCode(...data.subarray(offset, offset + 8192));
          }
          pending?.resolve({ data: btoa(binary), key: chunk.type === 'key' });
        },
        error(error) {
          pending?.reject(error);
        }
      });
      encoder.configure(config);
      let lastTimestamp = -1;
      return {
        async encode({ jpeg, key, timestamp }: { jpeg: string; key: boolean; timestamp: number }) {
          const binary = atob(jpeg);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++)
            bytes[index] = binary.charCodeAt(index);
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
          try {
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          } finally {
            bitmap.close();
          }
          lastTimestamp = Math.max(lastTimestamp + 1, timestamp);
          const frame = new VideoFrame(canvas, { timestamp: lastTimestamp });
          const result = Promise.withResolvers<Encoded>();
          pending = result;
          try {
            try {
              encoder.encode(frame, { keyFrame: key });
            } finally {
              frame.close();
            }
            return await result.promise;
          } finally {
            pending = undefined;
          }
        },
        close() {
          if (encoder.state !== 'closed') encoder.close();
          pending?.reject(new Error('BROWSER_H264_ENCODER_CLOSED'));
        }
      };
    },
    { ...options, codec: BROWSER_VIDEO_CODEC }
  );

  let closing: Promise<void> | undefined;
  return {
    async encode(jpeg: Buffer, key: boolean) {
      const value = await handle.evaluate((encoder, input) => encoder.encode(input), {
        jpeg: jpeg.toString('base64'),
        key,
        timestamp: Math.round(performance.now() * 1000)
      });
      return { data: Buffer.from(value.data, 'base64'), key: value.key };
    },
    close() {
      return (closing ??= handle
        .evaluate((encoder) => encoder.close())
        .finally(() => handle.dispose()));
    }
  };
}
