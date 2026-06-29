const DOWNLOADER_URL = process.env.DOWNLOADER_URL || "http://radio-downloader:4002";

export interface WriteMetadataOptions {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  track?: number;
  disc?: number;
}

export class DownloaderMetadataClient {
  public async writeMetadata(
    file: string,
    options: WriteMetadataOptions
  ): Promise<boolean> {
    try {
      const res = await fetch(`${DOWNLOADER_URL}/write-metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, ...options }),
        signal: AbortSignal.timeout(30_000),
      });

      const data = await res.json();

      if (!res.ok) {
        console.error(`[DownloaderMetadata] Error: ${data.error}`);
        return false;
      }

      console.log(`[DownloaderMetadata] ✅ Metadata written to ${file}`);
      return true;
    } catch (err: any) {
      console.error(`[DownloaderMetadata] Error calling downloader:`, err.message);
      return false;
    }
  }
}
