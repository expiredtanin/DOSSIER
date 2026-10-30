//! U-Wert aus dem Schichtaufbau ([71], SIA 180 / EN ISO 6946): R = Rsi + Σ d/λ + Rse, U = 1/R.
//! λ je Bauteil (`Component.lambda`, Standards [100]). Übergangswiderstände nach Wärmestromrichtung:
//! Wand waagrecht 0.13/0.04, Dach aufwärts 0.10/0.04, Decke abwärts 0.17/0.04. Hinterlüftete Luftschicht:
//! Schichten ausserhalb zählen nicht, Rse = Rsi der Aussenseite. Nicht hinterlüftete Luftschicht: R nach
//! Dicke (ISO 6946 Tab. 2, waagrecht/aufwärts/abwärts). Schicht ohne λ ⇒ Wert unvollständig (`u = None`).
//! Homogen gerechnet: das Modell hat kein Flächenanteil-Feld für ungleichartige Schichten (Holzständer + Dämmung).
//! Dazu die Bauteilliste (Wände, Decken, Dächer mit Typ, Fläche, U-Wert) für Tabelle, CSV und Blatt.

use crate::model::*;
use serde::Serialize;

/// Bauteilart (bestimmt Wärmestromrichtung und Übergangswiderstände).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Wall,
    Ceiling,
    Roof,
}

impl Kind {
    /// (Rsi, Rse) in m²K/W.
    pub fn surface_resistances(self) -> (f64, f64) {
        match self {
            Kind::Wall => (0.13, 0.04),
            Kind::Roof => (0.10, 0.04),
            Kind::Ceiling => (0.17, 0.04),
        }
    }
    /// Liegt die Aussenseite am Listenanfang (Wand, Dach: aussen → innen) oder am Ende (Decke: oben → unten)?
    fn outside_first(self) -> bool {
        self != Kind::Ceiling
    }
}

/// Ergebnis der Rechnung.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UValue {
    /// Gesamtwiderstand R in m²K/W (nur die Schichten mit λ; bei `complete == false` Teilsumme).
    pub r: f64,
    /// U in W/(m²K); `None` solange eine Schicht ohne λ ist.
    pub u: Option<f64>,
    pub complete: bool,
    /// Anzahl der Schichten ohne λ.
    pub missing: usize,
    /// Eine hinterlüftete Schicht kappt den Aufbau (Aussenseite zählt nicht).
    pub ventilated: bool,
}

/// Luftschicht? (Standard-Luftschicht oder Name mit „Luft“.)
fn is_air(c: &Component) -> bool {
    c.standard_id.as_deref() == Some("std-c-luft") || c.name.to_lowercase().contains("luft")
}

/// Hinterlüftet: Standard-Luftschicht oder Name mit „hinterl“.
fn is_ventilated(c: &Component) -> bool {
    c.standard_id.as_deref() == Some("std-c-luft") || c.name.to_lowercase().contains("hinterl")
}

/// R einer ruhenden Luftschicht (ISO 6946 Tab. 2) nach Dicke und Richtung.
fn still_air_r(d: f64, kind: Kind) -> f64 {
    // Stützstellen (mm): 0, 5, 7, 10, 15, 25, 50, 100, 300; waagrecht / aufwärts / abwärts.
    const T: [(f64, f64, f64, f64); 9] = [
        (0.0, 0.0, 0.0, 0.0),
        (5.0, 0.11, 0.11, 0.11),
        (7.0, 0.13, 0.13, 0.13),
        (10.0, 0.15, 0.15, 0.15),
        (15.0, 0.17, 0.16, 0.17),
        (25.0, 0.18, 0.16, 0.19),
        (50.0, 0.18, 0.16, 0.21),
        (100.0, 0.18, 0.16, 0.22),
        (300.0, 0.18, 0.16, 0.23),
    ];
    let pick = |t: &(f64, f64, f64, f64)| match kind {
        Kind::Wall => t.1,
        Kind::Roof => t.2,
        Kind::Ceiling => t.3,
    };
    let mm = d * 1000.0;
    for w in T.windows(2) {
        if mm <= w[1].0 {
            let f = (mm - w[0].0) / (w[1].0 - w[0].0);
            return pick(&w[0]) + f * (pick(&w[1]) - pick(&w[0]));
        }
    }
    pick(&T[8])
}

