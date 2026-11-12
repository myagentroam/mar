/** Standard pixel encodings and negotiated quality settings supported by the desktop gate. */
export function remoteDesktopEncodings(mode: 'VIEW' | 'CONTROL'): number[] {
  const encodings = [0, 7, 21, -223, -224, -239, -254, -29, -26, -23];
  if (mode === 'CONTROL') encodings.push(0xc0a1e5ce);
  return encodings;
}
