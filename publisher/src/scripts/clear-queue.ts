const API_BASE = "http://localhost:3000";

async function main() {
  console.log("Limpiando cola...");
  const res = await fetch(`${API_BASE}/api/stream/queue`, { method: "DELETE" });
  const data = (await res.json()) as any;
  if (!data.ok) {
    console.error("Error:", data.error);
    process.exit(1);
  }
  console.log("Cola eliminada");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

export {};
