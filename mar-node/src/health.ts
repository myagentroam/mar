export function getNodeHealth(): { status: 'ok'; platform: NodeJS.Platform } {
  return { status: 'ok', platform: process.platform };
}
