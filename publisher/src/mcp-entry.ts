import { initDB } from "./db";
import { initLibrary } from "./library";
import { initLiquidsoap } from "./liquidsoap";
import { startMcpServer } from "./mcp";

initDB();
initLibrary();
initLiquidsoap();

startMcpServer().catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
