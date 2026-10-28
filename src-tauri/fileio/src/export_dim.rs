// Bemassung für den DXF/DWG-Export ([C2], 28.10.): echte DIMENSION-Entitäten (ausgerichtet) samt
// Bemassungsstil (DIMSTYLE) und Anonymblock `*D…`.
//
// Warum der Anonymblock: AutoCAD, BricsCAD & Co. zeichnen eine DIMENSION aus ihren Definitionspunkten
// und dem Stil neu, LibreCAD/ezdxf/viele Betrachter aber nur aus dem Block `*D<n>` (Gruppencode 2 der
// Entität). Wir schreiben beides: die Entität (bearbeitbar, folgt dem Stil) und den Block (sieht überall
// gleich aus, identisch zum Dossier-Plan: Masshilfslinien mit Abstand/Überstand, Masslinie, 45°-
// Architekturstriche, Masszahl über der Linie, nie kopfüber).
//
// Grössen: `DimStyleDef` trägt PAPIER-Meter (Texthöhe 4 mm = 0.004) und den Massstab als `scale`
// (DIMSCALE). In Modell-Metern ist jede Länge `papier × scale` — dieselbe Umrechnung wie
// `model/dimension.ts::mmToModel`. Der Block wird in Weltkoordinaten (LV95 passt) mit diesen
// Modell-Metern gezeichnet.

use acadrust::entities::{
    AttachmentPointType, Dimension, DimensionAligned, Line, Text, TextHorizontalAlignment,
};
use acadrust::tables::DimStyle;
use acadrust::{EntityType, Vector3};

/// Bemassungsstil in Papier-Metern (Länge × `scale` = Modell-Meter).
#[derive(Debug, Clone, PartialEq)]
pub struct DimStyleDef {
    pub name: String,
    /// Name des Textstils (STYLE) der Masszahl.
    pub text_style: String,
    /// Massstabsnenner (DIMSCALE), z. B. 100 bei 1:100.
    pub scale: f64,
    /// Texthöhe (DIMTXT).
    pub txt: f64,
    /// Gesamtlänge des Architekturstrichs.
    pub tick: f64,
    /// Abstand Masshilfslinie ← bemessener Punkt (DIMEXO).
    pub exo: f64,
    /// Überstand der Masshilfslinie über die Masslinie (DIMEXE).
    pub exe: f64,
    /// Abstand Masszahl ↔ Masslinie (DIMGAP).
    pub gap: f64,
    /// Nachkommastellen der Masszahl (DIMDEC).
    pub dec: i16,
    /// Faktor Modell-Meter → Anzeigeeinheit (DIMLFAC): 1 = Meter, 100 = Zentimeter.
    pub lfac: f64,
    /// Format der Masszahl mit `<>` als Platzhalter (DIMPOST), leer = nur die Zahl.
    pub post: String,
}

impl DimStyleDef {
    /// Alle Werte endlich, Massstab/Texthöhe positiv, Nachkommastellen im DXF-Bereich.
    pub fn is_valid(&self) -> bool {
        [self.scale, self.txt, self.tick, self.exo, self.exe, self.gap, self.lfac].iter().all(|v| v.is_finite())
            && self.scale > 0.0
            && self.txt > 0.0
            && self.tick >= 0.0
            && self.exo >= 0.0
            && self.exe >= 0.0
            && self.gap >= 0.0
            && self.lfac > 0.0
            && (0..=8).contains(&self.dec)
    }
}

/// DIMSTYLE-Tabelleneintrag: Architekturstrich statt Pfeil (DIMTSZ), Masszahl über der Masslinie, in
/// Linienrichtung (DIMTAD 1, DIMTIH/DIMTOH aus), Dezimalzahl mit Punkt (DIMLUNIT 2, DIMDSEP '.').
pub fn make_dimstyle(d: &DimStyleDef) -> DimStyle {
    let mut s = DimStyle::new(d.name.clone());
    s.dimscale = d.scale;
    s.dimtxt = d.txt;
    s.dimtsz = d.tick / 2.0; // Strich reicht je Seite um die Hälfte
    s.dimasz = d.tick / 2.0;
    s.dimexo = d.exo;
    s.dimexe = d.exe;
    s.dimgap = d.gap;
    s.dimdle = 0.0;
    s.dimtad = 1;
    s.dimtih = false;
    s.dimtoh = false;
    s.dimjust = 0;
    s.dimdec = d.dec;
    s.dimlfac = d.lfac;
    s.dimlunit = 2;
    s.dimdsep = '.' as i16;
    s.dimzin = 0;
    s.dimpost = d.post.clone();
    s.dimtxsty = d.text_style.clone();
    s
}

