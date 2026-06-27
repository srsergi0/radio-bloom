import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_DIR = join(__dirname, "temp_integration");
const TEMP_DATA = join(TEMP_DIR, "data");
const TEMP_MUSIC = join(TEMP_DIR, "music");
const TEMP_SONGS = join(TEMP_MUSIC, "songs");

// Configure test environment variables BEFORE importing modules
process.env.DATA_DIR = TEMP_DATA;
process.env.MUSIC_DIR = TEMP_MUSIC;
process.env.MUSIC_MOUNT = TEMP_MUSIC;
process.env.IS_INTEGRATION_TEST = "true";

// Import the actual modules to test (no mocks) using require to bypass static analysis mock interception
const { initDB, searchLibrary, getLibraryStats } = require("../src/db");
const { initLibrary } = require("../src/library");

describe("Integration Tests - Library & DB", () => {
  beforeAll(() => {
    // Setup temporary directories
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    if (!existsSync(TEMP_DATA)) mkdirSync(TEMP_DATA, { recursive: true });
    if (!existsSync(TEMP_SONGS)) mkdirSync(TEMP_SONGS, { recursive: true });
  });

  afterAll(() => {
    // Cleanup temporary directories
    try {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch (e: any) {
      if (e.code !== "EBUSY") {
        console.error("Cleanup error:", e);
      }
    }
  });

  test("should initialize database, scan physical files, and search tracks", () => {
    // 1. Initialize the SQLite database
    initDB();

    // 2. Create a dummy file in the temp songs directory
    const songFilename = "Bad Bunny - Ojitos Lindos.mp3";
    const songPath = join(TEMP_SONGS, songFilename);
    writeFileSync(songPath, "dummy mp3 data content to scan");

    // 3. Scan the directory and initialize library
    initLibrary();

    // 4. Verify the stats report 1 song
    const stats = getLibraryStats();
    expect(stats.totalSongs).toBe(1);

    // 5. Test search query
    const results = searchLibrary("Bad Bunny");
    expect(results.total).toBe(1);
    expect(results.items[0].file).toBe(`songs/${songFilename}`);
    expect(results.items[0].title).toBe("Bad Bunny - Ojitos Lindos");
  });
});
