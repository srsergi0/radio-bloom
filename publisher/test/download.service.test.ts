import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import { DownloadService } from "../src/services/download.service";
import { LibraryRepository } from "../src/repositories/sqlite/library.repo";
import { DatabaseConnection } from "../src/infrastructure/database";
import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";

// Create in-memory DB connection for clean tests
const dbConnection = new DatabaseConnection(":memory:");
const libraryRepo = new LibraryRepository(dbConnection);

// Mock clients
const mockSpotiflacClient = {
  download: mock(async (url: string) => {
    // Simulate delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (url.includes("fail")) {
      return { filename: null, error: "Download failed" };
    }
    return { filename: "track_downloaded.mp3", error: null };
  }),
} as any;

const mockFfprobeClient = {
  extractMetadata: mock(() => ({
    title: "Test Spotify Track",
    artist: "Test Artist",
    album: "Test Album",
    duration: 180,
  })),
} as any;

const songsDir = join(import.meta.dirname || "", "temp_songs_test");
if (!existsSync(songsDir)) {
  mkdirSync(songsDir, { recursive: true });
}

describe("DownloadService SQLite Queue", () => {
  let downloadService: DownloadService;

  afterAll(() => {
    try {
      rmSync(songsDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    // Clear downloads table
    libraryRepo.clearDownloads();
    mockSpotiflacClient.download.mockClear();

    // Create some dummy file to read size/stat in tests
    writeFileSync(join(songsDir, "track_downloaded.mp3"), "dummy audio");

    downloadService = new DownloadService(
      libraryRepo,
      mockSpotiflacClient,
      mockFfprobeClient,
      songsDir
    );
  });

  test("should queue downloads and process them sequentially", async () => {
    // Start queue worker
    downloadService.init();

    // Queue 2 downloads
    const job1Promise = downloadService.downloadFromSpotify("https://spotify.com/track/1");
    const job2Promise = downloadService.downloadFromSpotify("https://spotify.com/track/2");

    const [job1, job2] = await Promise.all([job1Promise, job2Promise]);

    // Initially they are created and queued
    expect(job1.status).toBe("queued");
    expect(job2.status).toBe("queued");

    // Wait for the queue to finish processing both
    await new Promise((resolve) => setTimeout(resolve, 300));

    const allJobs = libraryRepo.getAllDownloads();
    expect(allJobs.length).toBe(2);

    const completedJob1 = libraryRepo.getDownload(job1.id);
    const completedJob2 = libraryRepo.getDownload(job2.id);

    expect(completedJob1?.status).toBe("done");
    expect(completedJob2?.status).toBe("done");

    // Verify spotiflac client was called twice
    expect(mockSpotiflacClient.download).toHaveBeenCalledTimes(2);
  });

  test("should handle download failures and continue to next item", async () => {
    downloadService.init();

    // Queue one failing and one succeeding track
    await downloadService.downloadFromSpotify("https://spotify.com/track/fail");
    const job2 = await downloadService.downloadFromSpotify("https://spotify.com/track/2");

    // Wait for queue processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    const downloads = libraryRepo.getAllDownloads();
    const failingJob = downloads.find(d => d.url.includes("fail"));
    const succeedingJob = downloads.find(d => d.url === "https://spotify.com/track/2");

    expect(failingJob?.status).toBe("error");
    expect(failingJob?.error).toBe("Download failed");
    expect(succeedingJob?.status).toBe("done");
  });

  test("should clean up stuck 'downloading' jobs on startup", () => {
    // Insert a fake downloading job directly to simulate a crash
    const stuckJob = libraryRepo.createDownload("https://spotify.com/track/stuck");
    libraryRepo.updateDownload(stuckJob.id, { status: "downloading" });

    // Initialize the service (simulating server boot)
    downloadService.init();

    const cleanedJob = libraryRepo.getDownload(stuckJob.id);
    expect(cleanedJob?.status).toBe("error");
    expect(cleanedJob?.error).toBe("Interrupted by server restart");
  });
});
