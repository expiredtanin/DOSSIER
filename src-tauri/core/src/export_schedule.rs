//! Bauteilliste ([K4] S2, vorher `src/export/exportSchedule.ts`): eine Zeile je Bauteil-Vorkommen
//! (Wand, Decke, Tür/Fenster, Treppe, Extrusion, Dach, Stütze) mit Kennwerten aus dem Modell, dazu
//! CSV-Ausgabe (RFC 4180, Feldtrenner `;`, Zeilenende CRLF) mit Aggregat je Bauteil-Typ.

use crate::js_fmt::to_fixed;
use crate::jsmath::hypot2;
use crate::jsnum::round;
use crate::model::*;
use serde::Serialize;

/// Eine ausgewertete Zeile (JSON-Form wie `ScheduleRow` in TS).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRow {
    pub kind: &'static str,
    pub id: String,
    pub type_name: String,
    pub floor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor_id: Option<String>,
    pub length: Option<f64>,
    pub height_m: Option<f64>,
    pub thickness: Option<f64>,
    pub area: Option<f64>,
}

fn polygon_area(pts: &[Vec2]) -> f64 {
    let flat: Vec<[f64; 2]> = pts.iter().map(|v| [v.x, v.y]).collect();
    crate::room_area::evaluate(&flat, 0.0).gross
}

fn floor_name(p: &Project, floor_id: &str) -> String {
    p.floor(floor_id).map_or(floor_id.to_string(), |f| f.name.clone())
}

/// Wertet ALLE Bauteil-Vorkommen aus: Wände, Decken, Öffnungen, Treppen, Extrusionen, Dächer, Stützen.
pub fn schedule_rows(p: &Project) -> Vec<ScheduleRow> {
    let mut rows = Vec::new();
    for w in &p.walls {
        let (type_name, thickness) = match p.wall_type(w) {
            Some(t) => (t.name.clone(), Project::type_thickness(&t.layers)),
            None => (w.wall_type_id.clone(), 0.0),
        };
        let length = hypot2(w.end.x - w.start.x, w.end.y - w.start.y);
        rows.push(ScheduleRow {
            kind: "Wand",
            id: w.id.clone(),
            type_name,
            floor: floor_name(p, &w.floor_id),
            floor_id: Some(w.floor_id.clone()),
            length: Some(length),
            height_m: Some(w.height),
            thickness: Some(thickness),
            area: Some(length * w.height),
        });
    }
    for c in p.ceilings.as_deref().unwrap_or(&[]) {
        let type_name = match crate::model3d::ceiling_type_ref(p, c) {
            Some((_, name, _)) => name.to_string(),
            None => c.ceiling_type_id.clone().unwrap_or_else(|| c.wall_type_id.clone()),
        };
        rows.push(ScheduleRow {
            kind: "Decke",
            id: c.id.clone(),
            type_name,
            floor: floor_name(p, &c.floor_id),
            floor_id: Some(c.floor_id.clone()),
            length: None,
            height_m: None,
            thickness: Some(p.ceiling_thickness(c)),
            area: Some(polygon_area(&c.outline)),
        });
    }
    for o in p.openings.as_deref().unwrap_or(&[]) {
        let kind = if o.kind == ElementKind::Window { "Fenster" } else { "Tür" };
        let host = p.walls.iter().find(|w| w.id == o.host_wall_id);
        rows.push(ScheduleRow {
            kind,
            id: o.id.clone(),
            type_name: kind.to_string(),
            floor: host.map_or(o.host_wall_id.clone(), |w| floor_name(p, &w.floor_id)),
            floor_id: host.map(|w| w.floor_id.clone()),
            length: Some(o.width),
            height_m: Some(o.height),
            thickness: None,
            area: Some(o.width * o.height),
        });
    }
    for s in p.stairs.as_deref().unwrap_or(&[]) {
        rows.push(ScheduleRow {
            kind: "Treppe",
            id: s.id.clone(),
            type_name: "Treppe".into(),
            floor: floor_name(p, &s.floor_id),
            floor_id: Some(s.floor_id.clone()),
            length: Some(s.run_length + s.run2_length.unwrap_or(0.0)),
            height_m: s.total_rise,
            thickness: None,
            area: None,
        });
    }
    for e in p.extruded_solids.as_deref().unwrap_or(&[]) {
        rows.push(ScheduleRow {
            kind: "Extrusion",
            id: e.id.clone(),
            type_name: "Extrusion".into(),
            floor: floor_name(p, &e.level_id),
            floor_id: Some(e.level_id.clone()),
            length: None,
            height_m: Some(e.height),
            thickness: None,
            area: Some(polygon_area(&e.points)),
        });
    }
    for r in p.roofs.as_deref().unwrap_or(&[]) {
        let mut type_name = r.roof_type_id.clone().unwrap_or_else(|| shape_name(r.shape).to_string());
        if let Some(rt) = r.roof_type_id.as_deref().and_then(|id| p.roof_types.as_deref()?.iter().find(|t| t.id == id)) {
            type_name = rt.name.clone();
        }
        rows.push(ScheduleRow {
            kind: "Dach",
            id: r.id.clone(),
            type_name,
            floor: floor_name(p, &r.floor_id),
            floor_id: Some(r.floor_id.clone()),
            length: None,
            height_m: None,
            thickness: Some(r.thickness),
            area: Some(polygon_area(&r.outline)),
        });
    }
    for c in p.columns.as_deref().unwrap_or(&[]) {
        let (type_name, length, thickness) = match &c.profile {
            ColumnProfile::Round { radius } => ("Rund", None, radius * 2.0),
            ColumnProfile::Rect { width, depth } => ("Rechteck", Some(*width), *depth),
        };
        rows.push(ScheduleRow {
            kind: "Stütze",
            id: c.id.clone(),
            type_name: type_name.into(),
            floor: floor_name(p, &c.floor_id),
            floor_id: Some(c.floor_id.clone()),
            length,
            height_m: Some(c.height),
            thickness: Some(thickness),
            area: None,
        });
    }
    rows
}

