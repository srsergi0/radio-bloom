const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArt: string;
  duration: number;
  spotifyUrl: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`Spotify token request failed: ${res.status}`);
  }

  const data: TokenResponse = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
  return cachedToken;
}

export async function spotifySearch(query: string): Promise<SpotifyTrack | null> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("[Spotify] Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET");
    return null;
  }

  try {
    const token = await getAccessToken();
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=track&limit=1`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[Spotify] Search failed: ${res.status}`);
      return null;
    }

    const data: any = await res.json();
    const track = data?.tracks?.items?.[0];
    if (!track) return null;

    const images = track.album?.images || [];
    const albumArt = images.length > 0 ? images[0].url : "";

    return {
      id: track.id,
      title: track.name,
      artist: track.artists?.[0]?.name || "",
      album: track.album?.name || "",
      albumArt,
      duration: Math.round((track.duration_ms || 0) / 1000),
      spotifyUrl: `https://open.spotify.com/track/${track.id}`,
    };
  } catch (err: any) {
    console.error(`[Spotify] Search error: ${err.message}`);
    return null;
  }
}
