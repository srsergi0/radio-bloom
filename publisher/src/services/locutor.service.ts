import type { Locutor, LocutorSchedule } from "../domain/types";
import type { LocutorRepository } from "../repositories/sqlite/locutor.repo";

export interface Interval {
  start: number;
  end: number;
}

export class LocutorService {
  constructor(private readonly locutorRepo: LocutorRepository) {}

  /**
   * Helper: Expands a schedule into one or more weekly minute intervals [0, 10080].
   */
  public expandScheduleToWeeklyIntervals(schedule: {
    type: "daily" | "weekly";
    dayOfWeek: number | null;
    startHour: string;
    duration: number;
  }): Interval[] {
    const [hours, minutes] = schedule.startHour.split(":").map(Number);
    const duration = schedule.duration;
    const dayMinutes = hours * 60 + minutes;

    const intervals: Interval[] = [];

    const addWeeklyInterval = (d: number) => {
      const start = d * 1440 + dayMinutes;
      const end = start + duration;

      if (end <= 10080) {
        intervals.push({ start, end });
      } else {
        // Wrap around week boundary (Sunday midnight)
        intervals.push({ start, end: 10080 });
        intervals.push({ start: 0, end: end - 10080 });
      }
    };

    if (schedule.type === "daily") {
      // Runs every day, so we add the interval for days 0..6
      for (let d = 0; d < 7; d++) {
        addWeeklyInterval(d);
      }
    } else if (schedule.type === "weekly") {
      const d = schedule.dayOfWeek ?? 0;
      addWeeklyInterval(d);
    }

    return intervals;
  }

  /**
   * Check if two schedules overlap (Guardrail logic).
   */
  public checkOverlap(
    schA: {
      type: "daily" | "weekly";
      dayOfWeek: number | null;
      startHour: string;
      duration: number;
    },
    schB: {
      type: "daily" | "weekly";
      dayOfWeek: number | null;
      startHour: string;
      duration: number;
    }
  ): boolean {
    const intervalsA = this.expandScheduleToWeeklyIntervals(schA);
    const intervalsB = this.expandScheduleToWeeklyIntervals(schB);

    for (const intA of intervalsA) {
      for (const intB of intervalsB) {
        const startMax = Math.max(intA.start, intB.start);
        const endMin = Math.min(intA.end, intB.end);
        if (startMax < endMin) {
          return true; // Overlap found!
        }
      }
    }

    return false;
  }

  /**
   * Validates a schedule against all existing active locutors' schedules to prevent conflicts.
   */
  public validateSchedule(
    locutorId: string,
    newSchedule: {
      type: "daily" | "weekly";
      dayOfWeek: number | null;
      startHour: string;
      duration: number;
    }
  ): { isValid: boolean; reason?: string } {
    // Basic validations
    if (
      !newSchedule.startHour ||
      !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(newSchedule.startHour)
    ) {
      return { isValid: false, reason: "Formato de hora de inicio inválido. Debe ser HH:MM." };
    }
    if (newSchedule.duration <= 0 || newSchedule.duration > 1440) {
      return { isValid: false, reason: "La duración debe estar entre 1 y 1440 minutos." };
    }
    if (
      newSchedule.type === "weekly" &&
      (newSchedule.dayOfWeek === null || newSchedule.dayOfWeek < 0 || newSchedule.dayOfWeek > 6)
    ) {
      return {
        isValid: false,
        reason: "El día de la semana es obligatorio para programaciones semanales (0-6).",
      };
    }

    const targetLocutor = this.locutorRepo.getLocutor(locutorId);
    if (!targetLocutor) {
      return { isValid: false, reason: "Locutor no encontrado." };
    }

    // Only validate conflicts if the target locutor is active.
    // However, it's better to always avoid scheduling conflicts between active schedules.
    // Get all active locutors
    const allLocutors = this.locutorRepo.listLocutors();
    const activeLocutors = allLocutors.filter((l) => l.isActive);

    const activeLocutorIds = new Set(activeLocutors.map((l) => l.id));
    // Also include target locutor if it's currently inactive but we're adding to it
    activeLocutorIds.add(locutorId);

    // Get all schedules
    const allSchedules = this.locutorRepo.listSchedules();

    // Check overlap with active locutors' schedules
    for (const sch of allSchedules) {
      if (!activeLocutorIds.has(sch.locutorId)) continue;

      const loc = allLocutors.find((l) => l.id === sch.locutorId);
      const locName = loc ? loc.name : "Desconocido";

      if (this.checkOverlap(newSchedule, sch)) {
        const dayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
        const timeInfo =
          sch.type === "daily" ? "Diario" : `Semanal (${dayNames[sch.dayOfWeek ?? 0]})`;

        return {
          isValid: false,
          reason: `Conflicto horario con programa de "${locName}" (${timeInfo} a las ${sch.startHour} por ${sch.duration} min).`,
        };
      }
    }

    return { isValid: true };
  }

