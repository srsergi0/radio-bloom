/**
 * Queue songs and interludios via the API.
 * Usage:
 *   bun run src/scripts/put-song-in-queue.ts "bad bunny"
 *   bun run src/scripts/put-song-in-queue.ts --interludio "Bienvenidos a Radio Bloom"
 */

const API_BASE = "http://localhost:3000";

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--interludio") {
    const script = args.slice(1).join(" ");
    if (!script) {
      console.error('Usage: bun run src/scripts/put-song-in-queue.ts --interludio "text to speak"');
      process.exit(1);
    }

    console.log(`Queuing TTS interludio: "${script.slice(0, 50)}..."`);
    const res = await fetch(`${API_BASE}/api/stream/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ script }]),
    });
    const data = (await res.json()) as any;
    if (!data.ok) {
      console.error("Failed:", data.error);
      process.exit(1);
    }
    console.log(`Queued! Job: ${data.data[0].jobId}`);
    return;
  }

  const query = args.join(" ");
  if (!query) {
    console.error('Usage: bun run src/scripts/put-song-in-queue.ts "song name"');
    process.exit(1);
  }

  console.log(`Searching: "${query}"...`);
  const searchRes = await fetch(
    `${API_BASE}/api/library/search?q=${encodeURIComponent(query)}&limit=5`
  );
  const searchData = (await searchRes.json()) as any;

  if (!searchData.ok || !searchData.data?.items?.length) {
    console.error("No results found.");
    process.exit(1);
  }

  const track = searchData.data.items[0];
  console.log(`Found: "${track.title}" by ${track.artist} [${track.id}]`);
  console.log("Adding to queue...");

  const queueRes = await fetch(`${API_BASE}/api/stream/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ id: track.id }]),
  });
  const queueData = (await queueRes.json()) as any;

  if (!queueData.ok) {
    console.error("Failed to queue:", queueData.error);
    process.exit(1);
  }

  console.log(`Queued! Job: ${queueData.data[0].jobId}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

export {};
