import { parseFile } from "music-metadata";

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

  private findSpotifyUrl(meta: any): string {
    if (!meta.native) return "";
    for (const [, tags] of Object.entries(meta.native)) {
      for (const tag of tags as any[]) {
        const key = tag.id?.toLowerCase();
        if (key === "woas") return String(tag.value ?? "");
      }
    }
    return "";
  }
}
