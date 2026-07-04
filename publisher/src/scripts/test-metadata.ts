import { TelnetClient } from "../infrastructure/telnet.client";

async function getRequestMetadata(
  client: TelnetClient,
  rid: string
): Promise<Record<string, string>> {
  try {
    const lines = await client.send(`request.metadata ${rid}`, 5000);
    const meta: Record<string, string> = {};
    for (const line of lines) {
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
    return meta;
  } catch {
    return {};
  }
}

async function getActiveRequestId(
  client: TelnetClient,
  currentTitle: string,
  currentArtist: string
): Promise<string | null> {
  try {
    const allRidsLines = await client.send("request.all").catch(() => []);
    const rids: string[] = [];
    for (const line of allRidsLines) {
      for (const part of line.trim().split(/\s+/)) {
        if (part && !Number.isNaN(Number(part))) {
          rids.push(part);
        }
      }
    }

    console.log("Found request IDs in Liquidsoap:", rids);

    for (const rid of rids) {
      const meta = await getRequestMetadata(client, rid);
      const normTitle = (meta.title || "").toLowerCase().trim();
      const normArtist = (meta.artist || "").toLowerCase().trim();
      const targetTitle = currentTitle.toLowerCase().trim();
      const targetArtist = currentArtist.toLowerCase().trim();

      console.log(`Checking RID ${rid}: Title: "${meta.title}" | Artist: "${meta.artist}"`);

      if (
        normTitle &&
        targetTitle &&
        (normTitle.includes(targetTitle) || targetTitle.includes(normTitle))
      ) {
        if (
          !targetArtist ||
          normArtist.includes(targetArtist) ||
          targetArtist.includes(normArtist)
        ) {
          return rid;
        }
      }
    }
    return null;
  } catch (err: any) {
    console.error("Error in getActiveRequestId:", err.message);
    return null;
  }
}

async function run() {
  console.log("Starting Liquidsoap Telnet Metadata Inspector...");
  const client = new TelnetClient("localhost", 1234);

  // Wait a bit for connection
  await new Promise((resolve) => setTimeout(resolve, 1500));

  if (!client.isConnected()) {
    console.error("Could not connect to telnet!");
    process.exit(1);
  }

  // 1. Get harbor metadata
  console.log("\nFetching output.harbor.metadata...");
  const harborLines = await client.send("output.harbor.metadata").catch(() => []);
  const harborMeta: Record<string, string> = {};
  for (const line of harborLines) {
    const eqIndex = line.indexOf("=");
    if (eqIndex > 0) {
      const key = line.substring(0, eqIndex).trim();
      let value = line.substring(eqIndex + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      harborMeta[key] = value;
    }
  }

  console.log("Parsed harbor metadata:", harborMeta);

  if (!harborMeta.title) {
    console.log("No song is currently playing according to output.harbor.metadata.");
    process.exit(0);
  }

  const title = harborMeta.title;
  const artist = harborMeta.artist || "";

  console.log(`\nActive song on air: Title: "${title}" | Artist: "${artist}"`);
  console.log("Attempting to resolve correct request ID...");

  const matchedRid = await getActiveRequestId(client, title, artist);
  console.log(`\n========================================`);
  console.log(`MATCHED REQUEST ID: ${matchedRid}`);
  console.log(`========================================`);

  if (matchedRid) {
    const fullMeta = await getRequestMetadata(client, matchedRid);
    console.log("Full request metadata:", fullMeta);
  } else {
    console.log("Could not find a matching request ID in request.all.");
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
