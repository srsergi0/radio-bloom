const PUBLISHER_URL = process.env.PUBLISHER_URL || "http://localhost:3000";
const CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || "30000");
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

let consecutiveFailures = 0;

async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${PUBLISHER_URL}/api/status`);
    if (!response.ok) {
      console.error(`[watchdog] Health check failed: ${response.status}`);
      return false;
    }
    const data = await response.json();
    console.log(`[watchdog] OK - Live: ${data.isLive}, Track: ${data.currentTrack?.title || "none"}`);
    return true;
  } catch (err) {
    console.error(`[watchdog] Health check error: ${err}`);
    return false;
  }
}

async function restartPublisher(): Promise<void> {
  console.log("[watchdog] Attempting to restart publisher via play endpoint...");
  try {
    const response = await fetch(`${PUBLISHER_URL}/api/control/play`, {
      method: "POST",
    });
    if (response.ok) {
      console.log("[watchdog] Publisher restart signal sent");
    } else {
      console.error(`[watchdog] Restart failed: ${response.status}`);
    }
  } catch (err) {
    console.error(`[watchdog] Restart error: ${err}`);
  }
}

async function monitor(): Promise<void> {
  const healthy = await checkHealth();

  if (healthy) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    console.log(`[watchdog] Failure ${consecutiveFailures}/${MAX_RETRIES}`);

    if (consecutiveFailures >= MAX_RETRIES) {
      console.log("[watchdog] Max retries reached, restarting publisher...");
      await restartPublisher();
      consecutiveFailures = 0;
    }
  }
}

console.log(`[watchdog] Monitoring ${PUBLISHER_URL} every ${CHECK_INTERVAL}ms`);

setInterval(monitor, CHECK_INTERVAL);

monitor();
