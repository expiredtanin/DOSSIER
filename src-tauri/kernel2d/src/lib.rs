// kernel2d — 2D-Geometrie-Kern von Dossier (Offset/Trim/Extend/Fillet/Fase/Split/
// Join/Bruch, auch mit Bogen-Segmenten), dazu reine Geometrie aus room/ceiling/
// roomArea/stair/opening. Handgeschriebene f64-Mathematik, KEINE externen
// Geometrie-Crates. Ursprünglich als bitnaher Port von `src/geometry/kernel2d.ts`
// entstanden; seit der Umstellung auf den Rust-Kern ist DIESE Fassung die
// produktive: `dossier-core` bindet das Crate als Pfad-Abhängigkeit ein
// (`src-tauri/core/src/web/kernel2d.rs`), `kernel2d.ts` ist nur noch die Fassade.
// Die Bogen-Varianten liegen in `bulge.rs`.
//
// Numerische Regeln (aus der Paritaet mit der frueheren TS-Fassung, gelten weiter):
//   - `len` = Math.hypot → `f64::hypot` (NICHT (x²+y²).sqrt()).
//   - `normalize` Null-Guard: `len || 1` → `if l==0.0 {1.0} else {l}` (Ergebnis
//     {0,0}, kein NaN).
//   - Zwei Epsilons: EPS=1e-7 (kernel2d) UND hartkodiert 1e-9 in lineIntersect.
//   - Term-Reihenfolge in cross/signedArea/Diskriminante exakt beibehalten
//     (f64 nicht assoziativ; kein Kahan/Reorder).


mod bulge;
pub use bulge::*;

// Teile ([164] aus einer Datei aufgeteilt): Vektoren, Schnitte, Offset, Fillet, Trim/Split/Join, Umriss, Treppen, Räume, Öffnung.
mod vec;
mod intersect;
mod offset;
mod fillet;
mod trim;
mod outline;
mod stairs;
mod rooms;
mod opening;
pub use vec::*;
pub use intersect::*;
pub use offset::*;
pub use fillet::*;
pub use trim::*;
pub use outline::*;
pub use stairs::*;
pub use rooms::*;
pub use opening::*;

#[cfg(test)]
mod tests;
