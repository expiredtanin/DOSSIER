//! Kostenschätzung grob ([209]) für Wettbewerb und Vorprojekt nach der Kennwert-Methode:
//! Kosten = Menge × Kennwert je eBKP-H-Hauptgruppe, dann Honorare, Reserve und MwSt in Prozent.
//!
//! # Gliederung (eBKP-H, SN 506 511 „Baukostenplan Hochbau“, CRB)
//!
//! ```text
//!   B Vorbereitung · C Konstruktion Gebäude · D Technik Gebäude · E Äussere Wandbekleidung Gebäude
//!   F Bedachung Gebäude · G Ausbau Gebäude · H Nutzungsspezifische Anlage Gebäude · I Umgebung Gebäude
//!   J Ausstattung Gebäude                                     (A Grundstück fehlt bewusst)
//!   V Planungskosten (Honorare, %) · Y Reserve (%) · Z Mehrwertsteuer (%)
//! ```
//!
//! # Mengen (eine Quelle, [225])
//!
//! GV, GF und HNF kommen aus der SIA-416-Flächentabelle (`flaechen::area_table`), dieselben Zahlen wie
//! Flächen-Nachweis und Kennzahlenleiste. Fassade: `flaechen::facade_area`; Dach: geneigte Dachflächen
//! der Dächer (`u_value::element_schedule`), ohne Dach die Fläche im Aussenumriss der oberirdischen Bauteile
//! (Flachdach-Annahme, `flaechen::above_ground_outline_area`).
//!
//! # Vorgabewerte — BEISPIELWERTE, keine offiziellen Kennwerte
//!
//! Für Kennwerte je eBKP-H-Hauptgruppe gibt es keine frei zugängliche, verbindliche Quelle (Kennwerte
//! publizieren u. a. CRB „Werk-Kennwerte“, Bauökonomie-Büros und Fachzeitschriften, meist kostenpflichtig
//! und objektbezogen). Die Vorgaben unten sind darum eine runde Annahme für ein Wohn-/Bürogebäude mittleren
//! Standards (Grössenordnung Schweiz, Preisstand 2025): rund 800 CHF/m³ GV bzw. 2'600 CHF/m² GF für B–J,
//! aufgeteilt nach einer typischen Verteilung (B 2 %, C 24 %, D 20 %, E 13 %, F 5 %, G 25 %, H 2 %, I 6 %,
//! J 3 %). Sie sind in Panel, Tabelle und Export als „Beispielwert“ markiert, bis der Mensch sie ändert.
//! Belegt sind nur: MwSt 8.1 % (Normalsatz CH seit 1.1.2024, MWSTG Art. 25) und die üblichen Genauigkeiten
//! nach SIA 102 (Vorstudie/Grobschätzung ±25 %, Vorprojekt/Kostenschätzung ±15 %). Honorare 15 % und
//! Reserve 10 % sind ebenfalls Annahmen.

use crate::flaechen::{self, GvSource};
use crate::model::{CostBasis, CostEstimate, CostGroup, CostMethod, Project};
use serde::Serialize;

/// eBKP-H-Hauptgruppen B–J mit Beispiel-Kennwerten (CHF/m³ GV, CHF/m² GF), Preisstand 2025, s. Moduldoku.
pub const EXAMPLE_RATES: [(&str, f64, f64); 9] = [
    ("B", 16.0, 50.0),
    ("C", 192.0, 620.0),
    ("D", 160.0, 520.0),
    ("E", 104.0, 340.0),
    ("F", 40.0, 130.0),
    ("G", 200.0, 650.0),
    ("H", 16.0, 50.0),
    ("I", 48.0, 160.0),
    ("J", 24.0, 80.0),
];

pub const EXAMPLE_FEES_PCT: f64 = 15.0;
pub const EXAMPLE_RESERVE_PCT: f64 = 10.0;
/// Normalsatz der Schweizer MwSt seit 1.1.2024.
pub const VAT_PCT: f64 = 8.1;
/// SIA 102, Vorprojekt (Kostenschätzung).
pub const ACCURACY_PCT: f64 = 15.0;
pub const EXAMPLE_PRICE_BASE: &str = "2025";

/// Beispiel-Kennwert einer Hauptgruppe für die Methode.
pub fn example_rate(code: &str, method: CostMethod) -> Option<f64> {
    EXAMPLE_RATES.iter().find(|(c, _, _)| *c == code).map(|&(_, gv, gf)| if method == CostMethod::Gf { gf } else { gv })
}

