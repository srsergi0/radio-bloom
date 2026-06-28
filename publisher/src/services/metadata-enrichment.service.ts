import { SpotifyFreeClient } from "../infrastructure/spotify-free.client";

export interface EnrichmentResult {
  title: string;
  artist: string;
  album: string | null;
  duration: number;
  spotifyUrl: string | null;
  albumArt: string | null;
}

export class MetadataEnrichmentService {
  private readonly spotifyFree: SpotifyFreeClient;

  constructor() {
    this.spotifyFree = new SpotifyFreeClient();
  }

  async enrich(title: string, artist?: string): Promise<EnrichmentResult | null> {
    if (!title) return null;

    const spotify = await this.spotifyFree.search(title + " " + (artist || ""));
    if (!spotify) return null;

    return {
      title: spotify.title,
      artist: spotify.artist,
      album: spotify.album || null,
      duration: spotify.duration,
      spotifyUrl: spotify.spotifyUrl,
      albumArt: spotify.albumArt || null,
    };
  }
}
