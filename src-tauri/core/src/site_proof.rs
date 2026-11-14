//! Baurecht-Nachweis ([255]): die Vorgaben der Parzelle (`Project.siteRules`) gegen die Kennzahlen des Modells
//! (IVHB-Ziffern, Höhen, Grundfläche gegen Grenzabstand/Baulinie). Eine Zeile je Prüfgrösse: zulässig · Projekt ·
//! Reserve (positiv) bzw. Überschreitung (negativ) · erfüllt. Fehlt die Vorgabe, bleibt `allowed`/`ok` leer (die UI
//! zeigt „—“) — nichts wird erfunden. Dazu die Grundlagen (aGSF, GF, aGF, aGbF, Baumasse, Grünfläche) mit Quelle.
//! Die Ziffern kommen aus `flaechen::ivhb`, die Prüfung der Grundfläche aus `site_rules::check_project`:
//! eine Quelle mit Flächentabelle und Lage-Panel.

use crate::flaechen::{self, AgfBasis, AgsfSource, IvhbOptions};
use crate::model::Project;
use crate::site_rules;
use serde::Serialize;

/// Obergrenze (`Max`: Projekt ≤ zulässig) oder Untergrenze (`Min`: Projekt ≥ zulässig).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Limit {
    Max,
    Min,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofRow {
    /// gfz, az, bmz, uz, gz, totalHeight, facadeHeight, setback, profile.
    pub key: &'static str,
    pub limit: Limit,
    pub allowed: Option<f64>,
    pub actual: Option<f64>,
    /// Max: zulässig − Projekt; Min: Projekt − zulässig (negativ = Überschreitung bzw. Unterschreitung).
    pub reserve: Option<f64>,
    /// `None`, wenn Vorgabe oder Projektwert fehlt.
    pub ok: Option<bool>,
    pub decimals: usize,
    pub unit: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofBasis {
    /// agsf, allowedArea, gf, agf, agbf, baumasse, greenArea.
    pub key: &'static str,
    pub value: Option<f64>,
    pub decimals: usize,
    pub unit: &'static str,
    /// Schlüssel der Quelle (UI: `siteProof.src.<source>`).
    pub source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteProof {
    pub rows: Vec<ProofRow>,
    pub basis: Vec<ProofBasis>,
    /// Hinweis-Schlüssel (UI: `siteProof.note.<key>`).
    pub notes: Vec<&'static str>,
    /// Mindestens eine Vorgabe ist gesetzt.
    pub has_limits: bool,
    /// Alle gesetzten Vorgaben mit Projektwert sind erfüllt; `None` ohne prüfbare Vorgabe.
    pub all_ok: Option<bool>,
}

/// Vorgabe nur, wenn endlich und > 0 (0/negativ/NaN = nicht gesetzt).
fn limit(v: Option<f64>) -> Option<f64> {
    v.filter(|x| x.is_finite() && *x > 0.0)
}

fn row(key: &'static str, limit: Limit, allowed: Option<f64>, actual: Option<f64>, decimals: usize, unit: &'static str, tol: f64) -> ProofRow {
    let actual = actual.filter(|a| a.is_finite());
    let reserve = allowed.zip(actual).map(|(a, x)| if limit == Limit::Max { a - x } else { x - a });
    let ok = reserve.map(|r| r >= -tol);
    ProofRow { key, limit, allowed, actual, reserve, ok, decimals, unit }
}

/// Nachweis des Projekts; `opt` wie bei `flaechen::ivhb` (aGSF-Eingabe, Grünfläche, Basis der aGF).
pub fn site_proof(p: &Project, opt: &IvhbOptions) -> SiteProof {
    let v = flaechen::ivhb(p, opt);
    let rules = p.site_rules.as_ref();
    let check = site_rules::check_project(p);
    let mut notes: Vec<&'static str> = vec![];
    if rules.is_none() {
        notes.push("noRules");
    }

    // Gesamthöhe: mit Gelände über dem massgebenden Terrain, sonst über ±0.00 (wie das Lage-Panel).
    let (top, above_terrain) = match &check {
        Some(c) => (c.height_above_terrain.or(c.max_top), c.height_above_terrain.is_some()),
        None => (v.total_height, false),
    };
    notes.push(if above_terrain { "heightTerrain" } else { "heightZero" });
    notes.push("facadeApprox");

    let l = |f: fn(&crate::model::SiteRules) -> Option<f64>| limit(rules.and_then(f));
    let mut rows = vec![
        row("gfz", Limit::Max, l(|r| r.max_gfz), v.gfz, 2, "", 1e-6),
        row("az", Limit::Max, l(|r| r.max_az), v.az, 2, "", 1e-6),
        row("bmz", Limit::Max, l(|r| r.max_bmz), v.bmz, 2, "m", 1e-6),
        row("uz", Limit::Max, l(|r| r.max_uz), v.uz, 2, "", 1e-6),
        row("gz", Limit::Min, l(|r| r.min_gz), v.gz, 2, "", 1e-6),
        row("totalHeight", Limit::Max, l(|r| r.max_height), top, 2, "m", 1e-6),
        row("facadeHeight", Limit::Max, l(|r| r.max_facade_height), v.facade_height, 2, "m", 1e-6),
    ];
    let numeric_limits = rows.iter().any(|r| r.allowed.is_some());
    // Grenzabstände und Baulinien: erlaubt ist keine Grundfläche ausserhalb der zulässigen Fläche (Splitter < 0.01 m² zählen nicht).
    rows.push(row("setback", Limit::Max, check.as_ref().map(|_| 0.0), check.as_ref().map(|c| c.violation_area), 2, "m²", 0.01));
    if rules.is_some_and(|r| r.profile_angle.is_some()) {
        // Gebäudeprofil: Anzahl Bauteile über dem Profil.
        rows.push(row("profile", Limit::Max, check.as_ref().map(|_| 0.0), check.as_ref().map(|c| c.profile_violations.len() as f64), 0, "", 0.0));
    }
    if !numeric_limits {
        notes.push("noLimits");
    }
    let checked: Vec<bool> = rows.iter().filter_map(|r| r.ok).collect();
    let all_ok = if checked.is_empty() { None } else { Some(checked.iter().all(|b| *b)) };
    let has_limits = rows.iter().any(|r| r.allowed.is_some());

    let agsf_src = match v.agsf_source {
        AgsfSource::Input => "agsfInput",
        AgsfSource::ParcelArea => "parcelArea",
        AgsfSource::ParcelRing => "parcelRing",
        AgsfSource::None => "none",
    };
    let agf_src = match v.agf_basis {
        AgfBasis::Gf => "agfGf",
        AgfBasis::Ngf => "agfNgf",
        AgfBasis::Nf => "agfNf",
    };
    let basis = vec![
        ProofBasis { key: "agsf", value: v.agsf, decimals: 2, unit: "m²", source: agsf_src },
        ProofBasis { key: "allowedArea", value: check.as_ref().map(|c| c.allowed_area), decimals: 2, unit: "m²", source: "setbacks" },
        ProofBasis { key: "gf", value: Some(v.gf_sum), decimals: 2, unit: "m²", source: "sia416" },
        ProofBasis { key: "agf", value: Some(v.agf), decimals: 2, unit: "m²", source: agf_src },
        ProofBasis { key: "agbf", value: Some(v.agbf), decimals: 2, unit: "m²", source: "footprint" },
        ProofBasis { key: "baumasse", value: Some(v.baumasse), decimals: 1, unit: "m³", source: "volumeAbove" },
        ProofBasis { key: "greenArea", value: v.green_area, decimals: 2, unit: "m²", source: "greenInput" },
    ];
    SiteProof { rows, basis, notes, has_limits, all_ok }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SiteRules;
    use crate::model::Vec2;

    fn v2(x: f64, y: f64) -> Vec2 {
        Vec2 { x, y }
    }

    /// Einfaches Haus (siehe `flaechen::tests::house`): 10.3 × 8.3 m Grundfläche, EG + OG oberirdisch.
    fn project(rules: Option<SiteRules>) -> Project {
        let mut p = flaechen::tests::house();
        p.site_rules = rules;
        p
    }

    fn rules() -> SiteRules {
        // Parzelle 20 × 20 m = 400 m² um das Haus (Achsen 0..10 × 0..8), Grenzabstand 1 m.
        SiteRules { parcel: vec![v2(-5.0, -5.0), v2(15.0, -5.0), v2(15.0, 15.0), v2(-5.0, 15.0)], default_setback: 1.0, ..Default::default() }
    }

    fn get<'a>(p: &'a SiteProof, k: &str) -> &'a ProofRow {
        p.rows.iter().find(|r| r.key == k).unwrap()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn ohne_baurecht_keine_vorgaben_keine_erfindung() {
        let pr = site_proof(&project(None), &IvhbOptions::default());
        assert!(!pr.has_limits && pr.all_ok.is_none());
        assert!(pr.rows.iter().all(|r| r.allowed.is_none() && r.ok.is_none() && r.reserve.is_none()));
        assert!(pr.notes.contains(&"noRules") && pr.notes.contains(&"noLimits"));
        // Projektwerte der Höhen gibt es trotzdem (kein Gelände → über ±0.00).
        assert!(close(get(&pr, "totalHeight").actual.unwrap(), 5.2));
        // Ziffern ohne Parzellenfläche: nicht berechenbar.
        assert!(get(&pr, "az").actual.is_none());
    }

    #[test]
    fn ziffern_reserve_und_ueberschreitung() {
        let mut r = rules();
        r.max_az = Some(0.5); // Ist: 2·74.69/400 = 0.373
        r.max_gfz = Some(0.4); // Ist: 2·85.49/400 = 0.427 → überschritten
        r.max_uz = Some(0.3); // Ist: 85.49/400 = 0.214
        r.min_gz = Some(0.5); // keine Grünfläche eingegeben → nicht prüfbar
        r.max_height = Some(6.0);
        r.max_facade_height = Some(5.0); // Ist 5.2 → überschritten
        let o = IvhbOptions { agsf: Some(400.0), ..Default::default() };
        let pr = site_proof(&project(Some(r)), &o);
        let az = get(&pr, "az");
        assert!(close(az.actual.unwrap(), 2.0 * 74.69 / 400.0) && close(az.reserve.unwrap(), 0.5 - 2.0 * 74.69 / 400.0));
        assert_eq!(az.ok, Some(true));
        let gfz = get(&pr, "gfz");
        assert_eq!(gfz.ok, Some(false));
        assert!(close(gfz.reserve.unwrap(), 0.4 - 2.0 * 85.49 / 400.0));
        assert_eq!(get(&pr, "uz").ok, Some(true));
        assert_eq!(get(&pr, "gz").ok, None, "Untergrenze ohne Grünfläche ist nicht prüfbar");
        assert_eq!(get(&pr, "bmz").allowed, None);
        assert_eq!(get(&pr, "totalHeight").ok, Some(true));
        let fh = get(&pr, "facadeHeight");
        assert_eq!(fh.ok, Some(false));
        assert!(close(fh.reserve.unwrap(), -0.2));
        assert_eq!(pr.all_ok, Some(false));
        assert!(pr.has_limits && !pr.notes.contains(&"noLimits"));
    }

    #[test]
    fn untergrenze_gruenflaeche_und_grundlagen() {
        let mut r = rules();
        r.min_gz = Some(0.3);
        let o = IvhbOptions { agsf: Some(400.0), green_area: Some(160.0), ..Default::default() };
        let pr = site_proof(&project(Some(r)), &o);
        let gz = get(&pr, "gz");
        assert!(close(gz.actual.unwrap(), 0.4) && close(gz.reserve.unwrap(), 0.1));
        assert_eq!(gz.ok, Some(true));
        let b = |k: &str| pr.basis.iter().find(|b| b.key == k).unwrap();
        assert!(close(b("agsf").value.unwrap(), 400.0) && b("agsf").source == "agsfInput");
        assert!(close(b("gf").value.unwrap(), 2.0 * 85.49) && b("gf").source == "sia416");
        assert!(close(b("agf").value.unwrap(), 2.0 * 74.69) && b("agf").source == "agfNgf");
        assert!(close(b("agbf").value.unwrap(), 85.49));
        assert!(close(b("greenArea").value.unwrap(), 160.0));
        // Zulässige Fläche: 18 × 18 m nach 1 m Grenzabstand.
        assert!(close(b("allowedArea").value.unwrap(), 18.0 * 18.0));
    }

    #[test]
    fn grenzabstand_wird_geprueft() {
        // Abstand 6 m: zulässig ist nur noch 8 × 8 m, das Haus (10.3 × 8.3) ragt hinaus.
        let mut r = rules();
        r.default_setback = 6.0;
        let pr = site_proof(&project(Some(r)), &IvhbOptions::default());
        let s = get(&pr, "setback");
        assert_eq!(s.ok, Some(false));
        assert!(s.actual.unwrap() > 1.0 && s.reserve.unwrap() < 0.0);
        // Abstand 1 m: alles innerhalb.
        let pr = site_proof(&project(Some(rules())), &IvhbOptions::default());
        assert_eq!(get(&pr, "setback").ok, Some(true));
        assert_eq!(get(&pr, "setback").allowed, Some(0.0));
        assert_eq!(pr.all_ok, Some(true));
    }

    #[test]
    fn unsinn_wird_nicht_zur_vorgabe() {
        let mut r = rules();
        r.max_az = Some(f64::NAN);
        r.max_gfz = Some(-1.0);
        r.max_uz = Some(0.0);
        let pr = site_proof(&project(Some(r)), &IvhbOptions { agsf: Some(400.0), ..Default::default() });
        for k in ["az", "gfz", "uz"] {
            assert!(get(&pr, k).allowed.is_none(), "{k}");
        }
    }
}
