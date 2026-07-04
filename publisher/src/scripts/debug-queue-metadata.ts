/**
 * Diagnostic script: Check what Liquidsoap returns for queue metadata.
 * Run: bun run src/scripts/debug-queue-metadata.ts
 */

import { TelnetClient } from "../infrastructure/telnet.client";

const HOST = process.env.LIQUIDSOAP_HOST || "localhost";
const PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || "1234", 10);

async function main() {
  console.log(`Connecting to Liquidsoap telnet at ${HOST}:${PORT}...`);
  const client = new TelnetClient(HOST, PORT);

  // Wait for connection
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (!client.isConnected()) {
    console.error("Not connected to Liquidsoap. Is it running?");
    process.exit(1);
  }

  console.log("Connected!\n");

  // 1. Get queue
  console.log("=== QUEUE (queue.queue) ===");
  const queueLines = await client.send("queue.queue");
  console.log("Raw response:", queueLines);

  if (queueLines.length === 0 || !queueLines[0].trim()) {
    console.log("Queue is empty.");
    process.exit(0);
  }

  const rids = queueLines[0].split(/\s+/).filter(Boolean);
  console.log("RIDs:", rids);
  console.log(`Found ${rids.length} items in queue\n`);

  // 2. Get metadata for each RID
  for (const rid of rids) {
    console.log(`--- RID ${rid} ---`);
    try {
      const metaLines = await client.send(`request.metadata ${rid}`, 5000);
      console.log("Raw metadata lines:");
      for (const line of metaLines) {
        console.log(`  ${line}`);
      }

      // Parse key=value
      const meta: Record<string, string> = {};
      for (const line of metaLines) {
        const eqIndex = line.indexOf("=");
        if (eqIndex > 0) {
          const key = line.substring(0, eqIndex).trim();
          let value = line.substring(eqIndex + 1).trim();
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          }
          meta[key] = value;
        }
      }
      console.log("Parsed metadata:", JSON.stringify(meta, null, 2));
    } catch (err: any) {
      console.error(`Error fetching metadata for RID ${rid}:`, err.message);
    }
    console.log();
  }

  // 3. Also check request.all
  console.log("=== ALL REQUESTS (request.all) ===");
  const allLines = await client.send("request.all");
  console.log("Raw response:", allLines);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
