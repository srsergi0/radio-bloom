import { useState } from "react";
import { hueOf, initials } from "../lib/format";

interface Props {
  src: string | null | undefined;
  seed: string;
  label: string;
  className?: string;
  round?: boolean;
}

/** Portada con respaldo generativo (degradado + iniciales) si no hay imagen */
export default function Cover({ src, seed, label, className = "", round }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  const hue = hueOf(seed || label);
  const showImg = src && failed !== src;
  return (
    <div
      className={`cover ${round ? "cover--round" : ""} ${className}`}
      style={{
        background: `radial-gradient(120% 90% at 20% 15%, hsl(${hue} 70% 55%), transparent 60%), radial-gradient(100% 100% at 85% 90%, hsl(${(hue + 50) % 360} 65% 35%), hsl(${(hue + 200) % 360} 30% 12%))`,
      }}
    >
      {showImg ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : (
        <span className="cover__mono" aria-hidden="true">
          {initials(label) || "♪"}
        </span>
      )}
    </div>
  );
}
