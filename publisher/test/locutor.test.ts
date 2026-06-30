import { describe, expect, test, beforeEach } from "bun:test";
import { DatabaseConnection } from "../src/infrastructure/database";
import { LocutorRepository } from "../src/repositories/sqlite/locutor.repo";
import { LocutorService } from "../src/services/locutor.service";

describe("Locutor & Scheduling Tests", () => {
  let db: DatabaseConnection;
  let repo: LocutorRepository;
  let service: LocutorService;

  beforeEach(() => {
    // Create an in-memory database
    db = new DatabaseConnection(":memory:");
    repo = new LocutorRepository(db);
    service = new LocutorService(repo);
  });

  test("should create and retrieve locutors", () => {
    const loc = service.createLocutor({
      name: "Locutor Prueba",
      voice: "es-PE-AlexNeural",
      personality: "Una personalidad amigable",
    });

    expect(loc.id).toBeDefined();
    expect(loc.name).toBe("Locutor Prueba");
    expect(loc.isActive).toBe(true);
    expect(loc.isDefault).toBe(false);

    const retrieved = service.getLocutor(loc.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Locutor Prueba");
  });

  test("should enforce single default locutor", () => {
    const loc1 = service.createLocutor({
      name: "DJ 1",
      voice: "voice1",
      personality: "p1",
      isDefault: true,
    });
    const loc2 = service.createLocutor({
      name: "DJ 2",
      voice: "voice2",
      personality: "p2",
      isDefault: true,
    });

    const dbLoc1 = service.getLocutor(loc1.id);
    const dbLoc2 = service.getLocutor(loc2.id);

    expect(dbLoc1!.isDefault).toBe(false);
    expect(dbLoc2!.isDefault).toBe(true);
  });

  test("should detect scheduling overlaps (daily vs daily)", () => {
    const loc = service.createLocutor({
      name: "DJ Bloom",
      voice: "voice",
      personality: "p",
    });

    // Schedule 1: daily 14:00 - 15:00 (duration 60)
    service.createSchedule({
      locutorId: loc.id,
      type: "daily",
      dayOfWeek: null,
      startHour: "14:00",
      duration: 60,
    });

    // Schedule 2: daily 14:30 - 15:30 (duration 60) -> overlaps!
    expect(() => {
      service.createSchedule({
        locutorId: loc.id,
        type: "daily",
        dayOfWeek: null,
        startHour: "14:30",
        duration: 60,
      });
    }).toThrow();

    // Schedule 3: daily 15:00 - 16:00 (duration 60) -> adjacent, should NOT overlap
    const sch3 = service.createSchedule({
      locutorId: loc.id,
      type: "daily",
      dayOfWeek: null,
      startHour: "15:00",
      duration: 60,
    });
    expect(sch3.id).toBeDefined();
  });

  test("should detect scheduling overlaps (daily vs weekly)", () => {
    const loc1 = service.createLocutor({ name: "DJ 1", voice: "v", personality: "p" });
    const loc2 = service.createLocutor({ name: "DJ 2", voice: "v", personality: "p" });

    // loc1 has daily schedule 10:00 - 11:00
    service.createSchedule({
      locutorId: loc1.id,
      type: "daily",
      dayOfWeek: null,
      startHour: "10:00",
      duration: 60,
    });

    // loc2 tries to schedule Monday (day 1) 10:30 - 11:30 -> overlaps!
    expect(() => {
      service.createSchedule({
        locutorId: loc2.id,
        type: "weekly",
        dayOfWeek: 1,
        startHour: "10:30",
        duration: 60,
      });
    }).toThrow();

    // loc2 schedules Monday (day 1) 11:00 - 12:00 -> adjacent, valid
    const sch = service.createSchedule({
      locutorId: loc2.id,
      type: "weekly",
      dayOfWeek: 1,
      startHour: "11:00",
      duration: 60,
    });
    expect(sch.id).toBeDefined();
  });

  test("should detect scheduling overlaps wrapping around midnight", () => {
    const loc1 = service.createLocutor({ name: "DJ 1", voice: "v", personality: "p" });
    const loc2 = service.createLocutor({ name: "DJ 2", voice: "v", personality: "p" });

    // Sunday (day 0) 23:30 - Monday 00:30 (duration 60)
    service.createSchedule({
      locutorId: loc1.id,
      type: "weekly",
      dayOfWeek: 0,
      startHour: "23:30",
      duration: 60,
    });

    // Monday (day 1) 00:15 - 01:15 -> overlaps since Monday 00:15 is within the Sunday show!
    expect(() => {
      service.createSchedule({
        locutorId: loc2.id,
        type: "weekly",
        dayOfWeek: 1,
        startHour: "00:15",
        duration: 60,
      });
    }).toThrow();
  });
});
