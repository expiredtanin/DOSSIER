// Konstanten der Bemassung (SIA 400 B.5.3). Die Geometrie (Masszahl-Lage `dim_text_frame`, Griffe der
// Kettenpunkte, der Masslinie und der Masszahlen) rechnet der Rust-Kern — für Plan und Griffe dieselbe
// Funktion (`plan/drawings.rs`, `grips.rs`), sonst drifteten Masszahl und Masszahl-Griff auseinander.
//
// EINHEITEN: die Bemassungs-Feinheiten sind PAPIER-MILLIMETER (so denkt die Zeichnungsnorm: „Überstand
// 2 mm", unabhängig vom Massstab). Umgerechnet wird mit dem Massstab des jeweiligen Plans; der Plan wird
// je Ziel (Bildschirm, Layout-Viewport) EIGENS erzeugt (s. `LayoutSheet.tsx`), der Massstab ist zur
// Erzeugungszeit also bekannt und eindeutig.

/**
 * Defaults in PAPIER-MILLIMETERN (übliche Zeichnungswerte; entsprechen bei
 * 1:50 genau den früheren festen Modellwerten 0.05/0.05/0.15/0.2 m).
 */
export const DIM_DEFAULTS_MM = {
  gap: 1,
  overshoot: 1,
  tickLen: 3,
  textHeight: 4,
} as const;

/** Default-Grösse der Linienenden (Pfeil, Punkt, …) in Papier-Millimetern (wie im Kern). */
export const END_MARK_DEFAULT_SIZE_MM = 3;

/** Standard-Massstab, wenn ein Aufrufer keinen mitgibt (1:100, üblichster Planmassstab). */
export const DEFAULT_SCALE_DENOMINATOR = 100;