/// Masszahl wie CAD sie aus dem Stil bildet: `wert × lfac` auf `dec` Stellen, in `post` an Stelle von `<>`.
pub fn format_measurement(d: &DimStyleDef, meters: f64) -> String {
    let num = format!("{:.*}", d.dec.max(0) as usize, meters * d.lfac);
    if d.post.contains("<>") {
        d.post.replace("<>", &num)
    } else if d.post.is_empty() {
        num
    } else {
        // Ein Format ohne Platzhalter ersetzt die Zahl (wie in CAD) — hier nie gewollt: Zahl behalten.
        num
    }
}

/// Eine ausgerichtete Bemassung samt Inhalt ihres Anonymblocks (Weltkoordinaten, Ebene `layer`).
pub struct BuiltDimension {
    pub entity: DimensionAligned,
    pub block_entities: Vec<EntityType>,
}

/// `p1`/`p2` = bemessene Punkte, `on_line` = ein Punkt auf der Masslinie (legt Seite und Abstand fest),
/// `text_at` = freie Lage der Masszahl (Mitte), sonst Standardlage. `None` bei entarteten Eingaben
/// (NaN, Länge 0, ungültiger Stil).
pub fn build_aligned(
    style: &DimStyleDef,
    block_name: &str,
    layer: &str,
    p1: [f64; 2],
    p2: [f64; 2],
    on_line: [f64; 2],
    text_at: Option<[f64; 2]>,
) -> Option<BuiltDimension> {
    if !style.is_valid() {
        return None;
    }
    let all = [p1[0], p1[1], p2[0], p2[1], on_line[0], on_line[1]];
    if !all.iter().all(|v| v.is_finite()) {
        return None;
    }
    if let Some(t) = text_at {
        if !t.iter().all(|v| v.is_finite()) {
            return None;
        }
    }
    let (dx, dy) = (p2[0] - p1[0], p2[1] - p1[1]);
    let len = dx.hypot(dy);
    if len < 1e-9 {
        return None;
    }
    let (ux, uy) = (dx / len, dy / len);
    let (nx, ny) = (-uy, ux); // linke Normale wie im Dossier-Plan
    let offset = (on_line[0] - p1[0]) * nx + (on_line[1] - p1[1]) * ny;
    let sign = if offset >= 0.0 { 1.0 } else { -1.0 };
    let s = style.scale;
    let dim_a = [p1[0] + nx * offset, p1[1] + ny * offset];
    let dim_b = [p2[0] + nx * offset, p2[1] + ny * offset];

    // Lesewinkel der Masszahl: nie kopfüber.
    let mut angle = uy.atan2(ux);
    if angle.cos() < 0.0 {
        angle += std::f64::consts::PI;
    }
    angle = angle.rem_euclid(2.0 * std::f64::consts::PI);
    let (up_x, up_y) = (-angle.sin(), angle.cos());
    let h = style.txt * s;
    let mid = [(dim_a[0] + dim_b[0]) / 2.0, (dim_a[1] + dim_b[1]) / 2.0];
    // Mitte der Zahl: Unterkante `gap` über der Masslinie.
    let default_mid = [mid[0] + up_x * (style.gap * s + h / 2.0), mid[1] + up_y * (style.gap * s + h / 2.0)];
    let text_mid = text_at.unwrap_or(default_mid);

    let mut ents: Vec<EntityType> = Vec::new();
    let line = |a: [f64; 2], b: [f64; 2]| EntityType::Line(Line::from_coords(a[0], a[1], 0.0, b[0], b[1], 0.0));
    let exo = style.exo * s * sign;
    let exe = style.exe * s * sign;
    // Masshilfslinien: Abstand `exo` zum Punkt bis `exe` über die Masslinie hinaus.
    ents.push(line([p1[0] + nx * exo, p1[1] + ny * exo], [dim_a[0] + nx * exe, dim_a[1] + ny * exe]));
    ents.push(line([p2[0] + nx * exo, p2[1] + ny * exo], [dim_b[0] + nx * exe, dim_b[1] + ny * exe]));
    ents.push(line(dim_a, dim_b)); // Masslinie
    // Architekturstriche: 45°-Diagonale (Winkelhalbierende von Linienrichtung und Normale), an beiden
    // Enden parallel.
    if style.tick > 0.0 {
        let (tx, ty) = ((ux + nx) / std::f64::consts::SQRT_2, (uy + ny) / std::f64::consts::SQRT_2);
        let half = style.tick * s / 2.0;
        for p in [dim_a, dim_b] {
            ents.push(line([p[0] - tx * half, p[1] - ty * half], [p[0] + tx * half, p[1] + ty * half]));
        }
    }
    let value = format_measurement(style, len);
    let mut txt = Text::with_value(value, Vector3::new(text_mid[0], text_mid[1], 0.0)).with_height(h).with_rotation(angle);
    txt.horizontal_alignment = TextHorizontalAlignment::Middle;
    txt.alignment_point = Some(Vector3::new(text_mid[0], text_mid[1], 0.0));
    txt.style = style.text_style.clone();
    ents.push(EntityType::Text(txt));
    for e in &mut ents {
        e.common_mut().layer = layer.to_string();
    }

    let mut dim = DimensionAligned::new(Vector3::new(p1[0], p1[1], 0.0), Vector3::new(p2[0], p2[1], 0.0));
    dim.definition_point = Vector3::new(dim_b[0], dim_b[1], 0.0);
    dim.base.definition_point = dim.definition_point;
    dim.base.text_middle_point = Vector3::new(text_mid[0], text_mid[1], 0.0);
    dim.base.attachment_point = AttachmentPointType::MiddleCenter;
    dim.base.style_name = style.name.clone();
    dim.base.block_name = block_name.to_string();
    dim.base.actual_measurement = len;
    dim.base.common.layer = layer.to_string();
    if text_at.is_some() {
        dim.base.text_user_positioned = true;
        dim.base.dwg_flags_byte = 0x00;
    }
    Some(BuiltDimension { entity: dim, block_entities: ents })
}

