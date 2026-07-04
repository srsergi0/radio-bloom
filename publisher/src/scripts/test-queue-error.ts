/**
 * Test script to reproduce queue error with duplicate songs
 */

const API = "http://localhost:3000";

async function main() {
  console.log("=== TEST: Cola con canciones duplicadas e interludios ===\n");

  // 1. Limpiar cola
  console.log("1. Limpiando cola...");
  await fetch(`${API}/api/stream/queue`, { method: "DELETE" });
  console.log("   Cola vaciada\n");

  // 2. Buscar y añadir canción "bad"
  console.log("2. Buscando canción 'bad'...");
  const searchRes = await fetch(`${API}/api/library/search?q=bad&limit=1`);
  const searchData = (await searchRes.json()) as any;
  const song = searchData.data.items[0];
  console.log(`   Encontrada: "${song.title}" por ${song.artist} [${song.id}]`);

  console.log("   Añadiendo a la cola...");
  await fetch(`${API}/api/stream/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ id: song.id }]),
  });
  await new Promise((r) => setTimeout(r, 2000));
  console.log("   Canción añadida\n");

  // 3. Ver cola
  console.log("3. Cola actual:");
  const queue1 = await fetch(`${API}/api/stream/queue`);
  const queue1Data = (await queue1.json()) as any;
  queue1Data.data.forEach((item: any, i: number) => {
    console.log(
      `   ${i + 1}. [${item.type}] ${item.title || item.script} ${item.artist ? `(${item.artist})` : ""}`
    );
  });
  console.log("");

  // 4. Añadir interludio TTS
  console.log("4. Añadiendo interludio TTS...");
  await fetch(`${API}/api/stream/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ script: "Ha sonado Bad Bunny" }]),
  });
  await new Promise((r) => setTimeout(r, 3000));
  console.log("   Interludio añadido\n");

  // 5. Ver cola
  console.log("5. Cola actual:");
  const queue2 = await fetch(`${API}/api/stream/queue`);
  const queue2Data = (await queue2.json()) as any;
  queue2Data.data.forEach((item: any, i: number) => {
    console.log(
      `   ${i + 1}. [${item.type}] ${item.title || item.script} ${item.artist ? `(${item.artist})` : ""}`
    );
  });
  console.log("");

  // 6. Añadir la misma canción "bad" otra vez
  console.log("6. Añadiendo la misma canción 'bad' otra vez...");
  await fetch(`${API}/api/stream/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ id: song.id }]),
  });
  await new Promise((r) => setTimeout(r, 2000));
  console.log("   Canción añadida\n");

  // 7. Ver cola final - aquí debería estar el error
  console.log("7. Cola final (debería haber 3 items):");
  const queue3 = await fetch(`${API}/api/stream/queue`);
  const queue3Data = (await queue3.json()) as any;
  queue3Data.data.forEach((item: any, i: number) => {
    console.log(
      `   ${i + 1}. [${item.type}] ${item.title || item.script} ${item.artist ? `(${item.artist})` : ""}`
    );
  });

  console.log("\n=== FIN TEST ===");
}

main().catch(console.error);

export {};
