//! Flächen und Stil-Übersteuerung der Ansicht: `Role`, `Face`, `SurfOv` und die Auflösung der Override-Regeln
//! je Fläche bzw. Öffnung ([33]). Gerufen von den übrigen Teilen der Ansicht (`mod.rs`, `collect.rs`, `openings.rs`).

use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum Role {
    Wall,
    Slab,
    Roof,
    /// Stütze ([132]): Prisma aus dem Querschnitt, Flächen wie eine Platte.
    Column,
    /// [152] Importiertes Netz (`ImportedMesh`): Dreiecke, id = Netz-id.
    Mesh,
}

pub(super) struct Face {
    pub(super) pts: Vec<Pt>,
    /// Tiefe je Ecke ([G4]).
    pub(super) pd: Vec<f64>,
    pub(super) depth: f64,
    pub(super) depth_min: f64,
    pub(super) depth_max: f64,
    pub(super) role: Role,
    pub(super) id: String,
    pub(super) fill: [f64; 3],
    pub(super) normal: [f64; 3],
    /// [33] Override-Regeln dieser Fläche (Bauteil + sichtbare Schicht); `None` = keine.
    pub(super) ov: Option<Rc<SurfOv>>,
    /// [152] Fläche eines offenen importierten Netzes (beidseitig, s. `hlr::Face::two_sided`).
    pub(super) two_sided: bool,
    /// [157] Facette einer gekrümmten Deckenstirn, um `SLAB_BEHIND_WALL` nach hinten gerückt.
    pub(super) curved_slab: bool,
}

/// [33] Override einer Ansichtsfläche bzw. Öffnung (`overrides::effective_surface`).
#[derive(Debug, Default)]
pub(super) struct SurfOv {
    pub(super) fill: Option<String>,
    /// Ansichtsschraffur weglassen (Schraffur „ohne“ oder eine Projekt-Schraffur auf der Fläche).
    pub(super) no_pattern: bool,
    /// Projekt-Schraffur auf der Fläche.
    pub(super) hatch: Option<super::super::prim::HatchRender>,
    /// Kanten der Fläche an/aus.
    pub(super) outline: Option<bool>,
    pub(super) color: Option<String>,
    pub(super) lineweight: Option<f64>,
    /// Linienstil der Regel (Strichmuster; `Some(None)` = durchgezogen).
    pub(super) dash: Option<Option<Vec<f64>>>,
    pub(super) hide: bool,
}

impl SurfOv {
    /// Linie in Regel-Farbe/-Stärke/-Linienstil.
    pub(super) fn restyle(&self, mut l: Primitive) -> Primitive {
        if let Primitive::Line { color, weight_mm, dash, .. } = &mut l {
            if let Some(c) = &self.color {
                *color = Some(c.clone().into());
            }
            if let Some(w) = self.lineweight {
                *weight_mm = w;
            }
            if let Some(d) = &self.dash {
                *dash = Some(d.clone());
            }
        }
        l
    }
}

/// [33] Aktionen für ein Bauteil (`kind`, Ebene `code`, Name) und — mit `li` — seine sichtbare Schicht.
fn surf_ov(p: &Project, v: RuleView, kind: &str, code: &str, name: Option<&str>, layers: &[Layer], li: Option<usize>) -> Option<Rc<SurfOv>> {
    use super::super::overrides as ovr;
    let mut s = Subject { layer_name: p.layer_category(code).map(|c| c.name.as_str()), layer_code: Some(code), object_name: name, element_kind: Some(kind), ..Default::default() };
    if let Some(i) = li.filter(|&i| i < layers.len()) {
        let l = &layers[i];
        let c = p.component_or_fallback(&l.component_id);
        s.layer_function = ovr::layer_function(p, l).and_then(ovr::function_key);
        s.layer_position = ovr::layer_positions(p, layers).get(i).copied();
        s.material_id = Some(c.id.as_str());
        s.material_standard = c.standard_id.as_deref();
        s.material_name = Some(c.name.as_str());
        s.material_category = Some(crate::standards::material_category(c));
    }
    let (el, ly, hide) = ovr::effective_surface(p.override_rules.as_deref(), &s, v);
    let (no_pattern, hatch) = match ly.hatch.as_deref() {
        None | Some("material") => (false, None),
        Some("none") => (true, None),
        Some(id) => super::super::style::resolve_hatch(p, id, None, None, None).map_or((false, None), |h| (true, Some(h))),
    };
    let dash = ovr::linetype_dash(p, el.linetype_id.as_deref());
    let o = SurfOv { fill: ly.fill_color, no_pattern, hatch, outline: ly.outline, color: el.color, lineweight: el.lineweight, dash, hide: hide == Some(true) };
    (o.fill.is_some() || o.no_pattern || o.outline.is_some() || o.color.is_some() || o.lineweight.is_some() || o.dash.is_some() || o.hide).then(|| Rc::new(o))
}

