import type { Page } from '@playwright/test';

export function silentWave(dataBytes = 21 * 1024 * 1024): Buffer {
  const audio = Buffer.alloc(44 + dataBytes);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(44100, 24);
  audio.writeUInt32LE(88200, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

export async function recordWebm(page: Page): Promise<Buffer> {
  const video = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d')!;
    const stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    const complete = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(parts));
      recorder.onerror = () => reject(new Error('MEDIA_FIXTURE_RECORDING_FAILED'));
    });
    const interval = setInterval(() => {
      context.fillStyle = '#336699';
      context.fillRect(0, 0, 64, 64);
    }, 40);
    try {
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 600));
      recorder.stop();
      const blob = await complete;
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    } finally {
      clearInterval(interval);
      for (const track of stream.getTracks()) track.stop();
    }
  });
  return Buffer.from(video);
}