/// Wrapper für den Dokument-Aufbau.
pub fn into_entity(d: DimensionAligned) -> EntityType {
    EntityType::Dimension(Box::new(Dimension::Aligned(d)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style() -> DimStyleDef {
        DimStyleDef {
            name: "DOSSIER_1-100".into(),
            text_style: "DOSSIER".into(),
            scale: 100.0,
            txt: 0.004,
            tick: 0.003,
            exo: 0.001,
            exe: 0.001,
            gap: 0.0024,
            dec: 2,
            lfac: 1.0,
            post: String::new(),
        }
    }

    #[test]
    fn messzahl_formatierung() {
        let mut s = style();
        assert_eq!(format_measurement(&s, 3.254), "3.25");
        s.lfac = 100.0;
        s.dec = 0;
        s.post = "<> cm".into();
        assert_eq!(format_measurement(&s, 3.254), "325 cm");
    }

    #[test]
    fn block_hat_hilfslinien_masslinie_striche_und_text() {
        let b = build_aligned(&style(), "*D1", "BEM", [10.0, 5.0], [14.0, 5.0], [10.0, 6.0], None).unwrap();
        assert_eq!(b.block_entities.len(), 2 + 1 + 2 + 1);
        assert_eq!(b.entity.base.block_name, "*D1");
        assert!((b.entity.base.actual_measurement - 4.0).abs() < 1e-12);
        // Masslinie 1 m über den Punkten.
        let EntityType::Line(l) = &b.block_entities[2] else { panic!() };
        assert!((l.start.y - 6.0).abs() < 1e-12 && (l.end.x - 14.0).abs() < 1e-12);
        // Masshilfslinie: 0.1 m Abstand, reicht 0.1 m über die Masslinie.
        let EntityType::Line(e) = &b.block_entities[0] else { panic!() };
        assert!((e.start.y - 5.1).abs() < 1e-9 && (e.end.y - 6.1).abs() < 1e-9);
        // Text: Höhe 0.4 m, Wert 4.00, über der Linie, Lesewinkel 0.
        let EntityType::Text(t) = b.block_entities.last().unwrap() else { panic!() };
        assert_eq!(t.value, "4.00");
        assert!((t.height - 0.4).abs() < 1e-12 && t.rotation.abs() < 1e-12);
        assert!(t.insertion_point.y > 6.0);
    }

    #[test]
    fn text_nie_kopfueber_und_seite_folgt_dem_vorzeichen() {
        // Kette von rechts nach links: Lesewinkel wieder nach rechts (0), nicht π.
        let b = build_aligned(&style(), "*D2", "0", [14.0, 5.0], [10.0, 5.0], [14.0, 4.0], None).unwrap();
        let EntityType::Text(t) = b.block_entities.last().unwrap() else { panic!() };
        assert!(t.rotation.sin().abs() < 1e-12 && t.rotation.cos() > 0.0);
        // Linke Normale von (−1, 0) ist (0, −1): Offset −1 m liegt bei y = 6, die Linie also über den Punkten.
        let b = build_aligned(&style(), "*D3", "0", [10.0, 5.0], [14.0, 5.0], [10.0, 4.0], None).unwrap();
        let EntityType::Line(l) = &b.block_entities[2] else { panic!() };
        assert!((l.start.y - 4.0).abs() < 1e-12);
    }

    #[test]
    fn entartete_eingaben_ergeben_none() {
        assert!(build_aligned(&style(), "*D1", "0", [0.0, 0.0], [0.0, 0.0], [0.0, 1.0], None).is_none());
        assert!(build_aligned(&style(), "*D1", "0", [f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0], None).is_none());
        let mut s = style();
        s.scale = 0.0;
        assert!(build_aligned(&s, "*D1", "0", [0.0, 0.0], [1.0, 0.0], [0.0, 1.0], None).is_none());
        s = style();
        s.dec = 99;
        assert!(!s.is_valid());
    }
}