/// [33] Override-Regeln je Ansichtsfläche: Wand (Wandtyp, sichtbare Seite = äusserste bzw. innerste
/// Schicht), Decke/Bodenplatte, Treppe, Dach (Eindeckung = erste Schicht), Stütze. Ohne aktive Regel nichts.
pub(super) fn face_overrides(p: &Project, faces: &mut [Face], v: RuleView) {
    if !super::super::overrides::has_active(p, v) {
        return;
    }
    let mut memo: HashMap<(Role, String, Option<bool>), Option<Rc<SurfOv>>> = HashMap::new();
    for f in faces.iter_mut().filter(|f| !f.id.is_empty()) {
        let wall = if f.role == Role::Wall { p.walls.iter().find(|w| w.id == f.id) } else { None };
        let side = wall.and_then(|w| wall_side(w, f.normal));
        let key = (f.role, f.id.clone(), side);
        if let Some(o) = memo.get(&key) {
            f.ov = o.clone();
            continue;
        }
        let id = f.id.as_str();
        let o = match f.role {
            Role::Wall => wall.and_then(|w| {
                let wt = p.wall_type_or_fallback(w);
                let li = side.map(|outer| if outer { 0 } else { wt.layers.len().saturating_sub(1) });
                surf_ov(p, v, "wall", &w.category_code, Some(&wt.name), &wt.layers, li)
            }),
            Role::Slab => {
                if let Some(ce) = p.ceilings.as_deref().unwrap_or(&[]).iter().find(|c| c.id == id) {
                    let layers = model3d::ceiling_type_ref(p, ce).map_or(Project::fallback_layers(), |t| t.2);
                    let kind = if super::super::overrides::is_ground_slab(p, ce, layers) { "ground_slab" } else { "slab" };
                    surf_ov(p, v, kind, &ce.category_code, super::super::domains::ceiling_type_name(p, ce), layers, None)
                } else if let Some(st) = p.stairs.as_deref().unwrap_or(&[]).iter().find(|s| s.id == id) {
                    surf_ov(p, v, "stair", &st.category_code, Some(&super::super::stairs::stair_label(st)), &[], None)
                } else {
                    None
                }
            }
            Role::Roof => p.roofs.as_deref().unwrap_or(&[]).iter().find(|r| r.id == id).and_then(|r| {
                let layers = p.roof_layers(r);
                surf_ov(p, v, "roof", &r.category_code, None, &layers, Some(0))
            }),
            Role::Column => p.columns.as_deref().unwrap_or(&[]).iter().find(|c| c.id == id).and_then(|c| surf_ov(p, v, "column", &c.category_code, Some(&super::super::domains::column_label(c)), &[], None)),
            Role::Mesh => p.context.as_deref().unwrap_or(&[]).iter().find_map(|c| match c {
                ContextObject::ImportedMesh(m) if m.id == id => Some(m),
                _ => None,
            }).and_then(|m| surf_ov(p, v, super::super::section::MESH_KIND, &m.category_code, Some(&m.name), &[], None)),
        };
        memo.insert(key, o.clone());
        f.ov = o;
    }
}

/// [33] Override-Regeln einer Öffnung (Bauteilart „opening“, Name wie im Grundriss).
pub(super) fn opening_override(p: &Project, v: RuleView, id: &str) -> Option<Rc<SurfOv>> {
    let o = p.openings.as_deref().unwrap_or(&[]).iter().find(|o| o.id == id)?;
    surf_ov(p, v, "opening", &o.category_code, Some(&super::super::walls::opening_label(o)), &[], None)
}
