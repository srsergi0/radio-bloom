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
    let results = await spotifySearch(queryBasic);

    // If no result, try with album
    if (results.length === 0 && album) {
      const queryWithAlbum = `${title} ${artist || ""} ${album}`;
      results = await spotifySearch(queryWithAlbum);
    }

    if (results.length === 0) return null;

    const track = results[0];
    return {
      title: track.title,
      artist: track.artist,
      album: track.album || null,
      duration: track.duration,
      spotifyUrl: track.spotifyUrl,
      albumArt: track.albumArt || null,
    };
  }
}
