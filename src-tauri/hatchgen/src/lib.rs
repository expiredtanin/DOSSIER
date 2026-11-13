//! Schraffur-Generator ([109]): `hatch` (Linien-, Schicht-, Streumuster), `jsnum`/`jsmath` (JS-Zahlsemantik);
//! `section_dominance` (Schnitt-Dominanz der Schnittbänder, [125]), `ugrid` (Bereichs-Vorauswahl) und `mesh_normals`
//! (geteilte Ecken-Normalen, [T4]/[201]: 3D-Anzeige und glTF/OBJ-Export in `fileio`).
//! Gemeinsam genutzt von `dossier-core` (Re-Export unter `crate::hatch` usw.) und `render3d` (Live-Schnitt).

pub mod ear_clip;
pub mod hatch;
pub mod jsmath;
pub mod jsnum;
pub mod mesh_normals;
pub mod section_dominance;
pub mod ugrid;
