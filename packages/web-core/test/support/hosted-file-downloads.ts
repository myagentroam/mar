async function unexpected(): Promise<never> {
  throw new Error('Unexpected Hosted file download');
}

export const unusedHostedFileDownloads = {
  describe: unexpected,
  readRange: unexpected,
  download: unexpected,
  objectUrl: unexpected
};