/// U-Wert eines Schichtaufbaus (Reihenfolge wie im Typ: Wand/Dach aussen → innen, Decke oben → unten).
pub fn u_value(p: &Project, layers: &[Layer], kind: Kind) -> UValue {
    let (rsi, mut rse) = kind.surface_resistances();
    let mut list: Vec<&Layer> = layers.iter().filter(|l| l.thickness > 0.0).collect();
    if !kind.outside_first() {
        list.reverse(); // intern immer aussen → innen
    }
    // Letzte hinterlüftete Schicht (am weitesten innen): alles aussen davon zählt nicht.
    let mut ventilated = false;
    if let Some(i) = list.iter().rposition(|l| p.component(&l.component_id).is_some_and(is_ventilated)) {
        list.drain(..=i);
        rse = rsi;
        ventilated = true;
    }
    let mut r = rsi + rse;
    let mut missing = 0;
    for l in &list {
        let c = p.component(&l.component_id);
        match c.and_then(|c| c.lambda).filter(|x| *x > 0.0) {
            Some(lam) => r += l.thickness / lam,
            None if c.is_some_and(is_air) => r += still_air_r(l.thickness, kind),
            None => missing += 1,
        }
    }
    let complete = missing == 0 && r > 0.0;
    UValue { r, u: complete.then(|| 1.0 / r), complete, missing, ventilated }
}

/// Abfrage `uValue`: `text` = JSON `{"kind": "wall"|"ceiling"|"roof", "typeId": …}` oder `{"kind", "layers": [Layer…]}`.
/// Ergebnis: [`UValue`] oder `null` (unbekannter Typ).
pub fn query(p: &Project, text: &str) -> Option<UValue> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let kind = match v["kind"].as_str()? {
        "wall" => Kind::Wall,
        "ceiling" => Kind::Ceiling,
        "roof" => Kind::Roof,
        _ => return None,
    };
    if v["layers"].is_array() {
        let layers: Vec<Layer> = serde_json::from_value(v["layers"].clone()).ok()?;
        return Some(u_value(p, &layers, kind));
    }
    let id = v["typeId"].as_str()?;
    let layers: &[Layer] = match kind {
        Kind::Wall => &p.wall_types.iter().find(|t| t.id == id)?.layers,
        Kind::Ceiling => match p.ceiling_types.as_deref().and_then(|l| l.iter().find(|t| t.id == id)) {
            Some(t) => &t.layers,
            None => &p.wall_types.iter().find(|t| t.id == id)?.layers,
        },
        Kind::Roof => &p.roof_types.as_deref()?.iter().find(|t| t.id == id)?.layers,
    };
    Some(u_value(p, layers, kind))
}

pub fn wall_u_value(p: &Project, w: &Wall) -> Option<UValue> {
    p.wall_type(w).map(|t| u_value(p, &t.layers, Kind::Wall))
}

pub fn ceiling_u_value(p: &Project, c: &Ceiling) -> Option<UValue> {
    crate::model3d::ceiling_type_ref(p, c).map(|(_, _, layers)| u_value(p, layers, Kind::Ceiling))
}

pub fn roof_type_of<'a>(p: &'a Project, r: &Roof) -> Option<&'a RoofType> {
    let id = r.roof_type_id.as_deref().filter(|s| !s.is_empty())?;
    p.roof_types.as_deref()?.iter().find(|t| t.id == id)
}

pub fn roof_u_value(p: &Project, r: &Roof) -> Option<UValue> {
    roof_type_of(p, r).map(|t| u_value(p, &t.layers, Kind::Roof))
}

/// Eine Zeile der Bauteilliste (JSON-Form: `ElementScheduleRow` in TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRow {
    pub kind: Kind,
    pub id: String,
    pub type_name: String,
    pub floor: String,
    pub floor_id: String,
    /// Fläche in m² (Wand: Länge × Höhe abzüglich Öffnungen; Decke: Umriss abzüglich Aussparungen;
    /// Dach: geneigte Fläche).
    pub area: f64,
    pub thickness: f64,
    pub u: Option<f64>,
    /// `false` = Schicht ohne λ oder kein Aufbau.
    pub complete: bool,
    pub external: Option<bool>,
}

fn level_name(p: &Project, id: &str) -> String {
    p.floor(id).map_or(id.to_string(), |f| f.name.clone())
}

