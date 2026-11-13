// Anonyme Wettbewerbs-Abgabe ([208]): was die Ausgaben über die Herkunft sagen dürfen. Ist
// `Project.competition` anonym, trägt keine Ausgabe Büro, Bearbeiter:in, Projektname, Projektnummer, Adresse
// oder Benutzername — nur das Kennwort. Gegenstück in TS: `src/export/competitionIdentity.ts` (dieselbe Regel für
// PDF, Berichte, STEP, Blender-Paket, Dateinamen). Der Plankopf löst das selbst auf (`layout_model.rs`).

use crate::model::Project;

/// Fester Zeitstempel anonymer Ausgaben: 2000-01-01 00:00:00 UTC (Sekunden seit 1970).
pub const NEUTRAL_EPOCH: f64 = 946_684_800.0;
/// Derselbe Zeitstempel als ISO-Text ohne Zone.
pub const NEUTRAL_ISO: &str = "2000-01-01T00:00:00";

/// Kennwort der Abgabe, wenn sie anonym ist (getrimmt; leer = anonym ohne Kennwort); `None` = nicht anonym.
pub fn anonymous_keyword(p: &Project) -> Option<String> {
    p.competition.as_ref().filter(|c| c.anonymous).map(|c| c.keyword.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CompetitionSettings;

    #[test]
    fn nur_anonym_liefert_kennwort() {
        let mut p = Project::default();
        assert_eq!(anonymous_keyword(&p), None);
        p.competition = Some(CompetitionSettings { anonymous: false, keyword: "K".into(), ..Default::default() });
        assert_eq!(anonymous_keyword(&p), None);
        p.competition = Some(CompetitionSettings { anonymous: true, keyword: " FALKE 7 ".into(), ..Default::default() });
        assert_eq!(anonymous_keyword(&p).as_deref(), Some("FALKE 7"));
    }
}
