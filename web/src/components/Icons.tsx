// Iconos inline (sin dependencias)
type P = { size?: number };

export const PlayIcon = ({ size = 24 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
  </svg>
);

export const StopIcon = ({ size = 24 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" />
  </svg>
);

export const VolumeIcon = ({ size = 20, muted }: P & { muted?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" fill="currentColor" stroke="none" />
    {muted ? (
      <path d="m16 9.5 5 5m0-5-5 5" />
    ) : (
      <>
        <path d="M15.5 9a4 4 0 0 1 0 6" />
        <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
      </>
    )}
  </svg>
);

export const Spinner = ({ size = 24 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="spin" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

export const WaveIcon = ({ size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="eq">
    <rect x="1" y="6" width="2.4" height="4" rx="1.2" fill="currentColor" />
    <rect x="5" y="3" width="2.4" height="10" rx="1.2" fill="currentColor" />
    <rect x="9" y="5" width="2.4" height="6" rx="1.2" fill="currentColor" />
    <rect x="13" y="2" width="2.4" height="12" rx="1.2" fill="currentColor" />
  </svg>
);