/// Wände, Decken und Dächer: je Geschoss (Ebenen-Reihenfolge), Wände vor Decken vor Dächern.
pub fn element_schedule(p: &Project) -> Vec<ElementRow> {
    let mut rows = Vec::new();
    let openings = p.openings.as_deref().unwrap_or(&[]);
    for w in &p.walls {
        let len = match crate::wall_arc::WallArc::of_wall(w) {
            Some(a) => a.length(),
            None => crate::jsmath::hypot2(w.end.x - w.start.x, w.end.y - w.start.y),
        };
        let holes: f64 = openings.iter().filter(|o| o.host_wall_id == w.id && o.host_roof_id.is_none()).map(|o| o.width * o.height).sum();
        let uv = wall_u_value(p, w);
        rows.push(ElementRow {
            kind: Kind::Wall,
            id: w.id.clone(),
            type_name: p.wall_type(w).map(|t| t.name.clone()).unwrap_or_default(),
            floor: level_name(p, &w.floor_id),
            floor_id: w.floor_id.clone(),
            area: (len * w.height - holes).max(0.0),
            thickness: p.wall_type(w).map_or(0.0, |t| Project::type_thickness(&t.layers)),
            u: uv.as_ref().and_then(|x| x.u),
            complete: uv.as_ref().is_some_and(|x| x.complete),
            external: w.is_external,
        });
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        if c.outline.len() < 3 {
            continue;
        }
        let holes: f64 = c.openings.iter().flatten().map(|h| crate::ifc_quantities::ring_area(h)).sum();
        let uv = ceiling_u_value(p, c);
        let tref = crate::model3d::ceiling_type_ref(p, c);
        rows.push(ElementRow {
            kind: Kind::Ceiling,
            id: c.id.clone(),
            type_name: tref.map(|(_, n, _)| n.to_string()).unwrap_or_default(),
            floor: level_name(p, &c.floor_id),
            floor_id: c.floor_id.clone(),
            area: (crate::ifc_quantities::ring_area(&c.outline) - holes).max(0.0),
            thickness: tref.map_or(c.thickness.unwrap_or(0.0), |(_, _, l)| Project::type_thickness(l)),
            u: uv.as_ref().and_then(|x| x.u),
            complete: uv.as_ref().is_some_and(|x| x.complete),
            external: c.is_external,
        });
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let planes = crate::roof::roof_geometry(&r.params(), p.roof_base_elevation(r)).planes;
        let area = crate::ifc_quantities::roof_quantities(&planes).first().map_or(0.0, |q| q.value);
        let uv = roof_u_value(p, r);
        let t = roof_type_of(p, r);
        rows.push(ElementRow {
            kind: Kind::Roof,
            id: r.id.clone(),
            type_name: t.map(|t| t.name.clone()).unwrap_or_default(),
            floor: level_name(p, &r.floor_id),
            floor_id: r.floor_id.clone(),
            area,
            thickness: t.map_or(0.0, |t| Project::type_thickness(&t.layers)),
            u: uv.as_ref().and_then(|x| x.u),
            complete: uv.as_ref().is_some_and(|x| x.complete),
            external: Some(true),
        });
    }
    let level_index = |id: &str| p.drawing_levels.iter().position(|l| l.id == id).unwrap_or(usize::MAX);
    rows.sort_by_key(|r| (level_index(&r.floor_id), r.kind as u8));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn std_project() -> Project {
        let mut p = Project::default();
        for (key, list) in crate::standards::library() {
            let v = serde_json::Value::Array(list);
            match key {
                "components" => p.components = serde_json::from_value(v).unwrap(),
                "wallTypes" => p.wall_types = serde_json::from_value(v).unwrap(),
                "ceilingTypes" => p.ceiling_types = Some(serde_json::from_value(v).unwrap()),
                "roofTypes" => p.roof_types = Some(serde_json::from_value(v).unwrap()),
                _ => {}
            }
        }
        p
    }

    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    fn comp(p: &Project, std: &str) -> f64 {
        p.components.iter().find(|c| c.standard_id.as_deref() == Some(std) || c.id == std).and_then(|c| c.lambda).unwrap()
    }

    #[test]
    fn aussenwand_kompakt() {
        let p = std_project();
        let t = p.wall_types.iter().find(|t| t.id == "std-wt-aw-kompakt").unwrap();
        let r = 0.13 + 0.04 + 0.02 / comp(&p, "std-c-aussenputz") + 0.18 / comp(&p, "std-c-eps") + 0.175 / comp(&p, "std-c-backstein") + 0.015 / comp(&p, "std-c-innenputz");
        let u = u_value(&p, &t.layers, Kind::Wall);
        assert!(u.complete && !u.ventilated);
        near(u.r, r);
        near(u.u.unwrap(), 1.0 / r);
        assert!(u.u.unwrap() > 0.15 && u.u.unwrap() < 0.25, "plausibel: {:?}", u.u);
    }

    #[test]
    fn innenwand_backstein() {
        let p = std_project();
        let t = p.wall_types.iter().find(|t| t.id == "std-wt-iw-backstein").unwrap();
        let r = 0.17 + 0.02 / comp(&p, "std-c-innenputz") + 0.125 / comp(&p, "std-c-backstein");
        near(u_value(&p, &t.layers, Kind::Wall).r, r);
    }

    /// Hinterlüftet: Lattung und Luft zählen nicht, Rse = Rsi = 0.13.
    #[test]
    fn holzstaenderwand_hinterlueftet() {
        let p = std_project();
        let t = p.wall_types.iter().find(|t| t.id == "std-wt-holzstaender").unwrap();
        let r = 0.26 + 0.06 / comp(&p, "std-c-holzfaser") + 0.2 / comp(&p, "std-c-mineralwolle") + 0.015 / comp(&p, "std-c-holzwerkstoff") + 0.0125 / comp(&p, "std-c-gipskarton");
        let u = u_value(&p, &t.layers, Kind::Wall);
        assert!(u.ventilated);
        near(u.r, r);
    }

    /// Decke oben → unten, abwärts 0.17/0.04.
    #[test]
    fn stahlbetondecke() {
        let p = std_project();
        let t = &p.ceiling_types.as_ref().unwrap()[0];
        let r = 0.21 + 0.08 / comp(&p, "std-c-zementestrich") + 0.04 / comp(&p, "std-c-trittschall") + 0.24 / comp(&p, "std-c-stahlbeton") + 0.01 / comp(&p, "std-c-innenputz");
        near(u_value(&p, &t.layers, Kind::Ceiling).r, r);
    }

    /// Dach aufwärts 0.10/0.04 → hinterlüftet: 0.20, Ziegel und Luft fallen weg.
    #[test]
    fn steildach_holz() {
        let p = std_project();
        let t = &p.roof_types.as_ref().unwrap()[0];
        let r = 0.20 + 0.06 / comp(&p, "std-c-holzfaser") + 0.22 / comp(&p, "std-c-mineralwolle") + 0.015 / comp(&p, "std-c-holzwerkstoff") + 0.0125 / comp(&p, "std-c-gipskarton");
        let u = u_value(&p, &t.layers, Kind::Roof);
        near(u.r, r);
        assert!(u.u.unwrap() < 0.25);
    }

    #[test]
    fn handgerechnet_beton_daemmung() {
        let mut p = Project::default();
        p.components = vec![
            Component { id: "b".into(), lambda: Some(2.3), ..Default::default() },
            Component { id: "d".into(), lambda: Some(0.035), ..Default::default() },
        ];
        let l = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
        let u = u_value(&p, &[l("d", 0.16), l("b", 0.2)], Kind::Wall);
        near(u.r, 0.17 + 0.2 / 2.3 + 0.16 / 0.035);
        assert!((u.u.unwrap() - 0.2071).abs() < 1e-3);
    }

    #[test]
    fn ohne_lambda_ist_unvollstaendig() {
        let mut p = Project::default();
        p.components = vec![Component { id: "b".into(), lambda: Some(2.3), ..Default::default() }, Component { id: "x".into(), ..Default::default() }];
        let l = |c: &str, t: f64| Layer { component_id: c.into(), thickness: t, ..Default::default() };
        let u = u_value(&p, &[l("x", 0.1), l("b", 0.2)], Kind::Wall);
        assert!(!u.complete && u.u.is_none());
        assert_eq!(u.missing, 1);
        // Unbekanntes Bauteil zählt ebenso.
        assert!(!u_value(&p, &[l("zz", 0.1)], Kind::Wall).complete);
    }

    #[test]
    fn ruhende_luftschicht() {
        let mut p = Project::default();
        p.components = vec![Component { id: "a".into(), name: "Luftschicht".into(), ..Default::default() }];
        let u = u_value(&p, &[Layer { component_id: "a".into(), thickness: 0.05, ..Default::default() }], Kind::Wall);
        assert!(u.complete && !u.ventilated);
        near(u.r, 0.17 + 0.18);
    }

    #[test]
    fn bauteilliste() {
        let mut p = std_project();
        p.drawing_levels.push(DrawingLevel { id: "eg".into(), name: "EG".into(), ..Default::default() });
        p.walls.push(Wall { id: "w".into(), floor_id: "eg".into(), start: Vec2 { x: 0.0, y: 0.0 }, end: Vec2 { x: 5.0, y: 0.0 }, wall_type_id: "std-wt-aw-kompakt".into(), height: 2.5, ..Default::default() });
        p.openings = Some(vec![Opening { id: "o".into(), host_wall_id: "w".into(), width: 1.0, height: 1.5, ..Default::default() }]);
        let rows = element_schedule(&p);
        assert_eq!(rows.len(), 1);
        near(rows[0].area, 12.5 - 1.5);
        assert!(rows[0].complete && rows[0].u.is_some());
    }
}
