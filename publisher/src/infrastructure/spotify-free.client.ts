const ENRICHER_URL = process.env.ENRICHER_URL || "http://localhost:4001";

export interface SpotifyFreeTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArt: string;
  duration: number;
  spotifyUrl: string;
}

export class SpotifyFreeClient {
  async search(query: string): Promise<SpotifyFreeTrack | null> {
    try {
      const res = await fetch(`${ENRICHER_URL}/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data.spotifyUrl) return null;
      return data as SpotifyFreeTrack;
    } catch {
      return null;
    }
  }
}
