/** Small line/solid icons for the player controls (24×24, take the text colour). */
const base = { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true } as const;

export const IconPlay = () => (
  <svg {...base} width={16} height={16} fill="currentColor">
    <path d="M8.1 5.2v13.6a.9.9 0 0 0 1.4.8l10-6.8a.9.9 0 0 0 0-1.5L9.5 4.4a.9.9 0 0 0-1.4.8z" />
  </svg>
);

export const IconPause = () => (
  <svg {...base} width={16} height={16} fill="currentColor">
    <rect x="6.2" y="5" width="4" height="14" rx="1.2" />
    <rect x="13.8" y="5" width="4" height="14" rx="1.2" />
  </svg>
);

export const IconPrev = () => (
  <svg {...base} fill="currentColor">
    <rect x="5" y="5" width="2.2" height="14" rx=".9" />
    <path d="M19 6.1v11.8a.8.8 0 0 1-1.3.6L9.6 12.6a.8.8 0 0 1 0-1.2l8.1-5.9A.8.8 0 0 1 19 6.1z" />
  </svg>
);

export const IconNext = () => (
  <svg {...base} fill="currentColor" style={{ transform: 'scaleX(-1)' }}>
    <rect x="5" y="5" width="2.2" height="14" rx=".9" />
    <path d="M19 6.1v11.8a.8.8 0 0 1-1.3.6L9.6 12.6a.8.8 0 0 1 0-1.2l8.1-5.9A.8.8 0 0 1 19 6.1z" />
  </svg>
);

/** Circular arrow with 10 inside: jump back (or, mirrored, forward) 10 seconds. */
function Skip10({ forward }: { forward?: boolean }) {
  return (
    <svg {...base} width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <g transform={forward ? 'translate(24 0) scale(-1 1)' : undefined}>
        <path d="M12 4.6a8 8 0 1 1-7.6 5.5" />
        <path d="M12.2 1.4 8.6 4.6l3.6 3.2" />
      </g>
      <text x="12" y="15.6" textAnchor="middle" fontSize="7.6" fontWeight="700" fill="currentColor" stroke="none" fontFamily="-apple-system, system-ui, sans-serif">
        10
      </text>
    </svg>
  );
}
export const IconBack10 = () => <Skip10 />;
export const IconFwd10 = () => <Skip10 forward />;

export const IconVolume = ({ muted }: { muted?: boolean }) => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 9.6v4.8h3.6l5 4V5.6l-5 4H4z" fill="currentColor" stroke="none" />
    {muted ? <path d="M16.2 9.6l4.4 4.8M20.6 9.6l-4.4 4.8" /> : <path d="M16 9.2a4.2 4.2 0 0 1 0 5.6M18.4 6.8a7.6 7.6 0 0 1 0 10.4" />}
  </svg>
);

export const IconFullscreen = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
  </svg>
);

export const IconSwap = () => (
  <svg {...base} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5M20 16H6M9.5 12.5 6 16l3.5 3.5" />
  </svg>
);