/// Vorgabe der Kostenschätzung (Beispielwerte) für eine Methode.
pub fn default_estimate(method: CostMethod) -> CostEstimate {
    let method = if method == CostMethod::Gf { CostMethod::Gf } else { CostMethod::Gv };
    CostEstimate {
        method,
        groups: EXAMPLE_RATES
            .iter()
            .map(|&(code, gv, gf)| CostGroup { code: code.to_string(), name: None, basis: CostBasis::Method, rate: if method == CostMethod::Gf { gf } else { gv }, extra: Default::default() })
            .collect(),
        fees_pct: EXAMPLE_FEES_PCT,
        reserve_pct: EXAMPLE_RESERVE_PCT,
        vat_pct: VAT_PCT,
        accuracy_pct: ACCURACY_PCT,
        region_factor: 1.0,
        index_factor: 1.0,
        price_base: EXAMPLE_PRICE_BASE.to_string(),
        extra: Default::default(),
    }
}

/// Mengen aus dem Modell.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostQuantities {
    pub gv: f64,
    pub gf: f64,
    pub hnf: f64,
    pub facade: f64,
    pub roof: f64,
    pub gv_source: Option<GvSource>,
}

/// Eine Zeile des Ergebnisses (eine Kennwert-Zeile).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRow {
    pub code: String,
    /// Eigene Bezeichnung (sonst übersetzt die UI den eBKP-H-Namen aus `code`).
    pub name: Option<String>,
    /// Aufgelöste Bezugsmenge (nie `method`).
    pub basis: CostBasis,
    pub quantity: f64,
    /// „m³“, „m²“ oder „" (pauschal).
    pub unit: &'static str,
    pub rate: f64,
    /// Menge × Kennwert × Region × Index.
    pub amount: f64,
    /// Kennwert ist (noch) der Beispielwert.
    pub example: bool,
}

/// Ergebnis der Kostenschätzung (CHF).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostResult {
    pub method: CostMethod,
    pub quantities: CostQuantities,
    pub rows: Vec<CostRow>,
    /// Region × Index.
    pub factor: f64,
    pub region_factor: f64,
    pub index_factor: f64,
    /// Summe der Gruppen (B–J).
    pub subtotal: f64,
    pub fees_pct: f64,
    pub fees: f64,
    pub reserve_pct: f64,
    pub reserve: f64,
    /// Total exkl. MwSt.
    pub net: f64,
    pub vat_pct: f64,
    pub vat: f64,
    /// Total inkl. MwSt.
    pub gross: f64,
    pub accuracy_pct: f64,
    /// Bandbreite des Totals inkl. MwSt.
    pub low: f64,
    pub high: f64,
    /// Total inkl. MwSt. je m³ GV bzw. m² GF (`None` ohne Menge).
    pub per_gv: Option<f64>,
    pub per_gf: Option<f64>,
    pub price_base: String,
    /// Kein `costEstimate` im Projekt: alles Vorgaben.
    pub is_default: bool,
    /// Mindestens ein Kennwert ist ein Beispielwert.
    pub has_example: bool,
    /// Hinweis-Schlüssel (`costs.note.*`).
    pub notes: Vec<String>,
}

fn pct(v: f64) -> f64 {
    if v.is_finite() {
        v.max(0.0)
    } else {
        0.0
    }
}

fn factor(v: f64) -> f64 {
    if v.is_finite() && v > 0.0 {
        v
    } else {
        1.0
    }
}

/// Mengen des Projekts (eine Quelle: Flächentabelle).
pub fn quantities(p: &Project) -> (CostQuantities, bool) {
    let t = flaechen::area_table(p);
    let roofs: f64 = crate::u_value::element_schedule(p).iter().filter(|r| r.kind == crate::u_value::Kind::Roof).map(|r| r.area).filter(|a| a.is_finite()).sum();
    let roof_from_footprint = roofs <= 1e-9;
    let roof = if roof_from_footprint { flaechen::above_ground_outline_area(p) } else { roofs };
    (CostQuantities { gv: t.gv, gf: t.total.gf, hnf: t.total.hnf, facade: flaechen::facade_area(p), roof, gv_source: Some(t.gv_source) }, roof_from_footprint)
}

