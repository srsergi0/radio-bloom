// Oyentes en las últimas 24 h: área fina de una sola serie, con cruz y tooltip al pasar el ratón
import { type PointerEvent, useMemo, useRef, useState } from "react";
import { limaHM } from "../../lib/format";

interface Props {
  points: Array<{ t: number; n: number }>;
}

const W = 720;
const H = 180;
const PAD = { top: 16, right: 12, bottom: 24, left: 32 };

export default function ListenersChart({ points }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const max = Math.max(4, ...points.map((p) => p.n));
    // Techo "bonito" para las marcas del eje
    const step = max <= 10 ? 2 : max <= 50 ? 10 : max <= 200 ? 50 : 100;
    const top = Math.ceil(max / step) * step;
    const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (n: number) => PAD.top + (1 - n / top) * (H - PAD.top - PAD.bottom);
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.n).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z`;
    const ticksY = Array.from({ length: top / step + 1 }, (_, i) => i * step);
    // Marcas horarias cada 6 h
    const ticksX: number[] = [];
    const sixH = 6 * 3600_000;
    for (let t = Math.ceil(t0 / sixH) * sixH; t <= t1; t += sixH) ticksX.push(t);
    return { x, y, line, area, ticksY, ticksX, top };
  }, [points]);

  if (!geo) return <p className="panel__empty">Aún no hay suficientes datos de audiencia.</p>;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    points.forEach((p, i) => {
      const d = Math.abs(geo.x(p.t) - px);
      if (d < bestD) (bestD = d), (best = i);
    });
    setHover(best);
  };

  const h = hover !== null ? points[hover] : null;

  return (
    <div className="lchart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Oyentes en las últimas 24 horas. Máximo ${Math.max(...points.map((p) => p.n))}.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="lchart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {geo.ticksY.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={geo.y(v)} y2={geo.y(v)} className="lchart__grid" />
            <text x={PAD.left - 8} y={geo.y(v) + 4} className="lchart__tick" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {geo.ticksX.map((t) => (
          <text key={t} x={geo.x(t)} y={H - 6} className="lchart__tick" textAnchor="middle">
            {limaHM(t)}
          </text>
        ))}
        <path d={geo.area} fill="url(#lchart-fill)" />
        <path d={geo.line} className="lchart__line" />
        {h && (
          <g>
            <line x1={geo.x(h.t)} x2={geo.x(h.t)} y1={PAD.top} y2={H - PAD.bottom} className="lchart__cross" />
            <circle cx={geo.x(h.t)} cy={geo.y(h.n)} r="4.5" className="lchart__dot" />
          </g>
        )}
      </svg>
      {h && (
        <div className="lchart__tip" style={{ left: `${(geo.x(h.t) / W) * 100}%` }}>
          <strong>{h.n}</strong> {h.n === 1 ? "oyente" : "oyentes"}
          <span>{limaHM(h.t)}</span>
        </div>
      )}
    </div>
  );
}
