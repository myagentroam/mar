export interface CodexComposerImageMarker {
  readonly index: number;
  readonly localPath: string;
}

export function parseCodexComposerImageMarkers(text: string): {
  readonly text: string;
  readonly images: readonly CodexComposerImageMarker[];
} {
  const images: CodexComposerImageMarker[] = [];
  const visible = text.replace(
    /\n?<image\s+name=\[Image #(\d+)\]\s+path="([^"\n]*[\\/]myagentroam-attachment-[^"\n]*[\\/][^"\n]+)"\s*>\s*<\/image>/gu,
    (_marker, index: string, localPath: string) => {
      images.push({ index: Number(index), localPath });
      return '';
    }
  );
  return { text: visible.trimEnd(), images };
}
