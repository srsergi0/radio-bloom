import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseConnection } from "../src/infrastructure/database";
import { LibraryRepository } from "../src/repositories/sqlite/library.repo";
import { createLibraryService } from "../src/services/library.service";
import { AudioMetadataClient } from "../src/infrastructure/audio-metadata.client";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMP_DIR = join(__dirname, "temp_integration");
const TEMP_DATA = join(TEMP_DIR, "data");
const TEMP_MUSIC = join(TEMP_DIR, "music");
const TEMP_SONGS = join(TEMP_MUSIC, "songs");

describe("Integration Tests - Library & DB", () => {
  let dbConnection: DatabaseConnection;
  let libraryRepo: LibraryRepository;

  beforeAll(() => {
    rmSync(TEMP_DIR, { recursive: true, force: true });
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    if (!existsSync(TEMP_DATA)) mkdirSync(TEMP_DATA, { recursive: true });
    if (!existsSync(TEMP_SONGS)) mkdirSync(TEMP_SONGS, { recursive: true });

    const dbPath = join(TEMP_DATA, "radio.db");
    dbConnection = new DatabaseConnection(dbPath);
    libraryRepo = new LibraryRepository(dbConnection);
  });

  afterAll(() => {
    dbConnection.client.close();
    try {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch (e: any) {
      if (e.code !== "EBUSY") {
        console.error("Cleanup error:", e);
      }
    }
  });

  test("should initialize database, scan physical files, and search tracks", async () => {
    const songFilename = "Bad Bunny - Ojitos Lindos.mp3";
    const songPath = join(TEMP_SONGS, songFilename);
    writeFileSync(songPath, "dummy mp3 data content to scan");

    const audioMetadataClient = new AudioMetadataClient();
    const libraryService = createLibraryService({
      libraryRepo,
      audioMetadataClient,
      musicDir: TEMP_MUSIC,
      onDeleteCallback: async () => {},
    });

    await libraryService.init();
    await libraryService.rescan();

    expect(libraryRepo.countTracks("song")).toBe(1);

    const results = libraryRepo.search("Bad Bunny");
    expect(results.total).toBe(1);
    expect(results.items[0].file).toBe(`songs/${songFilename}`);
    expect(results.items[0].title).toBe("Bad Bunny - Ojitos Lindos");

    libraryService.shutdown();
  });
});
