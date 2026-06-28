import { spawnSync } from "node:child_process";

export interface AudioMetadata {
  duration: number;
  artist: string;
  album: string;
  title: string;
  spotifyUrl: string;
}

export class FfprobeClient {
  public extractMetadata(filePath: string): AudioMetadata {
    const result: AudioMetadata = { duration: 0, artist: "", album: "", title: "", spotifyUrl: "" };
    try {
      const meta = spawnSync(
        "ffprobe",
        [
          "-v",
          "quiet",
          "-show_entries",
          "format=duration:format_tags=artist,album,title,woas,WOAS",
          "-of",
          "default=noprint_wrappers=1",
          filePath,
        ],
        { timeout: 8000 }
      );

      if (meta.status === 0) {
        for (const line of meta.stdout.toString().trim().split("\n")) {
          const eq = line.indexOf("=");
          if (eq === -1) continue;
          let key = line.substring(0, eq).trim();
          const val = line.substring(eq + 1).trim();

          if (key.startsWith("TAG:")) key = key.substring(4);

          const keyLower = key.toLowerCase();
          if (keyLower === "duration") result.duration = parseFloat(val) || 0;
          else if (keyLower === "artist") result.artist = val;
          else if (keyLower === "album") result.album = val;
          else if (keyLower === "title") result.title = val;
          else if (keyLower === "woas") result.spotifyUrl = val;
        }
      }
    } catch (err: any) {
      console.error(`[FfprobeClient] Error running ffprobe on ${filePath}:`, err.message);
    }
    return result;
  }
}
