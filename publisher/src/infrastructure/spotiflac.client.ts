const DOWNLOADER_URL = process.env.DOWNLOADER_URL || "http://radio-downloader:4002";

export interface SpotiflacDownloadResult {
  filename: string | null;
  error: string | null;
}

export class SpotiflacClient {
  constructor(private readonly songsDir: string) {}

  public async download(
    url: string,
    onLog?: (line: string) => void
  ): Promise<SpotiflacDownloadResult> {
    console.log(`[SpotiflacClient] Requesting download from downloader service...`);
    if (onLog) onLog(`Sending download request to ${DOWNLOADER_URL}`);

    try {
      const res = await fetch(`${DOWNLOADER_URL}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(300_000), // 5 min timeout
      });

      const data: any = await res.json();

      if (!res.ok || data.error) {
        return {
          filename: null,
          error: data.error || `Downloader returned status ${res.status}`,
        };
      }

      if (onLog) onLog(`Download complete: ${data.filename}`);
      return { filename: data.filename, error: null };
    } catch (err: any) {
      console.error(`[SpotiflacClient] Error calling downloader:`, err.message);
      return { filename: null, error: err.message };
    }
  }
}
