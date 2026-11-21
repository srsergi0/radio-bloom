export const TZ = "America/Lima";

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function limaHM(ms: number): string {
  return new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(ms);
}

/** Día de la semana (0=domingo) y minuto del día en Lima */
export function limaNow(ms = Date.now()): { dayOfWeek: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const h = Number(get("hour")) % 24;
  return { dayOfWeek: days.indexOf(get("weekday")), minute: h * 60 + Number(get("minute")) };
}

export function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function minToHM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Color estable derivado de un texto (para portadas/avatares sin imagen) */
export function hueOf(str: string): number {
  return hash(str) % 360;
}

const REGIONS: Record<string, { es: string; en: string; flag: string }> = {
  ES: { es: "España", en: "Spain", flag: "🇪🇸" },
  MX: { es: "México", en: "Mexico", flag: "🇲🇽" },
  AR: { es: "Argentina", en: "Argentina", flag: "🇦🇷" },
  PE: { es: "Perú", en: "Peru", flag: "🇵🇪" },
  CO: { es: "Colombia", en: "Colombia", flag: "🇨🇴" },
  CL: { es: "Chile", en: "Chile", flag: "🇨🇱" },
  VE: { es: "Venezuela", en: "Venezuela", flag: "🇻🇪" },
  UY: { es: "Uruguay", en: "Uruguay", flag: "🇺🇾" },
  BO: { es: "Bolivia", en: "Bolivia", flag: "🇧🇴" },
  EC: { es: "Ecuador", en: "Ecuador", flag: "🇪🇨" },
  CU: { es: "Cuba", en: "Cuba", flag: "🇨🇺" },
  DO: { es: "Rep. Dominicana", en: "Dominican Rep.", flag: "🇩🇴" },
  PR: { es: "Puerto Rico", en: "Puerto Rico", flag: "🇵🇷" },
  US: { es: "EE. UU.", en: "USA", flag: "🇺🇸" },
  CR: { es: "Costa Rica", en: "Costa Rica", flag: "🇨🇷" },
  GT: { es: "Guatemala", en: "Guatemala", flag: "🇬🇹" },
  PA: { es: "Panamá", en: "Panama", flag: "🇵🇦" },
  PY: { es: "Paraguay", en: "Paraguay", flag: "🇵🇾" },
  SV: { es: "El Salvador", en: "El Salvador", flag: "🇸🇻" },
  HN: { es: "Honduras", en: "Honduras", flag: "🇭🇳" },
  NI: { es: "Nicaragua", en: "Nicaragua", flag: "🇳🇮" },
  GQ: { es: "Guinea Ecuatorial", en: "Equatorial Guinea", flag: "🇬🇶" },
};

/** "es-PE-AlexNeural" → { name: "Alex", region: "Perú", flag } */
export function describeVoice(voice: string, lang: "es" | "en") {
  const [, region = "", rest = ""] = voice.split("-");
  const name = rest.replace(/(Multilingual)?Neural$/, "");
  const r = REGIONS[region.toUpperCase()];
  return { name, region: r ? r[lang] : region, flag: r?.flag ?? "🎙️" };
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}
