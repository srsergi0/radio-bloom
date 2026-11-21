// La flor: pétalos radiales que responden a las frecuencias del audio real.
// Sin audio (pausa, iOS, sin analizador) respira con un ruido suave.
import { useEffect, useRef } from "react";
import { getAnalyser, player } from "../lib/player";

interface Props {
  accent: string;
  active: boolean;
}

const PETALS = 40;

export default function BloomVisualizer({ accent, active }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const accentRef = useRef(accent);
  const activeRef = useRef(active);
  accentRef.current = accent;
  activeRef.current = active;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let visible = true;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const levels = new Float32Array(PETALS);
    let bins: Uint8Array<ArrayBuffer> | null = null;
    let energy = 0;
    let rot = 0;
    let last = performance.now();

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    });
    io.observe(canvas);

    // Bandas logarítmicas: más resolución en graves y medios, donde vive la música
    const bandFor = (i: number, n: number) => {
      const lo = 2;
      const hi = n * 0.72;
      const t = i / (PETALS / 2);
      return Math.floor(lo * (hi / lo) ** t);
    };

    function sample(t: number) {
      const an = activeRef.current ? getAnalyser() : null;
      const playing = player.get().status === "playing";
      if (an && playing) {
        if (!bins || bins.length !== an.frequencyBinCount) bins = new Uint8Array(an.frequencyBinCount);
        an.getByteFrequencyData(bins);
        const half = PETALS / 2;
        let sum = 0;
        for (let i = 0; i < half; i++) {
          const a = bandFor(i, bins.length);
          const b = Math.max(a + 1, bandFor(i + 1, bins.length));
          let v = 0;
          for (let k = a; k < b; k++) v = Math.max(v, bins[k]);
          // Compensar la caída natural de energía en agudos
          const val = Math.min(1, (v / 255) * (1 + i / half) ** 0.9);
          // Simetría: la flor se refleja
          levels[i] += (val - levels[i]) * 0.35;
          levels[PETALS - 1 - i] = levels[i];
          sum += val;
        }
        energy += (sum / half - energy) * 0.15;
      } else {
        const amp = activeRef.current ? 0.78 : 0.58;
        for (let i = 0; i < PETALS; i++) {
          const n =
            Math.sin(t * 0.0009 + i * 0.45) * 0.5 +
            Math.sin(t * 0.0013 + i * 1.7) * 0.3 +
            Math.sin(t * 0.0005 - i * 0.9) * 0.2;
          const val = amp * (0.5 + 0.5 * n);
          levels[i] += (val - levels[i]) * 0.06;
        }
        energy += (amp * 0.5 - energy) * 0.05;
      }
    }

    function frame(t: number) {
      raf = 0;
      if (!visible) return;
      const dt = Math.min(64, t - last);
      last = t;
      sample(t);
      rot += dt * (0.000025 + energy * 0.00012);

      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2;
      const inner = R * 0.33;
      const color = accentRef.current;

      // Halo
      const halo = g.createRadialGradient(cx, cy, inner * 0.8, cx, cy, R);
      halo.addColorStop(0, withAlpha(color, 0.18 + energy * 0.25));
      halo.addColorStop(1, withAlpha(color, 0));
      g.fillStyle = halo;
      g.fillRect(0, 0, w, h);

      g.globalCompositeOperation = "lighter";
      // Tres capas de pétalos con distinto giro y alcance
      for (let layer = 0; layer < 3; layer++) {
        const reach = [1.0, 0.78, 0.55][layer];
        const alpha = [0.14, 0.2, 0.3][layer];
        const off = rot * (layer % 2 ? -1 : 1) + layer * (Math.PI / PETALS);
        // Un gradiente por capa (no por pétalo): barato incluso en móviles
        const grad = g.createRadialGradient(cx, cy, inner, cx, cy, inner + (R - inner) * reach * 1.18);
        grad.addColorStop(0, withAlpha(color, alpha * 1.4));
        grad.addColorStop(1, withAlpha(color, 0));
        g.fillStyle = grad;
        for (let i = 0; i < PETALS; i++) {
          const lv = levels[(i + layer * 7) % PETALS];
          const len = inner + (R - inner) * reach * (0.12 + lv * 0.88);
          const a = off + (i / PETALS) * Math.PI * 2;
          const spread = (Math.PI / PETALS) * (2.2 + lv * 1.6);
          petal(g, cx, cy, inner * 0.92, len, a, spread);
          g.fill();
        }
      }
      g.globalCompositeOperation = "source-over";

      // Anillo fino que late con los graves
      g.beginPath();
      g.arc(cx, cy, inner * (1.02 + levels[0] * 0.05), 0, Math.PI * 2);
      g.strokeStyle = withAlpha(color, 0.5);
      g.lineWidth = 1;
      g.stroke();

      if (!reduced) raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    // Con movimiento reducido: un fotograma por segundo basta
    const slow = reduced ? window.setInterval(() => requestAnimationFrame(frame), 1000) : 0;

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(slow);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="bloom-canvas" aria-hidden="true" />;
}

function petal(g: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number, a: number, spread: number) {
  const x0 = cx + Math.cos(a) * r0;
  const y0 = cy + Math.sin(a) * r0;
  const tip = { x: cx + Math.cos(a) * r1, y: cy + Math.sin(a) * r1 };
  const mid = r0 + (r1 - r0) * 0.55;
  const l = { x: cx + Math.cos(a - spread) * mid, y: cy + Math.sin(a - spread) * mid };
  const r = { x: cx + Math.cos(a + spread) * mid, y: cy + Math.sin(a + spread) * mid };
  g.beginPath();
  g.moveTo(x0, y0);
  g.quadraticCurveTo(l.x, l.y, tip.x, tip.y);
  g.quadraticCurveTo(r.x, r.y, x0, y0);
  g.closePath();
}

/** "hsl(14 100% 60%)" → "hsl(14 100% 60% / a)" */
function withAlpha(color: string, a: number): string {
  const v = Math.max(0, Math.min(1, a)).toFixed(3);
  if (color.startsWith("hsl(")) return color.replace(/\)$/, ` / ${v})`);
  return color;
}
