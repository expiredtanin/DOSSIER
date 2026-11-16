//! [264] Englische Namen der Standard-Bibliothek (`standards.rs`). Die Standards entstehen deutsch; ein NEUES
//! Projekt in englischer Oberfläche bekommt sie über `standards::merge_ops_in(.., Lang::En)` mit diesen Namen
//! (gleiche Kennungen, nur `name`). Bestehende Projektdaten werden nie übersetzt. Fachbegriffe nach
//! SIA/CH-Praxis auf Englisch (Exterior wall, Reinforced concrete, Thermal insulation …).

/// Sprache der Standard-Namen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Lang {
    #[default]
    De,
    En,
}

impl Lang {
    /// `"en"` → Englisch, alles andere Deutsch.
    pub fn parse(s: &str) -> Lang {
        if s.trim().eq_ignore_ascii_case("en") {
            Lang::En
        } else {
            Lang::De
        }
    }
}

/// Englischer Name eines Standard-Eintrags (nach Kennung); `None` = kein Eintrag (Name bleibt).
pub fn en_name(id: &str) -> Option<&'static str> {
    Some(match id {
        // Linienstile
        "std-ls-voll" => "Continuous line",
        "std-ls-strich-fein" => "Dashed line",
        "std-ls-strich-grob" => "Long dashed line",
        "std-ls-punkt" => "Dotted line",
        "std-ls-strichpunkt" => "Chain line (axis)",
        "std-ls-strichzweipunkt" => "Chain double-dot line",
        "std-ls-grundstueck" => "Property boundary",
        "std-ls-bauteilgrenze" => "Building line / element boundary",
        "std-ls-bruch" => "Break line (zigzag)",
        "std-ls-schraffur-strich" => "Short dashed line",
        "std-ls-schraffur-punkt" => "Short dotted line",
        "std-ls-sperrschicht" => "Barrier layer (wind, vapour, water)",
        // Schraffuren
        "std-h-ohne" => "SIA No hatch",
        "std-h-stahlbeton" => "SIA Reinforced concrete",
        "std-h-beton" => "SIA Plain concrete",
        "std-h-backstein" => "SIA Clay brick",
        "std-h-kalksandstein" => "SIA Calcium silicate brick",
        "std-h-porenbeton" => "SIA Aerated concrete",
        "std-h-holz" => "SIA Timber (cross-section)",
        "std-h-holz-massiv" => "SIA Solid timber",
        "std-h-bsp" => "SIA Cross-laminated timber",
        "std-h-holzwerkstoff" => "SIA Wood-based panel",
        "std-h-daemmung-weich" => "SIA Soft insulation",
        "std-h-daemmung-holzfaser" => "SIA Wood-fibre insulation",
        "std-h-daemmstoffe-sia" => "Insulation (SIA lines)",
        "std-h-gips" => "SIA Gypsum",
        "std-h-putz" => "SIA Plaster",
        "std-h-estrich" => "SIA Screed",
        "std-h-keramik" => "SIA Ceramics",
        "std-h-faserzement" => "SIA Fibre cement",
        "std-h-stahl" => "SIA Steel",
        "std-h-stahl-detail" => "SIA Steel scale 1:1",
        "std-h-alu" => "SIA Aluminium",
        "std-h-naturstein" => "SIA Natural stone",
        "std-h-glas" => "SIA Glass",
        "std-h-sperrschicht" => "SIA Barrier layer",
        "std-h-erdreich" => "SIA Soil",
        "std-h-kies" => "SIA Gravel / blinding layer",
        // Baustoffe
        "std-c-beton" => "Concrete",
        "std-c-stahlbeton" => "Reinforced concrete",
        "std-c-backstein" => "Clay brick",
        "std-c-kalksandstein" => "Calcium silicate brick",
        "std-c-porenbeton" => "Aerated concrete",
        "std-c-holz" => "Solid timber",
        "std-c-bsp" => "Cross-laminated timber",
        "std-c-holzwerkstoff" => "Wood-based panel (OSB/chipboard)",
        "std-c-mineralwolle" => "Mineral wool",
        "std-c-steinwolle" => "Stone wool",
        "std-c-eps" => "EPS",
        "std-c-xps" => "XPS",
        "std-c-holzfaser" => "Wood fibre",
        "std-c-trittschall" => "Impact sound insulation",
        "std-c-gipskarton" => "Plasterboard",
        "std-c-innenputz" => "Interior plaster",
        "std-c-aussenputz" => "Exterior render",
        "std-c-zementestrich" => "Cement screed",
        "std-c-parkett" => "Parquet",
        "std-c-keramik" => "Ceramic tiles",
        "std-c-glas" => "Glass",
        "std-c-stahl" => "Steel",
        "std-c-aluminium" => "Aluminium",
        "std-c-naturstein" => "Natural stone",
        "std-c-erdreich" => "Soil",
        "std-c-kies" => "Gravel / blinding layer",
        "std-c-sperrschicht" => "Waterproofing / barrier layer",
        "std-c-luft" => "Air gap / ventilation",
        "std-c-lattung-v" => "Vertical timber battens",
        "std-c-lattung-h" => "Horizontal timber battens",
        "std-c-boden-deckel" => "Board-and-batten cladding",
        "std-c-schindeln" => "Timber shingles",
        "std-c-trapezblech" => "Trapezoidal sheet metal",
        "std-c-faserzement" => "Fibre cement panels",
        "std-c-tonziegel" => "Clay tiles",
        // Aufbauten
        "std-wt-aw-kompakt" => "Exterior wall, rendered, 18 cm external insulation",
        "std-wt-iw-backstein" => "Interior wall, clay brick 12.5 cm, plastered",
        "std-wt-holzstaender" => "Timber frame wall, ventilated",
        "std-ct-stb-estrich" => "Reinforced concrete slab with impact sound insulation + cement screed",
        "std-rt-steildach-holz" => "Pitched roof, timber, insulated",
        // Ansichtsvorlagen
        "std-vt-praesentation" => "Presentation",
        "std-vt-eingabe-100" => "Permit drawing 1:100",
        "std-vt-ausfuehrung-50" => "Construction drawing 1:50",
        "std-vt-situation-wbw" => "Site plan (competition) 1:500",
        "std-vt-schwarzplan" => "Figure-ground plan 1:500",
        // Modelldarstellung
        "std-mv-wettbewerb-200" => "Competition 1:200",
        "std-mv-baueingabe-100" => "Building permit 1:100",
        "std-mv-ausfuehrung-50" => "Construction 1:50",
        "std-mv-situation-wbw" => "Site plan (competition)",
        "std-mv-schwarzplan" => "Figure-ground plan",
        "std-mv-rohbau" => "Structure / shell",
        // Symbole, Regeln
        "std-blk-deckenleuchte" => "Ceiling light",
        "std-or-deckenaufbau-weiss" => "Floor build-up white",
        "std-or-ansicht-ohne-materialschraffur" => "Elevation without material hatch",
        _ => return None,
    })
}

