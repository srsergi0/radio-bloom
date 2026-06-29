const DOWNLOADER_URL = process.env.DOWNLOADER_URL || "http://radio-downloader:4002";

export interface SpotiflacDownloadResult {
  filename: string | null;
  error: string | null;
}

export class SpotiflacClient {
  constructor(readonly _songsDir: string) {}

  public async download(
    url: string,
    onLog?: (line: string) => Promise<void> | void
  ): Promise<SpotiflacDownloadResult> {
    console.log(`[SpotiflacClient] Requesting download from downloader service...`);
    if (onLog) await onLog(`Sending download request to ${DOWNLOADER_URL}`);

    try {
      const res = await fetch(`${DOWNLOADER_URL}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(300_000), // 5 min timeout
      });

      if (!res.ok) {
        return {
          filename: null,
          error: `Downloader returned status ${res.status}`,
        };
      }

      const reader = res.body?.getReader();
      if (!reader) {
        return {
          filename: null,
          error: "Response body is not readable",
        };
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let filename: string | null = null;
      let error: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.type === "log" && onLog) {
              await onLog(data.message);
            } else if (data.type === "complete") {
              filename = data.filename;
            } else if (data.type === "error") {
              error = data.message;
            }
          } catch (_e) {
            // Ignore parse errors
          }
        }
      }

      if (error) {
        return { filename: null, error };
      }

      if (!filename) {
        return { filename: null, error: "Download finished but no filename was received" };
      }

      if (onLog) await onLog(`Download complete: ${filename}`);
      return { filename, error: null };
    } catch (err: any) {
      console.error(`[SpotiflacClient] Error calling downloader:`, err.message);
      return { filename: null, error: err.message };
    }
  }
}
