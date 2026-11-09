//! Hilfstypen des IFC-Schreibers (Rahmen, Treppenläufe, Typ-Zuordnungen, Eigenschaftssätze, Mengen-Sammler); gerufen von `reader.rs` und `builder.rs`.
//! Teil von `ifc_export` (aus `ifc_export.rs` aufgeteilt, [164]).

use super::*;

/// Ein Körper einer Tür/eines Fensters (Welt-XY-Profil, Unterkante ab Öffnungs-UK; `ifc_openings.rs`).
pub(super) type Part = FillPart;

/// Farbe und Durchsichtigkeit je Teilrolle (wie `PART_RGB` im 3D: Rahmen hellgrau, Blatt warm, Glas bläulich).
pub(super) const PART_STYLES: [(&str, [f64; 3], f64); 3] = [
    ("Rahmen", [0.85, 0.85, 0.83], 0.0),
    ("Türblatt", [0.93, 0.90, 0.85], 0.0),
    ("Glas", [0.62, 0.76, 0.85], 0.6),
];

/// Lokales Wand-/Füllungssystem in Welt-XY: Ursprung und Richtung der X-Achse (Y = linke Normale).
#[derive(Clone, Copy)]
pub(super) struct Frame {
    pub(super) ox: f64,
    pub(super) oy: f64,
    pub(super) ux: f64,
    pub(super) uy: f64,
}

impl Frame {
    /// Identität (Welt-Koordinaten).
    pub(super) const WORLD: Frame = Frame { ox: 0.0, oy: 0.0, ux: 1.0, uy: 0.0 };

    pub(super) fn is_world(&self) -> bool {
        self.ox == 0.0 && self.oy == 0.0 && self.ux == 1.0 && self.uy == 0.0
    }

    /// Welt-XY → lokal (X = u, Y = linke Normale (−uy, ux)).
    fn local(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = (x - self.ox, y - self.oy);
        (dx * self.ux + dy * self.uy, -dx * self.uy + dy * self.ux)
    }

    pub(super) fn local_pts(&self, pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
        pts.iter().map(|&(x, y)| self.local(x, y)).collect()
    }

    /// Dieses System (in Welt-XY) im System `parent` ausgedrückt: Ursprung abbilden, Richtung nur drehen.
    pub(super) fn relative_to(&self, parent: &Frame) -> Frame {
        let (ox, oy) = parent.local(self.ox, self.oy);
        Frame { ox, oy, ux: self.ux * parent.ux + self.uy * parent.uy, uy: -self.ux * parent.uy + self.uy * parent.ux }
    }
}

pub(super) struct Mesh {
    pub(super) positions: Vec<f64>,
    pub(super) indices: Vec<usize>,
    pub(super) closed: bool,
}

pub(super) enum FlightShape {
    /// Prismen (Profil in Welt-XY, Unterkante relativ zum Geschoss, Tiefe).
    Solids(Vec<(Vec<(f64, f64)>, f64, f64)>),
    Mesh(Mesh),
}

pub(super) struct StairFlight {
    pub(super) name: String,
    pub(super) risers: usize,
    pub(super) treads: usize,
    pub(super) riser_height: f64,
    pub(super) tread_length: f64,
    pub(super) predefined: String,
    pub(super) psets: Vec<Pset>,
    pub(super) shape: FlightShape,
}

pub(super) struct StairLanding {
    pub(super) name: String,
    pub(super) pts: Vec<(f64, f64)>,
    pub(super) z_rel: f64,
    pub(super) depth: f64,
    pub(super) psets: Vec<Pset>,
}

pub(super) struct StairRail {
    pub(super) name: String,
    pub(super) predefined: String,
    pub(super) psets: Vec<Pset>,
    pub(super) mesh: Mesh,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum TypeKind {
    Wall,
    Slab,
    Roof,
}

impl TypeKind {
    pub(super) fn ifc(self) -> &'static str {
        match self {
            TypeKind::Wall => "IFCWALLTYPE",
            TypeKind::Slab => "IFCSLABTYPE",
            TypeKind::Roof => "IFCROOFTYPE",
        }
    }
}

pub(super) struct Layer {
    pub(super) component_id: String,
    pub(super) component_name: String,
    pub(super) thickness: f64,
}

pub(super) struct TypeRef {
    pub(super) kind: TypeKind,
    pub(super) id: String,
    pub(super) name: String,
    pub(super) predefined: String,
    pub(super) layers: Vec<Layer>,
}

pub(super) enum PropVal {
    Ident(String),
    Bool(bool),
    Ratio(f64),
    Label(String),
    Thermal(f64),
    /// Basismengen (`Qto_…`): Länge, Fläche, Volumen.
    Length(f64),
    Area(f64),
    Volume(f64),
}

impl PropVal {
    /// IFC-Wert-Ausdruck, z. B. `IFCIDENTIFIER('…')`.
    pub(super) fn expr(&self) -> String {
        match self {
            PropVal::Ident(s) => format!("IFCIDENTIFIER({})", ifc_string(s)),
            PropVal::Bool(b) => format!("IFCBOOLEAN({})", if *b { ".T." } else { ".F." }),
            PropVal::Ratio(r) => format!("IFCPOSITIVERATIOMEASURE({})", fmt_real(*r)),
            PropVal::Label(s) => format!("IFCLABEL({})", ifc_string(s)),
            PropVal::Thermal(u) => format!("IFCTHERMALTRANSMITTANCEMEASURE({})", fmt_real(*u)),
            PropVal::Length(_) | PropVal::Area(_) | PropVal::Volume(_) => String::new(),
        }
    }

    /// Mengen-Entität und Wert (nur Basismengen), sonst `None`.
    pub(super) fn quantity(&self) -> Option<(&'static str, f64)> {
        match self {
            PropVal::Length(v) => Some(("IFCQUANTITYLENGTH", *v)),
            PropVal::Area(v) => Some(("IFCQUANTITYAREA", *v)),
            PropVal::Volume(v) => Some(("IFCQUANTITYVOLUME", *v)),
            _ => None,
        }
    }
}

pub(super) struct Pset {
    pub(super) name: String,
    pub(super) props: Vec<(String, PropVal)>,
}

// ── Schreiber ───────────────────────────────────────────────────────────────

pub(super) struct Storey {
    pub(super) id: String,
    pub(super) entity: usize,
    pub(super) placement: usize,
}

pub(super) struct PsetAcc {
    pub(super) name: String,
    pub(super) key: String,
    pub(super) props: Vec<(String, String)>,
    pub(super) related: Vec<usize>,
}

/// Basismengen eines Bauteils (`Qto_…`), am Ende als IfcElementQuantity geschrieben.
pub(super) struct QtoAcc {
    /// Schlüssel des Bauteils (wie für seine GlobalId) — Grundlage der dauerhaften GUIDs.
    pub(super) owner_key: String,
    pub(super) name: String,
    pub(super) quantities: Vec<(&'static str, String, f64)>,
    pub(super) element: usize,
}

pub(super) struct TypeAcc {
    pub(super) key: String,
    pub(super) type_id: usize,
    /// IfcMaterialLayerSet des Typs (0 = keiner) für die LayerSetUsage der Exemplare.
    pub(super) layer_set: usize,
    pub(super) occurrences: Vec<usize>,
}
