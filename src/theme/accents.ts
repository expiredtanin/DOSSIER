// Accent-Farbpalette (Schnellauswahl) für einstellbare UI-Akzente wie den
// Auswahlrahmen (Marquee) oder die Snap-/Endpunkt-Hervorhebung im Grundriss.
// Zehn benannte Töne (japanische Wörter, wie im HANDOVER-Backlog vorgesehen);
// jede Einstellung bleibt trotzdem ein FREIER Farbpicker — diese Liste liefert
// nur die Schnellauswahl-Buttons daneben.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

/** Ein Akzent-Farbton der Schnellauswahl-Palette. */
export interface AccentSwatch {
  /** Stabiler Schlüssel (React-key, Vergleich). */
  id: string;
  /** Anzeigename (japanisch, wie im Backlog benannt). */
  name: string;
  /** Hex-Farbwert. */
  hex: string;
}

/**
 * Die zehn benannten Akzenttöne. Reihenfolge wie im HANDOVER-Backlog genannt.
 * Nur `yuyake` hat einen vom Nutzer vorgegebenen Wert (#CEB188); die übrigen
 * sind plausible, klar unterscheidbare Töne passend zum Namen — bei Bedarf
 * später anpassbar, ohne dass Aufrufer sich ändern (Verweis über `id`).
 */
export const ACCENT_SWATCHES: AccentSwatch[] = [
  { id: "ajisai", name: "Ajisai", hex: "#7C86C4" }, // 紫陽花 Hortensie — Blau-Violett
  { id: "sakura", name: "Sakura", hex: "#E3A8B8" }, // 桜 Kirschblüte — zartes Rosa
  { id: "suna", name: "Suna", hex: "#CBB994" }, // 砂 Sand — helles Beige
  { id: "ichigo", name: "Ichigo", hex: "#C2485C" }, // 苺 Erdbeere — Rot
  { id: "yuyake", name: "Yuyake", hex: "#CEB188" }, // 夕焼け Abendrot — warmes Gold-Beige
  { id: "sora", name: "Sora", hex: "#5FA1C9" }, // 空 Himmel — kühles Blau
  { id: "kusa", name: "Kusa", hex: "#7FA65A" }, // 草 Gras — Grün
  { id: "kori", name: "Kori", hex: "#A8D4D8" }, // 氷 Eis — blasses Zyan
  { id: "amagumo", name: "Amagumo", hex: "#6E7C8C" }, // 雨雲 Regenwolke — Blaugrau
  { id: "yuki", name: "Yuki", hex: "#E7E5DE" }, // 雪 Schnee — nahezu Weiss
];

/** Auswahlrahmen-Default (Marquee, 2D-Planansicht): Akzent „Yuyake". */
export const DEFAULT_MARQUEE_COLOR = "#CEB188";

/**
 * Snap-/Endpunkt-Default: Akzent „Sora" (#5FA1C9). Vom Nutzer als endgültiger
 * Default festgelegt (2026-07-04) — die frühere „aki"-Rückfrage ist damit
 * geschlossen. Bewusst ein kühler, heller Ton: hebt sich klar vom warmen
 * Yuyake-Auswahlrahmen UND von den meist neutral-dunklen Wand-/Linienfarben ab,
 * bleibt aber (anders als das sehr blasse Kori) auch auf hellem
 * Papier-Hintergrund gut sichtbar. Per Picker im Einstellungs-Fenster änderbar.
 */
export const DEFAULT_SNAP_COLOR = "#5FA1C9";

/** Liefert einen Swatch nach `id`, oder `undefined`. */
export function findAccentSwatch(id: string): AccentSwatch | undefined {
  return ACCENT_SWATCHES.find((s) => s.id === id);
}
