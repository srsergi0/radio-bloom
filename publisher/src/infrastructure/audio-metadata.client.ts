import { parseFile } from "music-metadata";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { extname } from "node:path";

const execFileAsync = promisify(execFile);

export interface AudioMetadata {
  duration: number;
  artist: string;
  album: string;
  title: string;
  spotifyUrl: string;
}

export interface WriteMetadataOptions {
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  track?: number;
  disc?: number;
}

const EXT_TO_FORMAT: Record<string, string> = {
  ".flac": "flac",
  ".mp3": "mp3",
  ".m4a": "ipod",
  ".ogg": "ogg",
  ".opus": "opus",
  ".wav": "wav",
};

export class AudioMetadataClient {
  public async extractMetadata(filePath: string): Promise<AudioMetadata> {
    const result: AudioMetadata = { duration: 0, artist: "", album: "", title: "", spotifyUrl: "" };
    try {
      const meta = await parseFile(filePath);
      result.duration = meta.format.duration ?? 0;
      result.artist = meta.common.artist ?? "";
      result.album = meta.common.album ?? "";
      result.title = meta.common.title ?? "";
      result.spotifyUrl = this.findSpotifyUrl(meta);
    } catch (err: any) {
      console.error(`[AudioMetadataClient] Error reading metadata from ${filePath}:`, err.message);
    }
    return result;
  }

  public async writeMetadata(filePath: string, options: WriteMetadataOptions): Promise<boolean> {
    if (!existsSync(filePath)) {
      console.error(`[AudioMetadataClient] File not found: ${filePath}`);
      return false;
    }

    const ext = extname(filePath).toLowerCase();
    const format = EXT_TO_FORMAT[ext];
    if (!format) {
      console.error(`[AudioMetadataClient] Unsupported format: ${ext}`);
      return false;
    }

    try {
      const metaArgs: string[] = [];
      if (options.title) metaArgs.push("-metadata", `title=${options.title}`);
      if (options.artist) metaArgs.push("-metadata", `artist=${options.artist}`);
      if (options.album) metaArgs.push("-metadata", `album=${options.album}`);
      if (options.year) metaArgs.push("-metadata", `date=${options.year}`);
      if (options.genre) metaArgs.push("-metadata", `genre=${options.genre}`);
      if (options.track) metaArgs.push("-metadata", `track=${options.track}`);
      if (options.disc) metaArgs.push("-metadata", `disc=${options.disc}`);

      const tmpFile = `${filePath}.tmp`;

      const args = [
        "-y",
        "-i", filePath,
        ...metaArgs,
        "-codec", "copy",
        "-f", format,
        tmpFile,
      ];

      console.log(`[AudioMetadataClient] Running: ffmpeg ${args.join(" ")}`);

      await execFileAsync("ffmpeg", args, { timeout: 30000 });

      const { renameSync } = await import("node:fs");
      renameSync(tmpFile, filePath);

      console.log(`[AudioMetadataClient] ✅ Metadata written to ${filePath}`);
      return true;
    } catch (err: any) {
      console.error(`[AudioMetadataClient] Error writing metadata to ${filePath}:`, err.message);
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(`${filePath}.tmp`);
      } catch {}
      return false;
    }
  }

  private findSpotifyUrl(meta: any): string {
    for (const [, tags] of Object.entries(meta.native)) {
      for (const tag of tags as any[]) {
        const key = tag.id?.toLowerCase();
        if (key === "woas") return String(tag.value ?? "");
      }
    }
    return "";
  }
}
