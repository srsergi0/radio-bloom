const API_BASE = "http://localhost:3000";

const [, , playlistId, ...rest] = process.argv;

if (!playlistId) {
  console.error("Uso: bun run src/scripts/play-playlist.ts <playlistId> [--shuffle]");
  process.exit(1);
}

const shuffle = rest.includes("--shuffle");

async function main() {
  console.log(`Reproduciendo playlist ${playlistId}${shuffle ? " (shuffle)" : ""}...`);

  const res = await fetch(`${API_BASE}/api/playlists/${playlistId}/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shuffle }),
  });

  const data = (await res.json()) as any;

  if (!data.ok) {
    console.error("Error:", data.error);
    process.exit(1);
  }

  const { queued, skipped, queueMethod, results } = data.data;
  for (const r of results) {
    console.log(`  ${r.status === "queued" ? "✓" : "✗"} ${r.title} (${r.status})`);
  }
  console.log(`\nEncoladas: ${queued} | Omitidas: ${skipped} | Método: ${queueMethod}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

export {};
