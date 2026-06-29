import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env manually BEFORE any imports
const envPath = resolve(process.cwd(), "../.env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

// Dynamic imports AFTER loading .env
const { AudioMetadataClient } = await import("./src/infrastructure/audio-metadata.client");
const { MetadataEnrichmentService } = await import("./src/services/metadata-enrichment.service");

const audioClient = new AudioMetadataClient();
const enrichmentService = new MetadataEnrichmentService();

const filePath = process.argv[2];
if (!filePath) {
  console.log("Usage: bun run test-write-metadata.ts <audio-file> [title] [artist] [album]");
  console.log("Example: bun run test-write-metadata.ts music/songs/song.mp3");
  process.exit(1);
}

const title = process.argv[3];
const artist = process.argv[4];
const album = process.argv[5];

console.log(`Processing: ${filePath}\n`);

// 1. Read current metadata
console.log("1. Reading current metadata...");
const currentMeta = await audioClient.extractMetadata(filePath);
console.log(`   Title: ${currentMeta.title || "(empty)"}`);
console.log(`   Artist: ${currentMeta.artist || "(empty)"}`);
console.log(`   Album: ${currentMeta.album || "(empty)"}`);
console.log(`   Duration: ${currentMeta.duration}s`);

// 2. Get metadata from Spotify (use provided or search from current)
console.log("\n2. Searching Spotify...");
const searchTitle = title || currentMeta.title;
const searchArtist = artist || currentMeta.artist;
const searchAlbum = album || currentMeta.album;

if (!searchTitle) {
  console.log("   ❌ No title to search. Provide title as argument or ensure file has title metadata.");
  process.exit(1);
}

const spotifyResult = await enrichmentService.enrich(searchTitle, searchArtist, searchAlbum);
if (!spotifyResult) {
  console.log("   ❌ Not found on Spotify");
  process.exit(1);
}

console.log(`   ✅ Found: ${spotifyResult.title} — ${spotifyResult.artist} (${spotifyResult.album})`);

// 3. Download album art
let coverData: Buffer | undefined;
if (spotifyResult.albumArt) {
  console.log("\n3. Downloading album art...");
  try {
    const res = await fetch(spotifyResult.albumArt);
    if (res.ok) {
      coverData = Buffer.from(await res.arrayBuffer());
      console.log(`   ✅ Downloaded: ${coverData.length} bytes`);
    }
  } catch (err: any) {
    console.log(`   ⚠️ Failed to download cover: ${err.message}`);
  }
}

// 4. Write metadata to file
console.log("\n4. Writing metadata to file...");
const success = await audioClient.writeMetadata(filePath, {
  title: spotifyResult.title,
  artist: spotifyResult.artist,
  album: spotifyResult.album || undefined,
  year: undefined, // Spotify doesn't always have year
  picture: coverData ? [{
    format: "image/jpeg",
    data: coverData,
    type: "Cover (front)",
    description: "Album cover",
  }] : undefined,
});

if (success) {
  console.log("\n✅ Metadata injected successfully!");
  
  // Verify by reading again
  console.log("\n5. Verifying...");
  const newMeta = await audioClient.extractMetadata(filePath);
  console.log(`   Title: ${newMeta.title}`);
  console.log(`   Artist: ${newMeta.artist}`);
  console.log(`   Album: ${newMeta.album}`);
} else {
  console.log("\n❌ Failed to write metadata");
}