fn shape_name(s: RoofShape) -> &'static str {
    match s {
        RoofShape::Flach => "flach",
        RoofShape::Pult => "pult",
        RoofShape::Sattel => "sattel",
        RoofShape::Walm => "walm",
        RoofShape::Mansarde => "mansarde",
        RoofShape::Zelt => "zelt",
    }
}

/// Ein Feld CSV-sicher quoten: „…" bei , " \n \r ; — `"` wird verdoppelt.
fn csv_field(v: &str) -> String {
    if v.contains(['"', ',', '\n', '\r', ';']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// Zahl auf 2 Nachkommastellen, Punkt; leer bei `None`/nicht endlich.
fn fmt_num(v: Option<f64>) -> String {
    match v {
        Some(x) if x.is_finite() => to_fixed(round(x * 100.0) / 100.0, 2),
        _ => String::new(),
    }
}

struct Aggregate {
    kind: &'static str,
    type_name: String,
    count: usize,
    total_length: f64,
    total_area: f64,
}

/// Bauteilliste als CSV (`exportScheduleCsv`): Kopfzeile, eine Zeile je Bauteil, optional Aggregat.
pub fn export_schedule_csv(p: &Project, delimiter: &str, include_summary: bool) -> String {
    let rows = schedule_rows(p);
    let d = delimiter;
    let mut lines: Vec<String> = Vec::new();
    let header = ["Typ", "ID", "Bauteil", "Geschoss", "Länge [m]", "Höhe [m]", "Dicke [m]", "Fläche [m²]"];
    lines.push(header.iter().map(|h| csv_field(h)).collect::<Vec<_>>().join(d));
    for r in &rows {
        lines.push(
            [csv_field(r.kind), csv_field(&r.id), csv_field(&r.type_name), csv_field(&r.floor), fmt_num(r.length), fmt_num(r.height_m), fmt_num(r.thickness), fmt_num(r.area)].join(d),
        );
    }
    if include_summary && !rows.is_empty() {
        lines.push(String::new());
        lines.push([csv_field("Zusammenfassung (je Bauteil-Typ)"), "".into(), "".into(), "".into(), "".into(), "".into(), "".into(), "".into()].join(d));
        let mut aggs: Vec<Aggregate> = Vec::new();
        for r in &rows {
            let i = match aggs.iter().position(|a| a.kind == r.kind && a.type_name == r.type_name) {
                Some(i) => i,
                None => {
                    aggs.push(Aggregate { kind: r.kind, type_name: r.type_name.clone(), count: 0, total_length: 0.0, total_area: 0.0 });
                    aggs.len() - 1
                }
            };
            aggs[i].count += 1;
            aggs[i].total_length += r.length.unwrap_or(0.0);
            aggs[i].total_area += r.area.unwrap_or(0.0);
        }
        for a in &aggs {
            lines.push(
                [
                    csv_field(a.kind),
                    String::new(),
                    csv_field(&a.type_name),
                    csv_field(&format!("{} Stk", a.count)),
                    if a.total_length > 0.0 { fmt_num(Some(a.total_length)) } else { String::new() },
                    String::new(),
                    String::new(),
                    if a.total_area > 0.0 { fmt_num(Some(a.total_area)) } else { String::new() },
                ]
                .join(d),
            );
        }
    }
    lines.join("\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beispielprojekt_hat_zeilen_und_csv() {
        let p: Project = serde_json::from_str(include_str!("../tests/fixtures/sample_project.json")).unwrap();
        let rows = schedule_rows(&p);
        assert!(rows.iter().any(|r| r.kind == "Wand"));
        let csv = export_schedule_csv(&p, ";", true);
        assert!(csv.starts_with("Typ;ID;Bauteil;Geschoss;Länge [m];Höhe [m];Dicke [m];Fläche [m²]\r\n"));
        assert!(csv.contains("Zusammenfassung (je Bauteil-Typ)"));
        assert_eq!(export_schedule_csv(&Project::default(), ";", true), "Typ;ID;Bauteil;Geschoss;Länge [m];Höhe [m];Dicke [m];Fläche [m²]");
    }

    #[test]
    fn csv_quoting() {
        assert_eq!(csv_field("a;b"), "\"a;b\"");
        assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
        assert_eq!(fmt_num(Some(1.005)), "1.00");
        assert_eq!(fmt_num(None), "");
    }
}
