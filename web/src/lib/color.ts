// Extrae un color vivo de la portada para teñir toda la escena
import { hueOf } from "./format";

const cache = new Map<string, string>();
export const DEFAULT_ACCENT = "hsl(14 100% 60%)";

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Color de respaldo estable por pista (sin portada) */
export function fallbackAccent(seed: string): string {
  return seed ? `hsl(${hueOf(seed)} 85% 62%)` : DEFAULT_ACCENT;
}

export function accentFromImage(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const size = 40;
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, size, size);
        const { data } = g.getImageData(0, 0, size, size);
        // Histograma de tonos ponderado por saturación: gana el tono vivo dominante
        const bins = new Array(36).fill(0);
        const sat = new Array(36).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
          if (l < 0.12 || l > 0.92 || s < 0.18) continue;
          const w = s * (1 - Math.abs(l - 0.55));
          const b = Math.floor(h / 10) % 36;
          bins[b] += w;
          sat[b] += s * w;
        }
        let best = -1;
        let bestW = 0;
        for (let b = 0; b < 36; b++) if (bins[b] > bestW) (bestW = bins[b]), (best = b);
        if (best < 0 || bestW < 2) return resolve(null);
        const hue = best * 10 + 5;
        const s = Math.min(95, Math.max(60, (sat[best] / bins[best]) * 100));
        const color = `hsl(${hue} ${s.toFixed(0)}% 62%)`;
        cache.set(url, color);
        resolve(color);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
