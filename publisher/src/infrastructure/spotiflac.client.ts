import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { FfprobeClient } from "./ffprobe.client";

export interface SpotiflacDownloadResult {
  filename: string | null;
  error: string | null;
}

function getAllFiles(dir: string, fileList: string[] = []): string[] {
  try {
    if (!existsSync(dir)) return fileList;
    const files = readdirSync(dir);
    for (const file of files) {
      const name = join(dir, file);
      if (statSync(name).isDirectory()) {
        getAllFiles(name, fileList);
      } else {
        fileList.push(name);
      }
    }
  } catch (e) {
    // Ignore error
  }
  return fileList;
}

export class SpotiflacClient {
  private readonly ffprobe = new FfprobeClient();

  constructor(private readonly songsDir: string) {}

  public async download(
    url: string,
    onLog?: (line: string) => void
  ): Promise<SpotiflacDownloadResult> {
    console.log(`[SpotiflacClient] Starting download...`);

    // Create unique temporary directory for parallel isolation
    const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempDir = join(this.songsDir, `../tmp_download_${uniqueId}`);

    try {
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }

      // Priorities: tidal, deezer, soundcloud, youtube
      const cmdArgs = [url, tempDir, "--service", "tidal", "deezer", "soundcloud", "youtube"];
      console.log(`[SpotiflacClient] Spawning: spotiflac ${cmdArgs.join(" ")}`);
      const proc = Bun.spawn(["spotiflac", ...cmdArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
        },
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
      console.log(`[SpotiflacClient] Process spotiflac exited with code: ${exitCode}`);

      if (exitCode !== 0) {
        return {
          filename: null,
          error: stderr.trim() || `Process exited with code ${exitCode}`,
        };
      }

      // Cleanup and ingest files from unique tempDir to songsDir
      const ingestedFiles = this.cleanupAndIngest(tempDir, this.songsDir);
      if (ingestedFiles.length === 0) {
        return {
          filename: null,
          error: "Download completed but no valid music files were found.",
        };
      }

      // Return the first successfully ingested file relative to songsDir
      return {
        filename: ingestedFiles[0],
        error: null,
      };
    } catch (err: any) {
      console.error(`[SpotiflacClient] Error during download execution:`, err.message);
      return {
        filename: null,
        error: err.message,
      };
    } finally {
      // Clean up unique tempDir
      try {
        if (existsSync(tempDir)) {
          console.log(`[SpotiflacClient] Cleaning up temporary folder: ${tempDir}`);
          rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (cleanupErr: any) {
        console.error(
          `[SpotiflacClient] Failed to clean up temporary folder ${tempDir}:`,
          cleanupErr.message
        );
      }
    }
  }

  private cleanupAndIngest(srcDir: string, destDir: string): string[] {
    console.log(`[SpotiflacClient] Running validation and cleanup on temporary files...`);
    const allTempFiles = getAllFiles(srcDir);

    // 1. Validate integrity using ffprobe
    const validFiles: string[] = [];
    for (const file of allTempFiles) {
      const meta = this.ffprobe.extractMetadata(file);
      if (meta.duration > 0) {
        validFiles.push(file);
      } else {
        console.log(`[SpotiflacClient] [Cleanup] Deleting invalid/corrupted file: ${file}`);
        try {
          unlinkSync(file);
        } catch {}
      }
    }

    // 2. Deduplicate files (group by basename)
    const groups = new Map<string, string[]>();
    for (const file of validFiles) {
      const ext = extname(file);
      const base = basename(file, ext);
      if (!groups.has(base)) {
        groups.set(base, []);
      }
      groups.get(base)!.push(file);
    }

    const extPriority = [".flac", ".m4a", ".mp3", ".ogg", ".wav"];
    const filesToIngest: string[] = [];

    for (const [_, filesInGroup] of groups.entries()) {
      if (filesInGroup.length > 1) {
        filesInGroup.sort((a, b) => {
          const extA = extname(a).toLowerCase();
          const extB = extname(b).toLowerCase();
          let idxA = extPriority.indexOf(extA);
          let idxB = extPriority.indexOf(extB);
          if (idxA === -1) idxA = 99;
          if (idxB === -1) idxB = 99;
          return idxA - idxB;
        });

        // Keep the best format, delete the duplicates
        const bestFile = filesInGroup[0];
        filesToIngest.push(bestFile);

        for (let i = 1; i < filesInGroup.length; i++) {
          const toDelete = filesInGroup[i];
          console.log(
            `[SpotiflacClient] [Cleanup] Deleting lower-priority duplicate: ${toDelete} (keeping ${bestFile})`
          );
          try {
            unlinkSync(toDelete);
          } catch {}
        }
      } else if (filesInGroup.length === 1) {
        filesToIngest.push(filesInGroup[0]);
      }
    }

    // Ensure songsDir exists
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    // 3. Move files flatly to destDir
    const ingestedList: string[] = [];
    for (const file of filesToIngest) {
      const nameOnly = basename(file);
      const destPath = join(destDir, nameOnly);
      console.log(`[SpotiflacClient] Ingesting validated file: ${nameOnly}`);
      try {
        renameSync(file, destPath);
        ingestedList.push(nameOnly);
      } catch (err: any) {
        console.error(
          `[SpotiflacClient] Failed to ingest file ${nameOnly} to destination:`,
          err.message
        );
      }
    }

    return ingestedList;
  }
}
