import { eq } from "drizzle-orm";
import type { Locutor, LocutorSchedule } from "../../domain/types";
import type { DatabaseConnection } from "../../infrastructure/database";
import * as schema from "./schema";

export class LocutorRepository {
  constructor(private readonly db: DatabaseConnection) {}

  public createLocutor(data: {
    name: string;
    voice: string;
    personality: string;
    isActive?: boolean;
    isDefault?: boolean;
  }): Locutor {
    const id = `loc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const isActive = data.isActive !== false ? 1 : 0;
    const isDefault = data.isDefault === true ? 1 : 0;

    // If setting as default, unset others first
    if (isDefault === 1) {
      this.db.drizzle.update(schema.locutors).set({ isDefault: 0 }).run();
    }

    this.db.drizzle
      .insert(schema.locutors)
      .values({
        id,
        name: data.name,
        voice: data.voice,
        personality: data.personality,
        isActive,
        isDefault,
      })
      .run();

    return {
      id,
      name: data.name,
      voice: data.voice,
      personality: data.personality,
      isActive: isActive === 1,
      isDefault: isDefault === 1,
    };
  }

  public listLocutors(): Locutor[] {
    const rows = this.db.drizzle.select().from(schema.locutors).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      voice: r.voice,
      personality: r.personality,
      isActive: r.isActive === 1,
      isDefault: r.isDefault === 1,
    }));
  }

  public getLocutor(id: string): Locutor | null {
    const r = this.db.drizzle
      .select()
      .from(schema.locutors)
      .where(eq(schema.locutors.id, id))
      .get();
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      voice: r.voice,
      personality: r.personality,
      isActive: r.isActive === 1,
      isDefault: r.isDefault === 1,
    };
  }

  public updateLocutor(
    id: string,
    updates: Partial<{
      name: string;
      voice: string;
      personality: string;
      isActive: boolean;
      isDefault: boolean;
    }>
  ): Locutor | null {
    const exists = this.getLocutor(id);
    if (!exists) return null;

    const values: Record<string, any> = {};
    if (updates.name !== undefined) values.name = updates.name;
    if (updates.voice !== undefined) values.voice = updates.voice;
    if (updates.personality !== undefined) values.personality = updates.personality;
    if (updates.isActive !== undefined) values.isActive = updates.isActive ? 1 : 0;
    if (updates.isDefault !== undefined) {
      values.isDefault = updates.isDefault ? 1 : 0;
      if (updates.isDefault) {
        // Unset others
        this.db.drizzle.update(schema.locutors).set({ isDefault: 0 }).run();
      }
    }

    if (Object.keys(values).length > 0) {
      this.db.drizzle.update(schema.locutors).set(values).where(eq(schema.locutors.id, id)).run();
    }

    return this.getLocutor(id);
  }

  public deleteLocutor(id: string): boolean {
    const exists = this.getLocutor(id);
    if (!exists) return false;

    this.db.drizzle.transaction((tx) => {
      tx.delete(schema.locutorSchedules).where(eq(schema.locutorSchedules.locutorId, id)).run();
      tx.delete(schema.locutors).where(eq(schema.locutors.id, id)).run();
    });
    return true;
  }

  public createSchedule(data: {
    locutorId: string;
    type: "daily" | "weekly";
    dayOfWeek: number | null;
    startHour: string;
    duration: number;
  }): LocutorSchedule {
    const id = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.drizzle
      .insert(schema.locutorSchedules)
      .values({
        id,
        locutorId: data.locutorId,
        type: data.type,
        dayOfWeek: data.dayOfWeek,
        startHour: data.startHour,
        duration: data.duration,
      })
      .run();

    return {
      id,
      locutorId: data.locutorId,
      type: data.type,
      dayOfWeek: data.dayOfWeek,
      startHour: data.startHour,
      duration: data.duration,
    };
  }

  public listSchedules(locutorId?: string): LocutorSchedule[] {
    const rows = locutorId
      ? this.db.drizzle
          .select()
          .from(schema.locutorSchedules)
          .where(eq(schema.locutorSchedules.locutorId, locutorId))
          .all()
      : this.db.drizzle.select().from(schema.locutorSchedules).all();

    return rows.map((r) => ({
      id: r.id,
      locutorId: r.locutorId,
      type: r.type as any,
      dayOfWeek: r.dayOfWeek,
      startHour: r.startHour,
      duration: r.duration,
    }));
  }

  public deleteSchedule(id: string): boolean {
    const row = this.db.drizzle
      .select()
      .from(schema.locutorSchedules)
      .where(eq(schema.locutorSchedules.id, id))
      .get();
    if (!row) return false;

    this.db.drizzle.delete(schema.locutorSchedules).where(eq(schema.locutorSchedules.id, id)).run();
    return true;
  }
}
