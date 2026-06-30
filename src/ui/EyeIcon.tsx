// Inline-SVG-Augensymbol für Sichtbarkeits-Schalter im Navigator.
// Nutzt currentColor → erbt die Textfarbe der Zeile (aktiv/gedimmt/grau).
// Offen = sichtbar, geschlossen/durchgestrichen = ausgeblendet.

/** Augensymbol; `open` steuert offen (sichtbar) vs. durchgestrichen. */
export function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {open ? (
        <>
          {/* Augenkontur + Pupille. */}
          <path d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z" />
          <circle cx={12} cy={12} r={3} />
        </>
      ) : (
        <>
          {/* Augenkontur, gedimmt, plus diagonaler Strich. */}
          <path
            d="M1.5 12S5 5 12 5s10.5 7 10.5 7-3.5 7-10.5 7S1.5 12 1.5 12Z"
            opacity={0.45}
          />
          <circle cx={12} cy={12} r={3} opacity={0.45} />
          <line x1={3} y1={3} x2={21} y2={21} />
        </>
      )}
    </svg>
  );
}
