import { heartCount, live, sendHeart } from "../lib/live";
import { useStore } from "../lib/store";

interface Props {
  trackKey: string | undefined;
  count: number | undefined;
  label: string;
  labelOn: string;
  size?: "sm" | "md";
}

/** Corazón con conteo en vivo; uno por pista y navegador */
export default function Heart({ trackKey, count, label, labelOn, size = "md" }: Props) {
  const s = useStore(live);
  if (!trackKey) return null;
  const n = heartCount(trackKey, count);
  const on = Boolean(s.myHearts[trackKey]);
  return (
    <button
      type="button"
      className={`heart heart--${size} ${on ? "is-on" : ""}`}
      aria-pressed={on}
      aria-label={on ? labelOn : label}
      title={on ? labelOn : label}
      onClick={() => sendHeart(trackKey, n)}
      disabled={on}
    >
      <svg viewBox="0 0 24 24" width={size === "sm" ? 16 : 20} height={size === "sm" ? 16 : 20} aria-hidden="true">
        <path
          d="M12 20.5s-7.5-4.6-9.3-9.1C1.5 8.2 3.4 5 6.6 5c2 0 3.4 1.1 4.2 2.3h2.4C14 6.1 15.4 5 17.4 5c3.2 0 5.1 3.2 3.9 6.4-1.8 4.5-9.3 9.1-9.3 9.1Z"
          fill={on ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {n > 0 && <span className="heart__n">{n}</span>}
    </button>
  );
}
