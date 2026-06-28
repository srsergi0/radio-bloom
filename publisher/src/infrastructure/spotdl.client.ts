import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface SpotdlDownloadResult {
  filename: string | null;
  error: string | null;
}

export class SpotdlClient {
  constructor(private readonly songsDir: string) {}

  public async download(
    url: string,
    onLog?: (line: string) => void
  ): Promise<SpotdlDownloadResult> {
    console.log(`[SpotdlClient] Preparing snapshot of directory before download...`);
    const filesBefore = new Set(readdirSync(this.songsDir));

    const cmdArgs = ["download", url, "--output", this.songsDir];
    console.log(`[SpotdlClient] Spawning: spotdl ${cmdArgs.join(" ")}`);
    const proc = Bun.spawn(["spotdl", ...cmdArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    const stdoutPromise = (async () => {
      const reader = proc.stdout?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value).trim();
          if (onLog && text) {
            onLog(text);
          }
        }
      }
    })();

    const stderrPromise = (async () => {
      const reader = proc.stderr?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stderr += decoder.decode(value);
        }
      }
    })();

    const [exitCode] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
    console.log(`[SpotdlClient] Process spotdl exited with code: ${exitCode}`);

    if (exitCode !== 0) {
      return {
        filename: null,
        error: stderr.trim() || `Process exited with code ${exitCode}`,
      };
    }

    // Identify the new file by diffing snapshots
    const filesAfter = readdirSync(this.songsDir);
    const newFile = filesAfter.find(
      (f) => !filesBefore.has(f) && /\.(mp3|wav|ogg|flac|m4a)$/i.test(f)
    );

    if (!newFile) {
      return {
        filename: null,
        error: "Download completed but no new audio file was found in directory.",
      };
    }

    return {
      filename: newFile,
      error: null,
    };
  }
}
