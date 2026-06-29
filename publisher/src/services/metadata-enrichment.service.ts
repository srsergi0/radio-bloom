import { spotifySearch } from "../infrastructure/spotify.client";

export interface EnrichmentResult {
  title: string;
  artist: string;
  album: string | null;
  duration: number;
  spotifyUrl: string | null;
  albumArt: string | null;
}

export class MetadataEnrichmentService {
  async enrich(title: string, artist?: string, album?: string): Promise<EnrichmentResult | null> {
    if (!title) return null;

    // First search: title + artist only (more accurate)
    const queryBasic = artist ? `${title} ${artist}` : title;
    let spotify = await spotifySearch(queryBasic);
    
    // If no result, try with album
    if (!spotify && album) {
      const queryWithAlbum = `${title} ${artist || ""} ${album}`;
      spotify = await spotifySearch(queryWithAlbum);
    }
    
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