  /**
   * Gets the active locutor at the current time in Peru (America/Lima).
   */
  public getActiveLocutorAtCurrentTime(): Locutor | null {
    const allLocutors = this.locutorRepo.listLocutors();
    const activeLocutors = allLocutors.filter((l) => l.isActive);
    if (activeLocutors.length === 0) return null;

    // Get current Peru date/time
    const nowInPeru = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
    const dayOfWeek = nowInPeru.getDay();
    const hour = nowInPeru.getHours();
    const minute = nowInPeru.getMinutes();

    const currentWeeklyMin = dayOfWeek * 1440 + hour * 60 + minute;
    const currentDailyMin = hour * 60 + minute;

    // Get all schedules
    const allSchedules = this.locutorRepo.listSchedules();

    // Find if any active locutor has a schedule covering this time
    for (const sch of allSchedules) {
      const loc = activeLocutors.find((l) => l.id === sch.locutorId);
      if (!loc) continue; // Either locutor is inactive or not found

      const [sh, sm] = sch.startHour.split(":").map(Number);
      const startMinutes = sh * 60 + sm;

      if (sch.type === "daily") {
        const diff = (currentDailyMin - startMinutes + 1440) % 1440;
        if (diff >= 0 && diff < sch.duration) {
          return loc;
        }
      } else {
        const startWeeklyMin = sch.dayOfWeek! * 1440 + startMinutes;
        const diff = (currentWeeklyMin - startWeeklyMin + 10080) % 10080;
        if (diff >= 0 && diff < sch.duration) {
          return loc;
        }
      }
    }

    // Fallback to default active locutor if no schedule matches
    const defaultLoc = activeLocutors.find((l) => l.isDefault);
    if (defaultLoc) return defaultLoc;

    return null;
  }

  // CRUD proxies to repo
  public createLocutor(data: Parameters<LocutorRepository["createLocutor"]>[0]): Locutor {
    return this.locutorRepo.createLocutor(data);
  }

  public listLocutors(): Locutor[] {
    return this.locutorRepo.listLocutors();
  }

  public getLocutor(id: string): Locutor | null {
    return this.locutorRepo.getLocutor(id);
  }

  public updateLocutor(
    id: string,
    updates: Parameters<LocutorRepository["updateLocutor"]>[1]
  ): Locutor | null {
    // If we're activating a locutor, we should check if any of their schedules conflict with other active schedules.
    if (updates.isActive === true) {
      const locSchedules = this.locutorRepo.listSchedules(id);
      for (const sch of locSchedules) {
        // Temporarily check if sch conflicts with others
        const validation = this.validateScheduleForActivation(id, sch);
        if (!validation.isValid) {
          throw new Error(
            `No se puede activar el locutor debido a un conflicto de horarios: ${validation.reason}`
          );
        }
      }
    }
    return this.locutorRepo.updateLocutor(id, updates);
  }

  private validateScheduleForActivation(
    locutorId: string,
    newSchedule: LocutorSchedule
  ): { isValid: boolean; reason?: string } {
    const allLocutors = this.locutorRepo.listLocutors();
    const activeLocutors = allLocutors.filter((l) => l.isActive && l.id !== locutorId);
    const activeLocutorIds = new Set(activeLocutors.map((l) => l.id));
    const allSchedules = this.locutorRepo.listSchedules();

    for (const sch of allSchedules) {
      if (!activeLocutorIds.has(sch.locutorId)) continue;
      const loc = allLocutors.find((l) => l.id === sch.locutorId);
      const locName = loc ? loc.name : "Desconocido";

      if (this.checkOverlap(newSchedule, sch)) {
        const dayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
        const timeInfo =
          sch.type === "daily" ? "Diario" : `Semanal (${dayNames[sch.dayOfWeek ?? 0]})`;

        return {
          isValid: false,
          reason: `Conflicto horario con programa de "${locName}" (${timeInfo} a las ${sch.startHour} por ${sch.duration} min).`,
        };
      }
    }
    return { isValid: true };
  }

  public deleteLocutor(id: string): boolean {
    return this.locutorRepo.deleteLocutor(id);
  }

  public createSchedule(data: Parameters<LocutorRepository["createSchedule"]>[0]): LocutorSchedule {
    const validation = this.validateSchedule(data.locutorId, data);
    if (!validation.isValid) {
      throw new Error(validation.reason);
    }
    return this.locutorRepo.createSchedule(data);
  }

  public listSchedules(locutorId?: string): LocutorSchedule[] {
    return this.locutorRepo.listSchedules(locutorId);
  }

  public deleteSchedule(id: string): boolean {
    return this.locutorRepo.deleteSchedule(id);
  }
}
