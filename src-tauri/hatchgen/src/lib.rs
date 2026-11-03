//! Schraffur-Generator ([109]): `hatch` (Linien-, Schicht-, Streumuster), `jsnum`/`jsmath` (JS-Zahlsemantik);
//! `section_dominance` (Schnitt-Dominanz der Schnittbänder, [125]) und `ugrid` (Bereichs-Vorauswahl).
//! Gemeinsam genutzt von `dossier-core` (Re-Export unter `crate::hatch` usw.) und `render3d` (Live-Schnitt).

pub mod hatch;
pub mod jsmath;
pub mod jsnum;
pub mod section_dominance;
pub mod ugrid;
