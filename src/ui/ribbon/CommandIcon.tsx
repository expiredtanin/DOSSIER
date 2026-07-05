// Kleine Inline-SVG-Glyphen für Befehls-Ribbon-Elemente (Ändern-Gruppe u. a.),
// die keine ToolId haben und daher nicht über `ToolIcon` abgedeckt sind. Gleicher
// Stil wie `ToolIcon` (~16×16, stroke=currentColor, fill=none), damit das Icon
// die Textfarbe der Zeile übernimmt. Unbekannte Namen → kein Icon (null).

const common = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CommandIcon({ name }: { name: string }) {
  switch (name) {
    case "move":
      // Vier-Wege-Verschiebepfeil.
      return (
        <svg {...common}>
          <line x1="8" y1="2.5" x2="8" y2="13.5" />
          <line x1="2.5" y1="8" x2="13.5" y2="8" />
          <polyline points="6,4.5 8,2.5 10,4.5" />
          <polyline points="6,11.5 8,13.5 10,11.5" />
          <polyline points="4.5,6 2.5,8 4.5,10" />
          <polyline points="11.5,6 13.5,8 11.5,10" />
        </svg>
      );
    case "copy":
      // Zwei überlappende Rechtecke (Duplikat).
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="8" height="8" />
          <rect x="5.5" y="5.5" width="8" height="8" />
        </svg>
      );
    case "mirror":
      // Spiegelachse (gestrichelt) mit zwei gespiegelten Dreiecken.
      return (
        <svg {...common}>
          <line x1="8" y1="2" x2="8" y2="14" strokeDasharray="1.6 1.6" />
          <path d="M6.5 4 L2.5 8 L6.5 12 Z" />
          <path d="M9.5 4 L13.5 8 L9.5 12 Z" />
        </svg>
      );
    case "offset":
      // Zwei parallele Winkel (Ursprung + Versatz).
      return (
        <svg {...common}>
          <polyline points="3,12 3,4 11,4" />
          <polyline points="6,12 6,7 14,7" />
        </svg>
      );
    case "trim":
      // Schere (Stutzen).
      return (
        <svg {...common}>
          <line x1="13.5" y1="3" x2="6.5" y2="9" />
          <circle cx="4" cy="11" r="2" />
          <line x1="13.5" y1="13" x2="6.5" y2="7" />
          <circle cx="4" cy="5" r="2" />
        </svg>
      );
    case "join":
      // Zwei Segmente, die sich an einer Ecke treffen (Verbinden).
      return (
        <svg {...common}>
          <polyline points="2.5,13 8,13 8,3" />
          <circle cx="8" cy="13" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}
