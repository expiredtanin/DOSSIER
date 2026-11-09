//! Öffnungs-Geometrie (Punkt entlang einer Strecke, `along`); gerufen von Öffnungs- und Wandlogik.
//! Teil von `kernel2d` (aus `lib.rs` aufgeteilt, [164]; `lib.rs` re-exportiert alles).

use crate::*;

// --- Oeffnungs-Geometrie (Port von src/geometry/opening.ts, Slice 4) --------
// `Wall`/`Opening`/`Project`-Kopplung durch Vec2/number-Parameter ersetzt
// (PORT_PLAN §1 "Teilweise im Scope"): `thickness`/`refOffset` werden hier als
// bereits aufgeloeste Zahlen uebergeben (TS: `wallTypeThickness(getWallType(...))`
// bzw. `wallReferenceOffset(wall, total)` gegen ein `Project`). Nur
// `openingVerticalExtent` bleibt TS (haengt an `Project.drawingLevels` via
// `wallVerticalExtent`) und wird hier NICHT portiert.
//
// `DEG` (Grad→Radiant, Port des lokalen `DEG` in opening.ts) ist bereits als
// modul-weite Konstante aus dem stair-Slice vorhanden (identischer Wert).

/// Punkt entlang der Strecke p1→p2 im Abstand d vom Start (Port von `along`
/// aus src/model/geometry.ts).
pub fn along(p1: Vec2, p2: Vec2, d: f64) -> Vec2 {
    add(p1, scale(normalize(sub(p2, p1)), d))
}
