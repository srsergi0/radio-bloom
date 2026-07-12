import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AudioMetadata {
  duration: number;
  artist: string;
  album: string;
  title: string;
  spotifyUrl: string;
}

export class AudioMetadataClient {
  public async extractMetadata(filePath: string): Promise<AudioMetadata> {
    const result: AudioMetadata = { duration: 0, artist: "", album: "", title: "", spotifyUrl: "" };
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "json",
        filePath,
      ], { timeout: 10_000 });
      const parsed = JSON.parse(stdout);
      result.duration = Number(parsed?.format?.duration) || 0;
    } catch {
      // ffprobe not available or file unreadable — leave duration as 0
    }
    return result;
  }
}