/// Kostenschätzung des Projekts (ohne `costEstimate` mit den Beispielwerten).
pub fn estimate(p: &Project) -> CostResult {
    let is_default = p.cost_estimate.is_none();
    let est = p.cost_estimate.clone().unwrap_or_else(|| default_estimate(CostMethod::Gv));
    let method = if est.method == CostMethod::Gf { CostMethod::Gf } else { CostMethod::Gv };
    let (q, roof_from_footprint) = quantities(p);
    let region = factor(est.region_factor);
    let index = factor(est.index_factor);
    let f = region * index;
    let mut notes: Vec<String> = Vec::new();
    let rows: Vec<CostRow> = est
        .groups
        .iter()
        .map(|g| {
            let basis = match g.basis {
                CostBasis::Method | CostBasis::Unknown => {
                    if method == CostMethod::Gf {
                        CostBasis::Gf
                    } else {
                        CostBasis::Gv
                    }
                }
                b => b,
            };
            let (quantity, unit) = match basis {
                CostBasis::Gv => (q.gv, "m³"),
                CostBasis::Gf => (q.gf, "m²"),
                CostBasis::Hnf => (q.hnf, "m²"),
                CostBasis::Facade => (q.facade, "m²"),
                CostBasis::Roof => (q.roof, "m²"),
                _ => (1.0, ""),
            };
            let rate = if g.rate.is_finite() { g.rate } else { 0.0 };
            let quantity = if quantity.is_finite() { quantity } else { 0.0 };
            // Beispielwert: Bezug der Methode und Kennwert wie die Vorgabe.
            let example = matches!(g.basis, CostBasis::Method) && example_rate(&g.code, method).is_some_and(|r| (r - rate).abs() < 1e-9);
            CostRow { code: g.code.clone(), name: g.name.clone().filter(|s| !s.trim().is_empty()), basis, quantity, unit, rate, amount: quantity * rate * f, example }
        })
        .collect();
    let subtotal: f64 = rows.iter().map(|r| r.amount).sum();
    let (fees_pct, reserve_pct, vat_pct, accuracy_pct) = (pct(est.fees_pct), pct(est.reserve_pct), pct(est.vat_pct), pct(est.accuracy_pct));
    let fees = subtotal * fees_pct / 100.0;
    let reserve = (subtotal + fees) * reserve_pct / 100.0;
    let net = subtotal + fees + reserve;
    let vat = net * vat_pct / 100.0;
    let gross = net + vat;
    let has_example = rows.iter().any(|r| r.example);
    if has_example {
        notes.push("example".into());
    }
    if q.gv <= 1e-9 && q.gf <= 1e-9 {
        notes.push("noQuantity".into());
    }
    notes.push(if q.gv_source == Some(GvSource::Solids) { "gvSolids" } else { "gvLevels" }.into());
    if rows.iter().any(|r| r.basis == CostBasis::Facade) {
        notes.push("facade".into());
    }
    if roof_from_footprint && rows.iter().any(|r| r.basis == CostBasis::Roof) {
        notes.push("roofFootprint".into());
    }
    notes.push("accuracy".into());
    let per = |m: f64| if m > 1e-9 { Some(gross / m) } else { None };
    CostResult {
        method,
        rows,
        factor: f,
        region_factor: region,
        index_factor: index,
        subtotal,
        fees_pct,
        fees,
        reserve_pct,
        reserve,
        net,
        vat_pct,
        vat,
        gross,
        accuracy_pct,
        low: gross * (1.0 - accuracy_pct / 100.0),
        high: gross * (1.0 + accuracy_pct / 100.0),
        per_gv: per(q.gv),
        per_gf: per(q.gf),
        price_base: est.price_base.clone(),
        is_default,
        has_example,
        notes,
        quantities: q,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DrawingLevel, DrawingLevelKind, Vec2, Wall};

    fn level(id: &str, base: f64, h: f64) -> DrawingLevel {
        DrawingLevel { id: id.into(), name: id.into(), kind: DrawingLevelKind::Floor, base_elevation: Some(base), floor_height: Some(h), ..Default::default() }
    }

    fn wall(id: &str, a: (f64, f64), b: (f64, f64)) -> Wall {
        Wall { id: id.into(), floor_id: "eg".into(), start: Vec2 { x: a.0, y: a.1 }, end: Vec2 { x: b.0, y: b.1 }, height: 3.0, ..Default::default() }
    }

    /// 10 × 8 m Achsmass, Wände 20 cm, ein Geschoss 3 m.
    fn box_project() -> Project {
        let mut p = Project { drawing_levels: vec![level("eg", 0.0, 3.0)], ..Default::default() };
        p.walls = vec![wall("a", (0.0, 0.0), (10.0, 0.0)), wall("b", (10.0, 0.0), (10.0, 8.0)), wall("c", (10.0, 8.0), (0.0, 8.0)), wall("d", (0.0, 8.0), (0.0, 0.0))];
        p
    }

    #[test]
    fn vorgaben_sind_beispielwerte_und_summen_stimmen() {
        let gv: f64 = EXAMPLE_RATES.iter().map(|r| r.1).sum();
        let gf: f64 = EXAMPLE_RATES.iter().map(|r| r.2).sum();
        assert_eq!(gv, 800.0);
        assert_eq!(gf, 2600.0);
        let d = default_estimate(CostMethod::Gf);
        assert_eq!(d.groups.len(), 9);
        assert_eq!(d.groups[1].rate, 620.0);
        assert_eq!(d.vat_pct, 8.1);
    }

    #[test]
    fn mengen_aus_der_flaechentabelle() {
        let p = box_project();
        let r = estimate(&p);
        let t = flaechen::area_table(&p);
        assert!(r.is_default && r.has_example);
        assert_eq!(r.quantities.gv, t.gv);
        assert_eq!(r.quantities.gf, t.total.gf);
        // Aussenmass 10.2 × 8.2 m: Umfang 36.8 m × 3 m.
        assert!((r.quantities.facade - 36.8 * 3.0).abs() < 1e-3, "{}", r.quantities.facade);
        // Kein Dach: Grundfläche 10.2 × 8.2.
        assert!((r.quantities.roof - 10.2 * 8.2).abs() < 1e-3, "{}", r.quantities.roof);
        assert!(r.notes.iter().any(|n| n == "example"));
    }

    #[test]
    fn rechnung_mit_zuschlaegen() {
        let mut p = box_project();
        let gv = flaechen::area_table(&p).gv;
        assert!(gv > 0.0);
        p.cost_estimate = Some(CostEstimate {
            method: CostMethod::Gv,
            groups: vec![
                CostGroup { code: "B–J".into(), name: Some("Gebäude".into()), basis: CostBasis::Method, rate: 1000.0, extra: Default::default() },
                CostGroup { code: "E".into(), basis: CostBasis::Facade, rate: 100.0, ..Default::default() },
                CostGroup { code: "X".into(), basis: CostBasis::Lump, rate: 5000.0, ..Default::default() },
            ],
            fees_pct: 10.0,
            reserve_pct: 10.0,
            vat_pct: 8.1,
            accuracy_pct: 20.0,
            region_factor: 1.1,
            index_factor: 0.0, // ungültig ⇒ 1
            price_base: "Okt. 2025".into(),
            extra: Default::default(),
        });
        let r = estimate(&p);
        assert!(!r.is_default && !r.has_example);
        assert_eq!(r.rows[0].basis, CostBasis::Gv);
        assert_eq!(r.rows[0].unit, "m³");
        assert!((r.rows[0].amount - gv * 1000.0 * 1.1).abs() < 1e-6);
        assert!((r.rows[1].amount - r.quantities.facade * 100.0 * 1.1).abs() < 1e-6);
        assert_eq!(r.rows[2].quantity, 1.0);
        assert!((r.rows[2].amount - 5500.0).abs() < 1e-9);
        let sub = r.rows.iter().map(|x| x.amount).sum::<f64>();
        assert!((r.subtotal - sub).abs() < 1e-9);
        assert!((r.fees - sub * 0.1).abs() < 1e-6);
        assert!((r.reserve - sub * 1.1 * 0.1).abs() < 1e-6);
        assert!((r.net - sub * 1.1 * 1.1).abs() < 1e-6);
        assert!((r.gross - r.net * 1.081).abs() < 1e-6);
        assert!((r.low - r.gross * 0.8).abs() < 1e-6 && (r.high - r.gross * 1.2).abs() < 1e-6);
        assert!((r.per_gv.unwrap() - r.gross / gv).abs() < 1e-9);
        assert!(r.notes.iter().any(|n| n == "facade"));
    }

    #[test]
    fn methode_gf_und_kaputte_werte_ohne_panic() {
        let mut p = box_project();
        let mut e = default_estimate(CostMethod::Gf);
        e.groups.push(CostGroup { code: "Z?".into(), basis: CostBasis::Unknown, rate: f64::NAN, ..Default::default() });
        e.fees_pct = f64::NAN;
        e.vat_pct = -5.0;
        p.cost_estimate = Some(e);
        let r = estimate(&p);
        assert_eq!(r.rows[0].unit, "m²");
        assert!(r.rows.iter().take(9).all(|x| x.example));
        assert!(r.gross.is_finite() && r.fees == 0.0 && r.vat == 0.0);
        // Leeres Projekt: alles 0, keine Kennwerte je Menge.
        let r0 = estimate(&Project::default());
        assert_eq!(r0.gross, 0.0);
        assert!(r0.per_gv.is_none());
        assert!(r0.notes.iter().any(|n| n == "noQuantity"));
    }
}
