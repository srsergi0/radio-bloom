import type { Track } from "./types";

const ICECAST_HOST = process.env.ICECAST_HOST || "localhost";
const ICECAST_PORT = process.env.ICECAST_PORT || "8000";
const ADMIN_USER = process.env.ICECAST_ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ICECAST_ADMIN_PASSWORD || "hackme";
const MOUNT = process.env.MOUNT || "/radiobloom.mp3";

export async function updateMetadata(track: Track): Promise<void> {
  const artist = track.artist || "Radio Bloom";
  const title = track.title;
  const song = `${artist} - ${title}`;
  const songEncoded = encodeURIComponent(song);

  const url = `http://${ICECAST_HOST}:${ICECAST_PORT}/admin/metadata?mount=${MOUNT}&mode=updinfo&song=${songEncoded}&charset=UTF-8`;
  const auth = Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString("base64");

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    if (response.ok) {
      console.log(`[metadata] Updated: ${song}`);
    } else {
      console.error(`[metadata] Failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`[metadata] Error: ${err}`);
  }
}