/// Englischer Name einer Klasse (Ebene) der Standards nach Code: Leuchten, abgeleitete Darstellung, Objektbibliothek.
pub fn en_layer_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "65" => "Lighting",
        "08" => "Shadows",
        "81" => "Auto dimensions",
        "82" => "Elevation marks",
        "91" => "Section marks",
        "92" => "Cameras",
        "83" => "Site buildings",
        "84" => "Plan symbols",
        "22" => "Furniture",
        "23" => "Sanitary",
        "24" => "Vehicles & outdoor",
        _ => return None,
    })
}

/// Name eines Standard-Eintrags in `lang` (Deutsch: unverändert `de`).
pub fn name_in(lang: Lang, id: &str, de: &str) -> String {
    match lang {
        Lang::En => en_name(id).unwrap_or(de).to_string(),
        Lang::De => de.to_string(),
    }
}

/// Name einer Klasse in `lang`.
pub fn layer_name_in(lang: Lang, code: &str, de: &str) -> String {
    match lang {
        Lang::En => en_layer_name(code).unwrap_or(de).to_string(),
        Lang::De => de.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Jeder Standard-Eintrag hat einen englischen Namen (neue Standards brauchen einen Eintrag hier).
    #[test]
    fn alle_standards_haben_englischen_namen() {
        for (key, items) in crate::standards::library() {
            for it in items {
                let id = it["id"].as_str().unwrap();
                assert!(en_name(id).is_some(), "{key}/{id}: englischer Name fehlt in standards_names.rs");
            }
        }
        for (_, code, _, _, _) in crate::furniture_lib::CATEGORIES {
            assert!(en_layer_name(code).is_some(), "Klasse {code}");
        }
        for (code, ..) in crate::standards::DERIVED_CATEGORIES {
            assert!(en_layer_name(code).is_some(), "Klasse {code}");
        }
        assert!(en_layer_name(crate::standards::LIGHT_CATEGORY_CODE).is_some());
    }
}
