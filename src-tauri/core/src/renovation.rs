//! [271] Umbau wie Archicads „Renovation“: Status je Bauteil (Bestand, Abbruch, Neu), Etappen und Umbaufilter.
//!
//! **Ein Ort im Kern** für „ist sichtbar / wie gezeichnet im Filter F“: Grundriss (`plan/domains.rs::Ctx`), Schnitt
//! (`plan/section/query.rs`), Ansicht (`plan/elevation`), 3D (`model3d`), Kennzahlen und Exporte fragen [`View`]
//! bzw. [`Resolved`] — wie die Klassen-Sichtbarkeit ([180]) und die Regel „Ausblenden“ ([33]).
//!
//! - **Status** (`Renovation.status`) fehlt ⇒ Bestand (Vorgabe beim Zeichnen, Wunsch Maintainer 17.11.). Eine Öffnung
//!   ohne eigenen Status folgt ihrer Wand.
//! - **Filter** (eingebaut, s. [`BUILTIN`], oder `Project.renovation.filters`): je Status zeigen, ausblenden oder mit
//!   Umbau-Farbe ([`Style`], SIA 400: Bestand grau, Abbruch gelb gestrichelt, Neu rot; anpassbar in
//!   `Project.renovation.styles`). Ausgeblendetes ist wie nicht vorhanden: es verdeckt nichts, eine ausgeblendete
//!   Öffnung schliesst ihre Wand (wie die Regel „Ausblenden“).
//! - **Etappen** (`Project.renovation.phases`, Reihenfolge der Liste): Ein Filter „bis Etappe n“ zeigt den Stand
//!   der Etappe n — Neues früherer Etappen ist dann Bestand, Abbruch früherer Etappen ist weg, Neues späterer
//!   Etappen fehlt noch, Abbruch späterer Etappen steht noch als Bestand. Ohne Etappe gelten die Status unverändert.
//! - **Öffnungen in Bestandswänden** (fachlich wie im Umbauplan üblich): Eine neue Öffnung in einer Bestandswand
//!   bricht dort Mauerwerk ab — der Wandteil in der Öffnung ist ein Abbruch-Stück ([`Patch`], gelb). Eine Öffnung
//!   „Abbruch“ wird zugemauert — die Ausfachung ist ein Neu-Stück (rot). Ist die Öffnung ausgeblendet (Bestand:
//!   die neue Öffnung gibt es noch nicht; Neubau/Endzustand: die alte ist zu), ist die Wand dort geschlossen.
//! - **Varianten** ([272], `design_options.rs`): Die Variantenkombination der Darstellung (je Satz eine Variante,
//!   Vorgabe die Hauptvariante) gehört mit in die [`View`]: Elemente anderer Varianten sind ausgeblendet wie
//!   Ausgeblendetes des Umbaufilters (auch 2D-Zeichnungen). Darum gibt es eine `View` auch ohne Umbaufilter, sobald
//!   das Projekt Elemente in Varianten hat.
//! - **Sanierung je Schicht** ([274], [`build_up`]): typbasiert. Ein Bestands-Wandtyp trägt seinen Sanierungstyp
//!   (`WallType.renovationTarget`, dazu Bezugsseite `renovationSide` und die manuelle Zuordnung je Schicht
//!   `renovationOld`/`renovationNew`); eine Bestandswand mit `renovation.renovated` bekommt ihn als neuen Aufbau
//!   (Ausnahme je Wand: `renovation.newTypeId`). Zuordnung von der Bezugsseite her (Vorgabe innen: Kern bleibt, die
//!   Aussenseite verschiebt sich; aussen = Innendämmung): gleicher Baustoff, gleiche Dicke und gleiche Lage ⇒ Bestand,
//!   nur alt ⇒ Abbruch, nur neu ⇒ Neu; manuell je Schicht überschreibbar (z. B. ersetzter Baustoff gleicher Art).
//!   Der Filter wählt den gezeigten Aufbau (Abbruch sichtbar, Neu nicht ⇒ alt; Neu sichtbar, Abbruch nicht ⇒ neu;
//!   beide ⇒ überlagert in Teilschichten, Abbruch als gestrichelte Kontur über der Neu-Füllung). Die Wand-Achse
//!   bleibt; die Ableitungen sehen eine Ersatzwand mit dem gezeigten Aufbau ([`Resolved::project`],
//!   [`with_build_ups`]), die Farben gelten je Schicht ([`WallLook`]). Ohne Umbaufilter gilt der Bestandstyp.
//!   Decken und Dächer gleich (Decken-/Dachtyp, [`build_up::Layered`]); Bezugsseite der Decke innen = unten, aussen = oben.

use crate::model::*;
use crate::plan::prim::Primitive;
use std::collections::{HashMap, HashSet};

/// Eingebaute Umbaufilter (Ids; Namen übersetzt die Oberfläche).
pub const BUILTIN: [&str; 5] = ["bestand", "abbruch", "neubau", "umbauplan", "endzustand"];

/// Strichmuster (Papier-mm) für Abbruch: gestrichelt wie verdeckte Kanten.
pub const DEMOLISH_DASH: [f64; 2] = crate::plan::line_pattern::HIDDEN;

/// Eingebauter Filter nach Id.
pub fn builtin(id: &str) -> Option<RenovationFilter> {
    use RenovationShow::{Hide, Override, Show};
    let (existing, demolish, new) = match id {
        // Bestandsplan: alles, was heute steht (auch das, was abgebrochen wird), ohne Farbe.
        "bestand" => (Show, Show, Hide),
        // Abbruchplan: Bestand, Abbruch gelb.
        "abbruch" => (Show, Override, Hide),
        // Neubauplan: Bestand, Neu rot, Abbruch weg.
        "neubau" => (Show, Hide, Override),
        // Umbauplan: alle drei in den Umbau-Farben.
        "umbauplan" => (Override, Override, Override),
        // Endzustand: Bestand und Neu ohne Farbe, Abbruch weg.
        "endzustand" => (Show, Hide, Show),
        _ => return None,
    };
    Some(RenovationFilter { id: id.to_string(), name: id.to_string(), existing, demolish, new, ..Default::default() })
}

/// Filter nach Id (eigene vor eingebauten), sonst nach Name ohne Gross-/Kleinschreibung (CLI `--renovation`).
pub fn find_filter(p: &Project, key: &str) -> Option<RenovationFilter> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    let own = p.renovation.as_ref().and_then(|r| r.filters.as_deref()).unwrap_or(&[]);
    if let Some(f) = own.iter().find(|f| f.id == key) {
        return Some(f.clone());
    }
    if let Some(f) = builtin(key) {
        return Some(f);
    }
    let low = key.to_lowercase();
    if let Some(f) = own.iter().find(|f| f.name.to_lowercase() == low) {
        return Some(f.clone());
    }
    builtin(&low)
}

/// Etappen des Projekts in ihrer Reihenfolge.
pub fn phases(p: &Project) -> &[RenovationPhase] {
    p.renovation.as_ref().and_then(|r| r.phases.as_deref()).unwrap_or(&[])
}

/// Index einer Etappe nach Id oder Name (ohne Gross-/Kleinschreibung); `None` = unbekannt.
pub fn phase_index(p: &Project, key: &str) -> Option<usize> {
    let ph = phases(p);
    let low = key.trim().to_lowercase();
    ph.iter().position(|x| x.id == key).or_else(|| ph.iter().position(|x| x.name.to_lowercase() == low))
}

/// Status eines Elements (fehlt/unbekannt ⇒ Bestand).
pub fn status_of(r: Option<&Renovation>) -> RenovationStatus {
    match r.map(|r| r.status) {
        Some(RenovationStatus::Demolish) => RenovationStatus::Demolish,
        Some(RenovationStatus::New) => RenovationStatus::New,
        _ => RenovationStatus::Existing,
    }
}

/// Umbau-Angaben einer Öffnung: eigene, sonst die ihrer Wand.
pub fn opening_renovation<'a>(p: &'a Project, o: &'a Opening) -> Option<&'a Renovation> {
    o.renovation.as_ref().or_else(|| p.walls.iter().find(|w| w.id == o.host_wall_id).and_then(|w| w.renovation.as_ref()))
}

/// Umbau-Angaben eines Baums: sein Bestand ([149], `Tree.status`) IST der Umbau-Status — bestehend = Bestand, neu = Neu,
/// zu fällen = Abbruch. Ein Feld, keine zweite Wahrheit (der Baum trägt kein eigenes `renovation`); Etappen kennt er nicht
/// (gilt als Etappe 1).
pub fn tree_renovation(t: &Tree) -> Renovation {
    let status = match t.status {
        TreeStatus::New => RenovationStatus::New,
        TreeStatus::Remove => RenovationStatus::Demolish,
        _ => RenovationStatus::Existing,
    };
    Renovation { status, ..Default::default() }
}

/// Nimmt eine 2D-Zeichnung am Umbaufilter teil? Möbel und Symbole (Objekte der Bibliothek, Blöcke) immer (ohne Angabe =
/// Bestand); alle übrigen 2D-Elemente (Linien, Masse, Texte, Koten, Raster …) nur mit ausdrücklichem Umbau-Status — sonst
/// blieben im Umbauplan alle Masse und Beschriftungen grau.
pub fn drawing_takes_part(d: &Drawing2D) -> bool {
    d.renovation.is_some() || matches!(d.geom, Drawing2DGeom::Libobj { .. } | Drawing2DGeom::Block { .. })
}

/// Umbau-Farbe eines Status, aufgelöst (Projekt-Vorgabe über der SIA-Vorgabe).
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    /// Füllung der Schnittflächen (ohne Muster).
    pub fill: String,
    /// Linienfarbe (`None` = Linien wie ohne Filter).
    pub line: Option<String>,
    /// Linien gestrichelt ([`DEMOLISH_DASH`]).
    pub dashed: bool,
    /// [272] Grau ausserhalb der Bearbeitungsvariante ([`ghost_style`]): alle gefüllten Flächen des Elements (nicht nur
    /// die Schnittfläche) in der Füllfarbe, ohne Muster.
    pub ghost: bool,
}

/// [272] Grau für Elemente ausserhalb der Bearbeitungsvariante (Häkchen „Elemente ausserhalb der Variante grau
/// einfärben“, nur Bildschirm): helles Grau, mit dem Papier gemischt wie die Pausfolie (`plan/trace.rs::Tone`), damit es
/// halbtransparent wirkt und in Ansicht und 3D (nur `#rrggbb`) gleich aussieht.
pub fn ghost_style() -> Style {
    Style { fill: "#e3e3e3".into(), line: Some("#a8a8a8".into()), dashed: false, ghost: true }
}

/// [275] Vorgabe Bestand: mittleres Grau (SIA 400).
pub const EXISTING_FILL: &str = "#a6a6a6";
/// [275] Vorgabe Abbruch: ruhiges Ocker-Gelb statt Signalgelb (#ffd800, Wunsch Maintainer 17.11.: „weniger leuchtend“) —
/// auf weissem Papier noch klar gelb, neben dem Grau des Bestands unterscheidbar, im dunklen Thema nicht grell.
pub const DEMOLISH_FILL: &str = "#e8c35a";
/// [275] Vorgabe Neu: gedämpftes Ziegelrot statt Signalrot (#e3001b), Linie eine Stufe dunkler.
pub const NEW_FILL: &str = "#c8524a";
pub const NEW_LINE: &str = "#9e3a33";

/// SIA-400-Vorgabe: Bestand grau, Abbruch gelb und gestrichelt, Neu rot ([275] gedämpfte Töne).
pub fn default_style(s: RenovationStatus) -> Style {
    match s {
        RenovationStatus::Demolish => Style { fill: DEMOLISH_FILL.into(), line: None, dashed: true, ghost: false },
        RenovationStatus::New => Style { fill: NEW_FILL.into(), line: Some(NEW_LINE.into()), dashed: false, ghost: false },
        _ => Style { fill: EXISTING_FILL.into(), line: None, dashed: false, ghost: false },
    }
}

/// [275] Farbe eines Stifts (`ColorPen.id`) im aktiven Stiftsatz; `None` ohne aktiven Satz oder Eintrag (dann gilt die
/// freie Farbe bzw. die Vorgabe — anders als bei Bauteilen kein Ersatz-Grau, damit ein Umbau-Plan nie grau wird).
fn pen_color(p: &Project, pen: &str) -> Option<String> {
    let pen = pen.trim();
    if pen.is_empty() {
        return None;
    }
    let active = p.active_pen_set_id.as_deref()?;
    let set = p.pen_sets.as_deref()?.iter().find(|s| s.id == active)?;
    let c = set.pens.get(pen)?.color.trim();
    (!c.is_empty()).then(|| c.to_string())
}

fn pick(x: &RenovationStyles, s: RenovationStatus) -> Option<&RenovationStyle> {
    match s {
        RenovationStatus::Demolish => x.demolish.as_ref(),
        RenovationStatus::New => x.new.as_ref(),
        _ => x.existing.as_ref(),
    }
}

/// Eigene Angaben `o` über `st` legen: Stift vor freier Farbe, fehlende Felder lassen `st` stehen.
fn apply_own(p: &Project, st: &mut Style, o: &RenovationStyle) {
    let free = |v: &Option<String>| v.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(str::to_string);
    if let Some(f) = o.fill_pen.as_deref().and_then(|x| pen_color(p, x)).or_else(|| free(&o.fill)) {
        st.fill = f;
    }
    if let Some(l) = o.line_pen.as_deref().and_then(|x| pen_color(p, x)) {
        st.line = Some(l);
    } else if let Some(l) = o.line.as_deref().map(str::trim) {
        st.line = (!l.is_empty()).then(|| l.to_string());
    }
    if let Some(d) = o.dashed {
        st.dashed = d;
    }
}

/// Umbau-Farbe eines Status im Projekt.
pub fn style(p: &Project, s: RenovationStatus) -> Style {
    let mut st = default_style(s);
    if let Some(o) = p.renovation.as_ref().and_then(|r| r.styles.as_ref()).and_then(|x| pick(x, s)) {
        apply_own(p, &mut st, o);
    }
    st
}

/// [275] Umbau-Farbe eines Status für Elemente der Etappe `ph`: deren eigene Angaben über der Projektfarbe;
/// `None`, wenn die Etappe für diesen Status nichts Eigenes hat.
pub fn phase_style(p: &Project, s: RenovationStatus, ph: &RenovationPhase) -> Option<Style> {
    let o = ph.styles.as_ref().and_then(|x| pick(x, s))?;
    let mut st = style(p, s);
    apply_own(p, &mut st, o);
    Some(st)
}

const STATUSES: [RenovationStatus; 3] = [RenovationStatus::Existing, RenovationStatus::Demolish, RenovationStatus::New];

/// [275] Eigene Farben je Etappe (Index der Etappe → je Status), nur Etappen mit eigenen Angaben.
fn phase_styles(p: &Project) -> HashMap<usize, [Option<Style>; 3]> {
    phases(p)
        .iter()
        .enumerate()
        .filter(|(_, ph)| ph.styles.is_some())
        .map(|(i, ph)| (i, STATUSES.map(|s| phase_style(p, s, ph))))
        .filter(|(_, a)| a.iter().any(Option::is_some))
        .collect()
}

/// [275] Aufgelöste Umbau-Farben für die Oberfläche (Abfrage `renovationStyles`): SIA-Vorgabe, Projekt und Etappen mit
/// eigenen Angaben (Id → je Status), damit Muster im Panel/in der Legende genau die Farben des Plans zeigen.
pub fn styles_json(p: &Project) -> serde_json::Value {
    use serde_json::{json, Map, Value};
    let one = |st: &Style| json!({"fill": st.fill, "line": st.line, "dashed": st.dashed});
    let set = |f: &dyn Fn(RenovationStatus) -> Style| json!({"existing": one(&f(STATUSES[0])), "demolish": one(&f(STATUSES[1])), "new": one(&f(STATUSES[2]))});
    let mut ph = Map::new();
    for x in phases(p).iter().filter(|x| x.styles.is_some()) {
        ph.insert(x.id.clone(), set(&|s| phase_style(p, s, x).unwrap_or_else(|| style(p, s))));
    }
    json!({"defaults": set(&default_style), "project": set(&|s| style(p, s)), "phases": Value::Object(ph)})
}

/// Wie ein Element im Filter erscheint.
#[derive(Clone, Debug, PartialEq)]
pub enum Treat {
    Show,
    Hide,
    Style(Style),
}

/// Ein aufgelöster Umbaufilter einer Darstellung.
#[derive(Clone, Debug)]
pub struct View {
    /// Umbaufilter; `None` = keiner (nur die Variantenkombination wirkt).
    pub filter: Option<RenovationFilter>,
    /// [272] Variantenkombination; `None` = das Projekt hat keine Elemente in Varianten.
    pub options: Option<crate::design_options::Combination>,
    /// Etappe, bis zu der der Filter gilt (Index), `None` = alle.
    pub upto: Option<usize>,
    /// [272] Bearbeitungsvariante der Bildschirm-Darstellung (Stift; [`View::editing`]), `None` = keine.
    pub edit: Option<crate::design_options::Edit>,
    phases: HashMap<String, usize>,
    styles: [Style; 3],
    /// [275] Eigene Farben je Etappe (Index → je Status).
    phase_styles: HashMap<usize, [Option<Style>; 3]>,
}

impl View {
    /// Filter `filter` (Id oder Name) bis Etappe `phase` (Id oder Name); `None` ohne (gültigen) Filter.
    /// [272] Mit der Hauptkombination der Varianten (sofern das Projekt Elemente in Varianten hat).
    pub fn new(p: &Project, filter: Option<&str>, phase: Option<&str>) -> Option<View> {
        Self::with(p, filter, phase, &[], &[])
    }

    /// Filter und Etappe wie [`Self::new`], dazu die Variantenkombination aus gespeicherten Wahlen (`stored`:
    /// Ebene, Vorlage, Ausschnitt, Viewport — spätere gehen vor) und der ausdrücklichen Anfrage (`request`, Ids
    /// oder Namen; CLI `--options`). `None` ohne Filter und ohne Elemente in Varianten.
    pub fn with(p: &Project, filter: Option<&str>, phase: Option<&str>, stored: &[&std::collections::BTreeMap<String, String>], request: &[(String, String)]) -> Option<View> {
        let options = crate::design_options::active(p).then(|| crate::design_options::Combination::resolve(p, stored, request));
        Self::with_combination(p, filter, phase, options)
    }

    /// Wie [`Self::with`] mit fertiger Kombination (`None` = ohne Varianten).
    pub fn with_combination(p: &Project, filter: Option<&str>, phase: Option<&str>, options: Option<crate::design_options::Combination>) -> Option<View> {
        let filter = filter.and_then(|f| find_filter(p, f));
        let options = options.filter(|c| !c.choice.is_empty() && crate::design_options::active(p));
        if filter.is_none() && options.is_none() {
            return None;
        }
        let upto = if filter.is_some() { phase.filter(|s| !s.trim().is_empty()).and_then(|s| phase_index(p, s)) } else { None };
        let phases = phases(p).iter().enumerate().map(|(i, x)| (x.id.clone(), i)).collect();
        let styles = [style(p, RenovationStatus::Existing), style(p, RenovationStatus::Demolish), style(p, RenovationStatus::New)];
        Some(View { filter, options, upto, phases, styles, phase_styles: phase_styles(p), edit: None })
    }

    /// [272] Mit Bearbeitungsvariante (Stift, nur Bildschirm-Anfragen `designOptionEdit`): die Variante ist sichtbar (geht
    /// der Kombination vor — Stift impliziert Auge), mit `grey` bekommt alles ausserhalb [`ghost_style`]. Gibt es
    /// sonst keine `View` (kein Filter, keine Elemente in Varianten), entsteht eine. `edit = None` ⇒ `v` unverändert.
    pub fn editing(v: Option<View>, p: &Project, edit: Option<crate::design_options::Edit>) -> Option<View> {
        let Some(e) = edit else { return v };
        let mut v = v.unwrap_or_else(|| {
            let styles = [style(p, RenovationStatus::Existing), style(p, RenovationStatus::Demolish), style(p, RenovationStatus::New)];
            View { filter: None, options: None, upto: None, phases: HashMap::new(), styles, phase_styles: HashMap::new(), edit: None }
        });
        let c = v.options.get_or_insert_with(|| crate::design_options::Combination::primary(p));
        c.choice.insert(e.set.clone(), e.option.clone());
        v.edit = Some(e);
        Some(v)
    }

    /// Filter einer Darstellung: ausdrücklich angefragt (CLI, Blatt-Ausschnitt), sonst der der Ebene `level_id`
    /// (`DrawingLevel.renovationFilter`/`renovationPhase`, wie die Modelldarstellung [173]). [272] Dazu die
    /// Variantenkombination der Ebene (`designOptions`), darüber `options` (Anfrage).
    pub fn for_level(p: &Project, level_id: &str, filter: Option<&str>, phase: Option<&str>, options: &[(String, String)]) -> Option<View> {
        let l = p.floor(level_id);
        let f = filter.filter(|s| !s.is_empty()).or_else(|| l.and_then(|l| l.renovation_filter.as_deref()));
        let ph = if filter.is_some_and(|s| !s.is_empty()) { phase } else { phase.or_else(|| l.and_then(|l| l.renovation_phase.as_deref())) };
        let own = l.and_then(|l| crate::design_options::stored_choice(p, l.design_option_combination.as_deref(), l.design_options.as_ref()));
        Self::with(p, f, ph, &own.iter().collect::<Vec<_>>(), options)
    }

    /// Zustand des Elements in der Etappe des Filters; `None` = es steht dort (noch/schon) nicht.
    pub fn state(&self, r: Option<&Renovation>) -> Option<RenovationStatus> {
        let s = status_of(r);
        let Some(l) = self.upto else { return Some(s) };
        let i = r.and_then(|r| r.phase.as_deref()).and_then(|id| self.phases.get(id).copied()).unwrap_or(0);
        use std::cmp::Ordering::*;
        match (s, i.cmp(&l)) {
            (RenovationStatus::New, Greater) | (RenovationStatus::Demolish, Less) => None,
            (RenovationStatus::New, Less) | (RenovationStatus::Demolish, Greater) => Some(RenovationStatus::Existing),
            (s, _) => Some(s),
        }
    }

    /// Darstellung eines Zustands im Filter (mit den Farben des Projekts).
    pub fn treat_state(&self, s: Option<RenovationStatus>) -> Treat {
        self.treat_in(s, None)
    }

    /// Darstellung eines Zustands, mit den Farben der Etappe `phase` (Index), sofern sie eigene hat.
    fn treat_in(&self, s: Option<RenovationStatus>, phase: Option<usize>) -> Treat {
        let Some(s) = s else { return Treat::Hide };
        let Some(filter) = &self.filter else { return Treat::Show };
        let (show, k) = match s {
            RenovationStatus::Demolish => (filter.demolish, 1),
            RenovationStatus::New => (filter.new, 2),
            _ => (filter.existing, 0),
        };
        match show {
            RenovationShow::Hide => Treat::Hide,
            RenovationShow::Override => {
                let own = phase.and_then(|i| self.phase_styles.get(&i)).and_then(|a| a[k].as_ref());
                Treat::Style(own.unwrap_or(&self.styles[k]).clone())
            }
            _ => Treat::Show,
        }
    }

    /// Darstellung eines Elements mit diesen Umbau-Angaben. [275] Zeigt es noch seinen eigenen Status (nicht schon als
    /// Bestand einer späteren Etappe), gelten die eigenen Farben seiner Etappe.
    pub fn treat(&self, r: Option<&Renovation>) -> Treat {
        let s = self.state(r);
        let own = if s == Some(status_of(r)) { r.and_then(|r| r.phase.as_deref()).and_then(|id| self.phases.get(id).copied()) } else { None };
        self.treat_in(s, own)
    }

    /// Ist ein Element mit diesen Angaben im Filter sichtbar?
    pub fn visible(&self, r: Option<&Renovation>) -> bool {
        self.treat(r) != Treat::Hide
    }

    /// Ausgeblendete Elemente, Umbau-Farben und Ersatzstücke der Öffnungen für das ganze Projekt.
    pub fn resolve(&self, p: &Project) -> Resolved {
        let mut out = Resolved::default();
        // [272] Elemente anderer Varianten: ausgeblendet (Öffnungen ausgeblendeter Wände mit).
        if let Some(c) = &self.options {
            out.hidden = c.hidden(p);
        }
        if self.filter.is_some() {
            self.resolve_filter(p, &mut out);
        }
        // [272] Grau ausserhalb der Bearbeitungsvariante: geht der Umbau-Farbe vor; Ausgeblendetes bleibt weg.
        // Im 3D-Fenster (`layer`) zeigt die Geisterschicht das Grau, nicht die Teilefarbe.
        if let Some(e) = self.edit.as_ref().filter(|e| e.grey && !e.layer) {
            let g = ghost_style();
            for id in e.outside(p) {
                if !out.hidden.contains(&id) {
                    out.styled.insert(id, g.clone());
                }
            }
            out.patches.retain(|pa| !out.styled.get(&pa.opening_id).is_some_and(|s| s.ghost));
        }
        out
    }

    /// Ausgeblendetes, Farben und Ersatzstücke des Umbaufilters (mit Filter).
    fn resolve_filter(&self, p: &Project, out: &mut Resolved) {
        let put = |id: &str, t: Treat, out: &mut Resolved| match t {
            Treat::Hide => {
                out.hidden.insert(id.to_string());
            }
            Treat::Style(s) => {
                out.styled.insert(id.to_string(), s);
            }
            Treat::Show => {}
        };
        let mut wall_state: HashMap<&str, Option<RenovationStatus>> = HashMap::new();
        for w in &p.walls {
            let s = self.state(w.renovation.as_ref());
            wall_state.insert(w.id.as_str(), s);
            // [274] Sanierte Bestandswand: Aufbau und Farben je Schicht statt einer Farbe für die ganze Wand.
            if s == Some(RenovationStatus::Existing) {
                if let Some(look) = build_up::look(self, p, w) {
                    if let Some(Treat::Style(st)) = look.treat.first() {
                        out.faces.insert(w.id.clone(), st.clone());
                    }
                    if look.pieces.is_empty() {
                        out.hidden.insert(w.id.clone());
                    }
                    if look.new_type.is_none() && w.extra.0.contains_key(build_up::ORIGIN) {
                        out.restore = true;
                    }
                    if let Some(t) = &look.new_type {
                        if !out.wall_types.iter().any(|x| x.id == t.id) {
                            out.wall_types.push(t.clone());
                        }
                    }
                    out.walls.insert(w.id.clone(), look);
                    continue;
                }
            }
            put(&w.id, self.treat(w.renovation.as_ref()), out);
        }
        // [274] Sanierte Bestandsdecken und -dächer: Aufbau und Farben je Schicht wie bei den Wänden.
        let layered = |id: &str, look: Option<WallLook>, has_origin: bool, out: &mut Resolved| -> bool {
            let Some(look) = look else { return false };
            if let Some(Treat::Style(st)) = look.treat.first() {
                out.faces.insert(id.to_string(), st.clone());
            }
            if look.pieces.is_empty() {
                out.hidden.insert(id.to_string());
            }
            if look.new_type.is_none() && has_origin {
                out.restore = true;
            }
            out.slabs.insert(id.to_string(), look);
            true
        };
        for x in p.ceilings.iter().flatten() {
            let s = self.state(x.renovation.as_ref());
            if s == Some(RenovationStatus::Existing) && layered(&x.id, build_up::ceiling_look(self, p, x), x.extra.0.contains_key(build_up::ORIGIN), out) {
                continue;
            }
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.roofs.iter().flatten() {
            let s = self.state(x.renovation.as_ref());
            if s == Some(RenovationStatus::Existing) && layered(&x.id, build_up::roof_look(self, p, x), x.extra.0.contains_key(build_up::ORIGIN), out) {
                continue;
            }
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for o in p.openings.iter().flatten() {
            let host = wall_state.get(o.host_wall_id.as_str()).copied().flatten();
            if out.hidden.contains(&o.host_wall_id) {
                out.hidden.insert(o.id.clone());
                continue;
            }
            let r = opening_renovation(p, o);
            let s = self.state(r);
            put(&o.id, self.treat(r), out);
            // Ersatzstück nur, wenn die Öffnung einen anderen Zustand hat als ihre (Bestands-)Wand.
            if o.renovation.is_none() || host != Some(RenovationStatus::Existing) {
                continue;
            }
            let virt = match s {
                Some(RenovationStatus::New) => RenovationStatus::Demolish,
                Some(RenovationStatus::Demolish) => RenovationStatus::New,
                _ => continue,
            };
            // [275] Das Stück gehört zur Etappe der Öffnung (deren eigene Farben).
            if let Treat::Style(st) = self.treat(Some(&Renovation { status: virt, phase: r.and_then(|r| r.phase.clone()), ..Default::default() })) {
                out.patches.push(Patch { opening_id: o.id.clone(), wall_id: o.host_wall_id.clone(), status: virt, style: st, closed: out.hidden.contains(&o.id) });
            }
        }
        for x in p.stairs.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.columns.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        // [279] Geländer.
        for x in p.railings.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.extruded_solids.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        // [271] 2D-Zeichnungen (Möbel, Symbole und Elemente mit ausdrücklichem Status) und Bäume ([149]: Status = Umbau-Status).
        for x in p.drawings2d.iter().filter(|d| drawing_takes_part(d)) {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for t in p.trees.iter().flatten() {
            put(&t.id, self.treat(Some(&tree_renovation(t))), out);
        }
        // Räume: nur sichtbar oder nicht (ein Raum ist kein Bauteil, er bekommt keine Umbau-Farbe).
        for x in p.rooms.iter().flatten() {
            if !self.visible(x.renovation.as_ref()) {
                out.hidden.insert(x.id.clone());
            }
        }
    }

    /// Füll- und Linienfarben der Status, die der Filter farbig zeigt (bleiben in Schwarz-Weiss erhalten).
    pub fn colors(&self) -> Vec<String> {
        let mut out = Vec::new();
        let Some(f) = &self.filter else { return out };
        for (k, show) in [f.existing, f.demolish, f.new].into_iter().enumerate() {
            if show == RenovationShow::Override {
                // [275] Dazu die eigenen Farben der Etappen.
                for st in std::iter::once(&self.styles[k]).chain(self.phase_styles.values().filter_map(|a| a[k].as_ref())) {
                    out.push(st.fill.clone());
                    out.extend(st.line.clone());
                }
            }
        }
        out
    }

    /// Schlüssel für Caches (Filter samt Darstellungen, Etappe, Farben).
    pub fn key(&self) -> String {
        let opts = self.options.as_ref().map_or(String::new(), |c| c.key());
        let edit = self.edit.as_ref().map_or(String::new(), |e| format!("|edit:{}", e.key()));
        match &self.filter {
            Some(f) => {
                let mut ph: Vec<_> = self.phase_styles.iter().collect();
                ph.sort_by_key(|(i, _)| **i);
                format!("{}:{:?}{:?}{:?}:{:?}:{:?}{ph:?}|{opts}{edit}", f.id, f.existing, f.demolish, f.new, self.upto, self.styles)
            }
            None => format!("-|{opts}{edit}"),
        }
    }
}

/// Ersatzstück einer Öffnung in einer Bestandswand: abgebrochenes Mauerwerk (neue Öffnung) bzw. Ausfachung
/// (zugemauerte Öffnung), mit der Umbau-Farbe seines Status.
#[derive(Clone, Debug, PartialEq)]
pub struct Patch {
    pub opening_id: String,
    pub wall_id: String,
    /// Status des Stücks (Abbruch für eine neue Öffnung, Neu für eine zugemauerte).
    pub status: RenovationStatus,
    pub style: Style,
    /// Die Öffnung ist ausgeblendet (die Wand ist dort geschlossen): das Stück liegt über der Wand.
    pub closed: bool,
}

/// Ergebnis eines Filters für ein Projekt.
#[derive(Clone, Debug, Default)]
pub struct Resolved {
    /// Ausgeblendete Elemente (ids): Wände nehmen ihre Öffnungen mit.
    pub hidden: HashSet<String>,
    /// Elemente mit Umbau-Farbe (id → Farbe).
    pub styled: HashMap<String, Style>,
    pub patches: Vec<Patch>,
    /// [274] Sanierte Wände (id → gezeigter Aufbau mit Farben je Schicht).
    pub walls: HashMap<String, WallLook>,
    /// [274] Wandtypen der gezeigten Aufbauten (neu bzw. überlagert), in [`Self::project`] ergänzt.
    pub wall_types: Vec<WallType>,
    /// [274] Ansichtsflächen sanierter Wände, Decken und Dächer (Ansicht, Axo, 3D, Grundriss-Linien der Decken und
    /// Dächer): Farbe der äussersten bzw. obersten Schicht.
    pub faces: HashMap<String, Style>,
    /// [274] Sanierte Decken und Dächer (id → gezeigter Aufbau mit Farben je Schicht, Schichten oben/aussen → unten/innen).
    pub slabs: HashMap<String, WallLook>,
    /// [274] Eine schon umgestellte Ersatzwand muss auf den Bestand zurück ([`Self::swap_build_ups`]).
    pub restore: bool,
}

impl Resolved {
    pub fn is_empty(&self) -> bool {
        self.hidden.is_empty() && self.styled.is_empty() && self.patches.is_empty() && self.walls.is_empty() && self.slabs.is_empty()
    }

    /// [274] Umbau-Farbe eines Elements für Linien und Flächen im Grundriss: eigene Farbe, sonst die oberste Schicht
    /// einer sanierten Decke bzw. eines sanierten Dachs (Wände färben je Schicht selbst).
    pub fn element_style(&self, id: &str) -> Option<&Style> {
        self.styled.get(id).or_else(|| if self.slabs.contains_key(id) { self.faces.get(id) } else { None })
    }

    /// [274] Darstellung der Schicht `li` (Schicht des gezeigten Aufbaus) einer sanierten Decke oder eines Dachs.
    pub fn slab_layer_style(&self, id: &str, li: usize) -> Option<Style> {
        self.slabs.get(id)?.layer_style(li)
    }

    /// Umbau-Farbe einer Ansichtsfläche (Element-Farbe, sonst die der äussersten Schicht einer sanierten Wand).
    pub fn surface(&self, id: &str) -> Option<&Style> {
        self.styled.get(id).or_else(|| self.faces.get(id))
    }

    /// Ersetzt der Filter Aufbauten (Wände mit anderem gezeigtem Aufbau)?
    pub fn swaps(&self) -> bool {
        self.restore || self.walls.values().chain(self.slabs.values()).any(|l| l.new_type.is_some())
    }

    /// Das Projekt dieser Darstellung: ohne Ausgeblendetes, sanierte Wände mit dem gezeigten Aufbau; `None` = unverändert.
    pub fn project(&self, p: &Project) -> Option<Project> {
        apply(p, Some(self), &self.hidden)
    }

    /// Sanierte Wände im Projekt `q` auf den gezeigten Aufbau umstellen (Achse bleibt, Bezugsseite bleibt stehen).
    pub fn swap_build_ups(&self, q: &mut Project) {
        if !self.swaps() {
            return;
        }
        for w in q.walls.iter_mut() {
            let Some(look) = self.walls.get(&w.id) else { continue };
            if w.wall_type_id == look.type_id {
                continue;
            }
            let Some(t) = &look.new_type else {
                // Zeigt der Filter den Bestand, aber die Wand ist schon umgestellt: zurück auf den Ursprung.
                let (ty, off, line) = build_up::origin(w);
                (w.wall_type_id, w.reference_offset, w.reference_line) = (ty, off, line);
                w.extra.0.remove(build_up::ORIGIN);
                continue;
            };
            let (ty, off, line) = build_up::origin(w);
            (w.wall_type_id, w.reference_offset, w.reference_line) = (ty, off, line);
            // Ursprung merken: ein zweites Auflösen auf dem umgestellten Projekt ergibt dasselbe (`build_up::origin`).
            let orig = serde_json::json!({"type": w.wall_type_id, "refOffset": w.reference_offset, "refLine": w.reference_line});
            w.extra.0.insert(build_up::ORIGIN.to_string(), orig);
            w.wall_type_id = t.id.clone();
            w.reference_offset = Some(look.ref_offset);
        }
        for t in &self.wall_types {
            if !q.wall_types.iter().any(|x| x.id == t.id) {
                q.wall_types.push(t.clone());
            }
        }
        // [274] Decken: Ersatz-Deckentyp; die Bezugsseite bleibt stehen (unten: neue Oberkante, oben: Unterkante folgt).
        for c in q.ceilings.iter_mut().flatten() {
            let Some(look) = self.slabs.get(&c.id) else { continue };
            if c.ceiling_type_id.as_deref() == Some(look.type_id.as_str()) && look.new_type.is_some() {
                continue;
            }
            build_up::restore_ceiling(c);
            let Some(t) = &look.new_type else { continue };
            let orig = serde_json::json!({"type": c.ceiling_type_id, "thickness": c.thickness, "top": c.top, "bottom": c.bottom});
            c.extra.0.insert(build_up::ORIGIN.to_string(), orig);
            if let Some(z) = look.level {
                c.top = Some(VerticalAnchor::Custom { z });
            }
            c.bottom = None;
            c.thickness = None;
            c.ceiling_type_id = Some(t.id.clone());
            let types = q.ceiling_types.get_or_insert_with(Vec::new);
            if !types.iter().any(|x| x.id == t.id) {
                types.push(CeilingType { id: t.id.clone(), name: t.name.clone(), layers: t.layers.clone(), ..Default::default() });
            }
        }
        // [274] Dächer: Ersatz-Dachtyp; Bezugsseite innen hebt die Dachhaut (Traufhöhe).
        for r in q.roofs.iter_mut().flatten() {
            let Some(look) = self.slabs.get(&r.id) else { continue };
            if r.roof_type_id.as_deref() == Some(look.type_id.as_str()) && look.new_type.is_some() {
                continue;
            }
            build_up::restore_roof(r);
            let Some(t) = &look.new_type else { continue };
            let orig = serde_json::json!({"type": r.roof_type_id, "base": r.base_elevation});
            r.extra.0.insert(build_up::ORIGIN.to_string(), orig);
            if let Some(z) = look.level {
                r.base_elevation = Some(z);
            }
            r.roof_type_id = Some(t.id.clone());
            let types = q.roof_types.get_or_insert_with(Vec::new);
            if !types.iter().any(|x| x.id == t.id) {
                types.push(RoofType { id: t.id.clone(), name: t.name.clone(), layers: t.layers.clone(), ..Default::default() });
            }
        }
        for c in self.walls.values().chain(self.slabs.values()).flat_map(|l| l.components.iter()) {
            if !q.components.iter().any(|x| x.id == c.id) {
                q.components.push(c.clone());
            }
        }
    }
}

/// [274] Projekt ohne `hidden` und mit den gezeigten Aufbauten von `r`; `None` = nichts zu ändern.
pub fn apply(p: &Project, r: Option<&Resolved>, hidden: &HashSet<String>) -> Option<Project> {
    let swaps = r.is_some_and(|r| r.swaps());
    if hidden.is_empty() && !swaps {
        return None;
    }
    let mut q = if hidden.is_empty() { p.clone() } else { without_hidden(p, hidden) };
    if let Some(r) = r {
        r.swap_build_ups(&mut q);
    }
    Some(q)
}

/// [274] Projekt einer Plan-Erzeugung mit den gezeigten Aufbauten (Ausgeblendetes bleibt, das blendet der Plan selbst
/// aus); ohne sanierte Wände geliehen.
pub fn with_build_ups<'a>(p: &'a Project, v: Option<View>) -> std::borrow::Cow<'a, Project> {
    if !build_up::any(p) {
        return std::borrow::Cow::Borrowed(p);
    }
    match v.map(|v| v.resolve(p)).filter(|r| r.swaps()) {
        Some(r) => {
            let mut q = p.clone();
            r.swap_build_ups(&mut q);
            std::borrow::Cow::Owned(q)
        }
        None => std::borrow::Cow::Borrowed(p),
    }
}

/// Das Projekt ohne die im Filter ausgeblendeten Elemente (Kennzahlen, 3D, Exporte, Schnitt und Ansicht).
pub fn without_hidden(p: &Project, hidden: &HashSet<String>) -> Project {
    let mut q = crate::plan::section::without_elements(p, hidden);
    if let Some(v) = &mut q.extruded_solids {
        v.retain(|x| !hidden.contains(&x.id));
    }
    // [272] 2D-Zeichnungen anderer Varianten, [271] Möbel und Symbole im Umbaufilter.
    q.drawings2d.retain(|x| !hidden.contains(&x.id));
    // [271] Bäume (Schnitt, Ansicht, 3D).
    if let Some(v) = &mut q.trees {
        v.retain(|x| !hidden.contains(&x.id));
    }
    q
}

/// [272] Das Projekt in Umbau-Zustand und Variantenkombination `c` (Vergleichstabelle); ohne Wirkung geliehen.
pub fn project_in_view<'a>(p: &'a Project, filter: Option<&str>, phase: Option<&str>, c: &crate::design_options::Combination) -> std::borrow::Cow<'a, Project> {
    filtered(p, View::with_combination(p, filter, phase, Some(c.clone())))
}

/// [271]/[272] Projekt im Zustand eines Anfrage-Texts ([`view_from_text`]: Umbaufilter, Etappe, Variantenkombination;
/// leer = Hauptkombination), sonst unverändert.
pub fn project_for_text<'a>(p: &'a Project, text: &str) -> std::borrow::Cow<'a, Project> {
    filtered(p, view_from_text(p, text))
}

/// Das Projekt ohne das in `v` Ausgeblendete (ohne Wirkung geliehen).
pub fn filtered(p: &Project, v: Option<View>) -> std::borrow::Cow<'_, Project> {
    match v {
        Some(v) => match v.resolve(p).project(p) {
            Some(q) => std::borrow::Cow::Owned(q),
            None => std::borrow::Cow::Borrowed(p),
        },
        None => std::borrow::Cow::Borrowed(p),
    }
}

/// Das Projekt im Zustand eines Filters (`filter`: Id/Name, `phase`: Etappe); ohne gültigen Filter unverändert.
pub fn project_in_state<'a>(p: &'a Project, filter: Option<&str>, phase: Option<&str>) -> std::borrow::Cow<'a, Project> {
    match View::new(p, filter, phase) {
        Some(v) => match v.resolve(p).project(p) {
            Some(q) => std::borrow::Cow::Owned(q),
            None => std::borrow::Cow::Borrowed(p),
        },
        None => std::borrow::Cow::Borrowed(p),
    }
}

/// Ist eine Füllung sichtbar (nicht leer/„none“/ganz durchsichtig)? Nur solche Flächen bekommen die Umbau-Farbe.
fn solid_fill(fill: &str) -> bool {
    let f = fill.trim();
    !(f.is_empty() || f == "none" || f == "transparent" || (f.starts_with('#') && f.len() == 9 && f.ends_with("00")))
}

/// Umbau-Farbe auf ein Primitiv: Schnittflächen in der Füllfarbe ohne Muster, Linien in der Linienfarbe,
/// gestrichelt bei Abbruch. Umrisse von Flächen werden dafür als Linien ausgegeben (`extra`), weil Flächen kein
/// Strichmuster tragen.
pub fn restyle(q: &mut Primitive, st: &Style, extra: &mut Vec<Primitive>) {
    restyle_with(q, st, extra, true);
}

/// Wie [`restyle`]; `fill = false` lässt die Füllung von Flächen (nur Linien in Farbe und Strichmuster).
pub fn restyle_with(q: &mut Primitive, st: &Style, extra: &mut Vec<Primitive>, with_fill: bool) {
    let dash = || Some(Some(DEMOLISH_DASH.to_vec()));
    match q {
        Primitive::Polygon { pts, fill, stroke, stroke_width_mm, hatch, no_stroke_edges, greyed, .. } => {
            if with_fill && solid_fill(fill) {
                *fill = st.fill.clone();
                *hatch = Box::new(crate::plan::style::no_hatch());
            }
            if let Some(l) = &st.line {
                if stroke.trim() != "none" && !stroke.is_empty() {
                    *stroke = l.clone();
                }
            }
            if st.dashed && stroke.trim() != "none" && !stroke.is_empty() && *stroke_width_mm > 0.0 && pts.len() >= 2 {
                let skip: HashSet<usize> = no_stroke_edges.iter().flatten().filter(|x| x.is_finite() && **x >= 0.0).map(|x| *x as usize).collect();
                let n = pts.len();
                for i in 0..n {
                    if skip.contains(&i) {
                        continue;
                    }
                    let (a, b) = (pts[i], pts[(i + 1) % n]);
                    extra.push(Primitive::Line { a, b, cls: "renovation-outline".into(), weight_mm: *stroke_width_mm, dash: dash(), zigzag: None, motif: None, color: Some(stroke.clone().into()), drawing_id: None, opening_id: None, stair_id: None, greyed: *greyed, opacity: None });
                }
                *stroke = "none".into();
            }
        }
        Primitive::Line { color, dash: d, greyed, .. } => {
            if let Some(l) = &st.line {
                *color = Some(l.clone().into());
            }
            // [272] Grau ausserhalb der Bearbeitungsvariante: auch Linien mit Klassenfarbe (Türbogen, Fensterrahmen).
            if st.ghost {
                *greyed = Some(true);
            }
            if st.dashed {
                *d = dash();
            }
        }
        Primitive::Arc { color, dash: d, greyed, .. } => {
            if let Some(l) = &st.line {
                *color = Some(l.clone().into());
            }
            if st.ghost {
                *greyed = Some(true);
            }
            if st.dashed {
                *d = dash();
            }
        }
        Primitive::DrawingCircle { stroke, dash: d, .. } | Primitive::DrawingArc { stroke, dash: d, .. } => {
            if let Some(l) = &st.line {
                *stroke = l.clone();
            }
            if st.dashed {
                *d = dash();
            }
        }
        _ => {}
    }
}

/// Element-Id eines Primitivs (Öffnung vor Wand und übrigen Bauteilen).
pub fn prim_element(q: &Primitive) -> Option<&str> {
    match q {
        Primitive::Polygon { opening_id, wall_id, ceiling_id, stair_id, extruded_solid_id, column_id, roof_id, .. } => {
            opening_id.as_deref().or(wall_id.as_deref()).or(ceiling_id.as_deref()).or(stair_id.as_deref()).or(extruded_solid_id.as_deref()).or(column_id.as_deref()).or(roof_id.as_deref())
        }
        Primitive::Line { opening_id, stair_id, .. } | Primitive::Arc { opening_id, stair_id, .. } => opening_id.as_deref().or(stair_id.as_deref()),
        _ => None,
    }
}

/// Strichzeichnung eines Objekts ohne Schnittfläche (Baum, Möbel): `prims[from..]` in der Linienfarbe des Status (sonst
/// seiner Füllfarbe: Bestand grau, Abbruch gelb gestrichelt, Neu rot); gefüllte Flächen (Stamm) in der Füllfarbe,
/// ausser mit `fill = false` (Silhouetten in Schnitt und Ansicht).
pub fn restyle_linework(prims: &mut Vec<Primitive>, from: usize, st: &Style, fill: bool) {
    if from >= prims.len() {
        return;
    }
    let st = Style { fill: st.fill.clone(), line: Some(st.line.clone().unwrap_or_else(|| st.fill.clone())), dashed: st.dashed, ghost: st.ghost };
    let mut extra = Vec::new();
    for q in prims[from..].iter_mut() {
        restyle_with(q, &st, &mut extra, fill);
    }
    prims.extend(extra);
}

/// Umbau-Farben auf `prims[from..]`: jedes Primitiv nach seinem Element ([`prim_element`]), sonst nach `owner`
/// (z. B. die Wand, deren Umrisslinien keine Id tragen). Umrisslinien gestrichelter Flächen kommen dahinter.
pub fn restyle_range(r: &Resolved, prims: &mut Vec<Primitive>, from: usize, owner: Option<&str>) {
    if (r.styled.is_empty() && r.slabs.is_empty()) || from >= prims.len() {
        return;
    }
    let mut extra = Vec::new();
    for q in prims[from..].iter_mut() {
        let id = prim_element(q).or(owner);
        // [274] Sanierte Decke/Dach: Linien in der Farbe der obersten Schicht.
        if let Some(st) = id.and_then(|id| r.element_style(id)) {
            // Symbole und Ansichten (Fenster, Türflügel, Treppenstufen, Decken- und Dachkanten): nur Linien.
            // [272] Grau ausserhalb der Bearbeitungsvariante: alle Flächen.
            let f = st.ghost || cut_fill(q);
            restyle_with(q, st, &mut extra, f);
        }
    }
    prims.extend(extra);
}

/// Schnittfläche eines Bauteils (Wand-Poché, geschnittene Stütze), die die Umbau-Füllung bekommt — nicht die Flächen der
/// Öffnungssymbole, Treppenstufen, Decken und Dächer (sonst wären Fensterrahmen oder Tritte grau/rot gefüllt).
fn cut_fill(q: &Primitive) -> bool {
    matches!(q, Primitive::Polygon { opening_id: None, wall_id: Some(_), .. } | Primitive::Polygon { opening_id: None, column_id: Some(_), .. })
}

/// Grundriss: Fläche eines Ersatzstücks (Wandband zwischen den Leibungen der Öffnung; bei Bogenwänden das Ringstück
/// zwischen den Versatzbögen), `None` ohne gültige Lage.
pub fn patch_ring(p: &Project, w: &Wall, o: &Opening) -> Option<Vec<Vec2>> {
    let total = p.wall_thickness(w, 0.2);
    let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
    if let Some(arc) = crate::wall_arc::WallArc::of_wall(w) {
        // Öffnungsmass in Bogenlänge der Achse (wie im Schnitt und in der Ansicht), Querversatz links der Laufrichtung.
        let axis = arc.length();
        let from = o.position.max(0.0).min(axis);
        let to = (o.position + o.width).min(axis).max(from);
        let (n0, n1) = (ref_off - total / 2.0, ref_off + total / 2.0);
        if !(to - from >= 1e-4) || ![from, to, n0, n1].iter().all(|x| x.is_finite()) {
            return None;
        }
        let st = arc.stations(from, to, arc.r_max(n0, n1));
        let at = |s: f64, n: f64| {
            let q = arc.point(s, n);
            Vec2 { x: q.x, y: q.y }
        };
        let ring: Vec<Vec2> = st.iter().map(|&s| at(s, n0)).chain(st.iter().rev().map(|&s| at(s, n1))).collect();
        return ring.iter().all(|v| v.x.is_finite() && v.y.is_finite()).then_some(ring);
    }
    let wr = crate::opening_geom::WallRef { start: crate::opening_geom::v(w.start.x, w.start.y), end: crate::opening_geom::v(w.end.x, w.end.y), total, ref_off };
    let (from, to) = crate::opening_geom::opening_interval(&wr, o.position, o.width)?;
    let fp = crate::plan::wall_poche::wall_footprint([w.start.x, w.start.y], [w.end.x, w.end.y], total, ref_off);
    let at = |s: f64, n: f64| Vec2 { x: fp.a[0] + fp.u[0] * s + fp.m[0] * n, y: fp.a[1] + fp.u[1] * s + fp.m[1] * n };
    let (n0, n1) = (ref_off - fp.half, ref_off + fp.half);
    let ring = vec![at(from, n0), at(to, n0), at(to, n1), at(from, n1)];
    ring.iter().all(|v| v.x.is_finite() && v.y.is_finite()).then_some(ring)
}

/// Grundriss: Ersatzstück als Fläche mit Umriss (gestrichelt bei Abbruch), an der Öffnung (Picken wählt sie).
pub fn patch_prims(ring: Vec<Vec2>, st: &Style, weight_mm: f64, opening_id: &str) -> Vec<Primitive> {
    let stroke = st.line.clone().unwrap_or_else(|| "#000000".into());
    let mut q = Primitive::Polygon {
        pts: ring,
        fill: st.fill.clone(),
        stroke,
        stroke_width_mm: weight_mm,
        hatch: Box::new(crate::plan::style::no_hatch()),
        greyed: None,
        opacity: None,
        no_stroke_edges: None,
        wall_id: None,
        drawing_id: None,
        ceiling_id: None,
        opening_id: Some(opening_id.to_string()),
        stair_id: None,
        room_id: None,
        extruded_solid_id: None,
        context_object_id: None,
        column_id: None,
        roof_id: None,
        section_line_id: None,
    };
    let mut extra = Vec::new();
    if st.dashed {
        restyle(&mut q, &Style { fill: st.fill.clone(), line: None, dashed: true, ghost: false }, &mut extra);
    }
    // Linien des Stücks tragen die Öffnung (Picken, Kontrast).
    for l in extra.iter_mut() {
        if let Primitive::Line { opening_id: oid, .. } = l {
            *oid = Some(opening_id.to_string());
        }
    }
    let mut out = vec![q];
    out.extend(extra);
    out
}

/// Umbaufilter aus einem JSON-Text (`{"renovation": Id/Name, "renovationPhase": Etappe}`, 3D und Kennzahlen);
/// ein Text ohne `{` ist selbst die Filter-Id. [272] `designOptions`: Variantenkombination (Text „Satz=Variante,…“
/// oder Objekt), ohne Angabe die Hauptkombination. `None` ohne Filter und ohne Elemente in Varianten.
pub fn view_from_text(p: &Project, text: &str) -> Option<View> {
    let t = text.trim();
    if !t.starts_with('{') {
        return View::new(p, Some(t).filter(|t| !t.is_empty()), None);
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else { return View::new(p, None, None) };
    let f = v.get("renovation").and_then(|x| x.as_str()).filter(|x| !x.is_empty());
    let req = crate::design_options::parse_request(v.get("designOptions"));
    View::with(p, f, v.get("renovationPhase").and_then(|x| x.as_str()), &[], &req)
}

/// [272] Wie [`view_from_text`] für Bildschirm-Anfragen (3D-Fenster): dazu die Bearbeitungsvariante `designOptionEdit`
/// ([`View::editing`]). Kennzahlen und Exporte nehmen [`view_from_text`] und kennen sie nicht.
pub fn screen_view_from_text(p: &Project, text: &str) -> Option<View> {
    let v = view_from_text(p, text);
    let t = text.trim();
    if !t.starts_with('{') {
        return v;
    }
    let Ok(j) = serde_json::from_str::<serde_json::Value>(t) else { return v };
    View::editing(v, p, crate::design_options::parse_edit(p, j.get("designOptionEdit")))
}

/// 3D: Teile in der Umbau-Farbe (Füllfarbe des Status) — Wände, Decken, Dächer, Stützen, Treppen, Körper.
pub fn color_parts(p: &Project, parts: &mut crate::model3d::Parts, r: &Resolved) {
    if r.styled.is_empty() && r.faces.is_empty() {
        return;
    }
    let rgb = |id: &str| r.surface(id).map(|s| crate::style::hex_to_rgb(&s.fill, crate::style::WALL_RGB));
    for w in &mut parts.walls {
        if let Some(c) = rgb(&w.wall_id) {
            w.color = c;
            w.material_index = None;
        }
    }
    for s in &mut parts.slabs {
        if let Some(c) = rgb(&s.ceiling_id) {
            s.color = c;
        }
    }
    // [274] Sanierte Decke: Farbe je Schicht (geschichtete Platten tragen ihre Schicht).
    let ceilings = p.ceilings.as_deref().unwrap_or(&[]);
    for s in &mut parts.slabs {
        if let crate::model3d::SlabSource::Ceiling { index, layer: Some(li) } = s.source {
            if let Some(st) = ceilings.get(index).and_then(|c| r.slab_layer_style(&c.id, li)) {
                s.color = crate::style::hex_to_rgb(&st.fill, crate::style::WALL_RGB);
            }
        }
    }
    let meshes = [&mut parts.column_meshes, &mut parts.stair_meshes, &mut parts.roof_meshes, &mut parts.solid_meshes, &mut parts.stair_railings];
    for list in meshes {
        for m in list.iter_mut() {
            if let Some(c) = m.owner.id(p).and_then(rgb) {
                m.color = c;
                m.vertex_colors = None;
                m.material_index = None;
            }
        }
    }
    for l in &mut parts.roof_layers {
        if let Some(c) = l.owner.id(p).and_then(rgb) {
            l.color = c;
        }
    }
    // [272] Grau ausserhalb der Bearbeitungsvariante: auch Fenster und Türen (Umbau-Farben lassen sie, wie sie sind).
    for m in parts.opening_meshes.iter_mut() {
        if let Some(st) = m.owner.id(p).and_then(|id| r.styled.get(id)).filter(|s| s.ghost) {
            m.color = crate::style::hex_to_rgb(&st.fill, crate::style::WALL_RGB);
            m.vertex_colors = None;
            m.material_index = None;
        }
    }
}

/// Liste der Filter für die Oberfläche (Abfrage `renovationFilters`): eingebaute, dann eigene.
pub fn filter_list(p: &Project) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = BUILTIN.iter().map(|id| serde_json::json!({"id": id, "name": id, "builtin": true})).collect();
    for f in p.renovation.as_ref().and_then(|r| r.filters.as_deref()).unwrap_or(&[]) {
        out.push(serde_json::json!({"id": f.id, "name": f.name, "builtin": false}));
    }
    out
}

/// Statuswort für Exporte (DXF-Layer-Endung, IFC `Pset_*Common.Status`).
pub fn ifc_status(s: RenovationStatus) -> &'static str {
    match s {
        RenovationStatus::Demolish => "DEMOLISH",
        RenovationStatus::New => "NEW",
        _ => "EXISTING",
    }
}

/// Umbau-Angaben eines Bauteils nach Id (Wand, Öffnung mit Wand-Rückfall, Decke, Dach, Treppe, Stütze, Körper, Raum).
pub fn renovation_of<'a>(p: &'a Project, id: &str) -> Option<&'a Renovation> {
    if let Some(w) = p.walls.iter().find(|w| w.id == id) {
        return w.renovation.as_ref();
    }
    if let Some(o) = p.openings.iter().flatten().find(|o| o.id == id) {
        return opening_renovation(p, o);
    }
    macro_rules! look {
        ($($f:ident),*) => {$(
            if let Some(x) = p.$f.iter().flatten().find(|x| x.id == id) {
                return x.renovation.as_ref();
            }
        )*};
    }
    look!(ceilings, roofs, stairs, columns, extruded_solids, rooms);
    p.drawings2d.iter().find(|d| d.id == id).and_then(|d| d.renovation.as_ref())
}

/// [274] Sanierung je Schicht: Typ-Paar Bestand → Sanierungstyp, Zuordnung der Schichten, gezeigter Aufbau je Filter.
pub mod build_up {
    use super::*;

    /// Toleranz für gleiche Dicke/Lage (m).
    pub const TOL: f64 = 0.0005;
    /// Marke an einer umgestellten Ersatzwand: ursprünglicher Typ und Achslage ([`Resolved::swap_build_ups`]).
    pub const ORIGIN: &str = "~renovationOrigin";

    /// Schicksal einer Schicht im Typ-Paar.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum Fate {
        /// Bleibt (Bestand).
        Kept,
        /// Nur im Bestandstyp: wird abgebrochen.
        Demolish,
        /// Nur im Sanierungstyp: neu.
        New,
    }

    /// Zuordnung je Schicht (Indizes in Typ-Reihenfolge aussen → innen).
    #[derive(Clone, Debug, PartialEq, serde::Serialize)]
    pub struct Matched {
        pub old: Vec<Fate>,
        pub new: Vec<Fate>,
    }

    /// Mehrschichtiger Typ mit Sanierungs-Angaben (Wand-, Decken-, Dachtyp): eine Zuordnungs-Logik für alle drei.
    pub trait Layered {
        fn type_id(&self) -> &str;
        fn type_name(&self) -> &str;
        fn type_layers(&self) -> &[Layer];
        fn target(&self) -> Option<&str>;
        fn side(&self) -> Option<RenovationSide>;
        fn old_ov(&self) -> Option<&[LayerRenovation]>;
        fn new_ov(&self) -> Option<&[LayerRenovation]>;
    }

    macro_rules! layered {
        ($($t:ty),*) => {$(
            impl Layered for $t {
                fn type_id(&self) -> &str { &self.id }
                fn type_name(&self) -> &str { &self.name }
                fn type_layers(&self) -> &[Layer] { &self.layers }
                fn target(&self) -> Option<&str> { self.renovation_target.as_deref() }
                fn side(&self) -> Option<RenovationSide> { self.renovation_side }
                fn old_ov(&self) -> Option<&[LayerRenovation]> { self.renovation_old.as_deref() }
                fn new_ov(&self) -> Option<&[LayerRenovation]> { self.renovation_new.as_deref() }
            }
        )*};
    }
    layered!(WallType, CeilingType, RoofType);

    /// Bauteilart einer Sanierung (Abfragen `renovationPair`/`renovationPairs`, Oberfläche).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Host {
        Wall,
        Ceiling,
        Roof,
    }

    impl Host {
        pub fn parse(s: &str) -> Host {
            match s {
                "ceiling" => Host::Ceiling,
                "roof" => Host::Roof,
                _ => Host::Wall,
            }
        }
        pub fn key(self) -> &'static str {
            match self {
                Host::Wall => "wall",
                Host::Ceiling => "ceiling",
                Host::Roof => "roof",
            }
        }
    }

    fn thick(l: &Layer) -> f64 {
        if l.thickness.is_finite() && l.thickness > 0.0 {
            l.thickness
        } else {
            0.0
        }
    }

    /// Gesamtdicke (unsinnige Dicken zählen 0).
    pub fn total(layers: &[Layer]) -> f64 {
        layers.iter().map(thick).sum()
    }

    /// Lage je Schicht: Abstand der bezugsseitigen und der abgewandten Kante von der Bezugsseite.
    fn spans(layers: &[Layer], side: RenovationSide) -> Vec<(f64, f64)> {
        let n = layers.len();
        let mut out = vec![(0.0, 0.0); n];
        let mut d = 0.0;
        let order: Vec<usize> = if side == RenovationSide::Outside { (0..n).collect() } else { (0..n).rev().collect() };
        for i in order {
            out[i] = (d, d + thick(&layers[i]));
            d += thick(&layers[i]);
        }
        out
    }

    /// Automatische Zuordnung: eine alte Schicht bleibt, wenn der neue Aufbau eine Schicht gleichen Baustoffs mit
    /// gleicher Lage und Dicke (von der Bezugsseite her) hat; sonst Abbruch. Neue Schichten ohne Gegenstück sind neu.
    /// Manuelle Zuordnung (`old_ov`/`new_ov`, je Schicht; „auto“ = automatisch) geht vor.
    pub fn match_layers(old: &[Layer], new: &[Layer], side: RenovationSide, old_ov: &[LayerRenovation], new_ov: &[LayerRenovation]) -> Matched {
        let (so, sn) = (spans(old, side), spans(new, side));
        let mut nf = vec![Fate::New; new.len()];
        let mut of = Vec::with_capacity(old.len());
        let mut pair_of: Vec<Option<usize>> = Vec::with_capacity(old.len());
        for (i, l) in old.iter().enumerate() {
            let hit = (0..new.len()).find(|&j| nf[j] == Fate::New && new[j].component_id == l.component_id && (so[i].0 - sn[j].0).abs() < TOL && (so[i].1 - sn[j].1).abs() < TOL);
            pair_of.push(hit);
            of.push(match hit {
                Some(j) => {
                    nf[j] = Fate::Kept;
                    Fate::Kept
                }
                None => Fate::Demolish,
            });
        }
        for (i, f) in of.iter_mut().enumerate() {
            match old_ov.get(i) {
                Some(LayerRenovation::Existing) => *f = Fate::Kept,
                Some(LayerRenovation::Demolish) => {
                    // Das automatisch gepaarte Gegenstück ist dann neu (ausser es ist selbst manuell gesetzt).
                    if let Some(j) = pair_of[i].filter(|&j| matches!(new_ov.get(j), None | Some(LayerRenovation::Auto))) {
                        nf[j] = Fate::New;
                    }
                    *f = Fate::Demolish;
                }
                _ => {}
            }
        }
        for (j, f) in nf.iter_mut().enumerate() {
            match new_ov.get(j) {
                Some(LayerRenovation::Existing) => *f = Fate::Kept,
                Some(LayerRenovation::New) => {
                    if let Some(i) = pair_of.iter().position(|x| *x == Some(j)).filter(|&i| matches!(old_ov.get(i), None | Some(LayerRenovation::Auto))) {
                        of[i] = Fate::Demolish;
                    }
                    *f = Fate::New;
                }
                _ => {}
            }
        }
        Matched { old: of, new: nf }
    }

    /// Art eines Teilstücks des gezeigten Aufbaus.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub enum Kind {
        Kept,
        Demolish,
        New,
        /// Neue Schicht, wo eine abgebrochene lag (Umbauplan: rot, Abbruch als gestrichelte Kontur darüber).
        NewOverDemolish,
    }

    /// Eine Schicht des gezeigten Aufbaus mit Herkunft (Index im Bestands- bzw. Sanierungstyp).
    #[derive(Clone, Debug, PartialEq)]
    pub struct Piece {
        pub layer: Layer,
        pub kind: Kind,
        pub old: Option<usize>,
        pub new: Option<usize>,
    }

    /// Welchen Aufbau eine Darstellung zeigt.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Shown {
        /// Bestand samt Abbruch (Bestands-, Abbruchplan).
        Old,
        /// Bestand und Neu (Neubauplan, Endzustand).
        New,
        /// Beide überlagert (Umbauplan).
        Both,
        /// Nur was bleibt (eigener Filter ohne Abbruch und ohne Neu).
        Kept,
    }

    /// Schichten des gezeigten Aufbaus in Typ-Reihenfolge (aussen → innen).
    pub fn pieces(old: &[Layer], new: &[Layer], m: &Matched, side: RenovationSide, shown: Shown) -> Vec<Piece> {
        let of = |i: usize| m.old.get(i).copied().unwrap_or(Fate::Demolish);
        let nf = |j: usize| m.new.get(j).copied().unwrap_or(Fate::New);
        let kind = |f: Fate| match f {
            Fate::Kept => Kind::Kept,
            Fate::Demolish => Kind::Demolish,
            Fate::New => Kind::New,
        };
        match shown {
            Shown::Old => return old.iter().enumerate().map(|(i, l)| Piece { layer: l.clone(), kind: kind(of(i)), old: Some(i), new: None }).collect(),
            Shown::Kept => return old.iter().enumerate().filter(|(i, _)| of(*i) == Fate::Kept).map(|(i, l)| Piece { layer: l.clone(), kind: Kind::Kept, old: Some(i), new: None }).collect(),
            Shown::New => return new.iter().enumerate().map(|(j, l)| Piece { layer: l.clone(), kind: kind(nf(j)), old: None, new: Some(j) }).collect(),
            Shown::Both => {}
        }
        // Überlagert: Teilstücke zwischen allen Schichtgrenzen beider Aufbauten, von der Bezugsseite her.
        let (so, sn) = (spans(old, side), spans(new, side));
        let mut cuts: Vec<f64> = so.iter().chain(sn.iter()).flat_map(|s| [s.0, s.1]).collect();
        cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        cuts.dedup_by(|a, b| (*a - *b).abs() < TOL);
        let mut out: Vec<Piece> = Vec::new();
        for w in cuts.windows(2) {
            let (d0, d1) = (w[0], w[1]);
            if d1 - d0 < TOL {
                continue;
            }
            let mid = (d0 + d1) / 2.0;
            let oi = (0..old.len()).find(|&i| so[i].0 < mid && mid < so[i].1);
            let nj = (0..new.len()).find(|&j| sn[j].0 < mid && mid < sn[j].1);
            let (layer, k) = match (oi, nj) {
                (_, Some(j)) if nf(j) == Fate::Kept => (&new[j], Kind::Kept),
                (Some(i), Some(j)) => (&new[j], if of(i) == Fate::Demolish { Kind::NewOverDemolish } else { Kind::New }),
                (None, Some(j)) => (&new[j], Kind::New),
                (Some(i), None) => (&old[i], kind(of(i))),
                (None, None) => continue,
            };
            let mut layer = layer.clone();
            layer.thickness = d1 - d0;
            out.push(Piece { layer, kind: k, old: oi, new: nj });
        }
        if side != RenovationSide::Outside {
            out.reverse();
        }
        out
    }

    /// Hat das Projekt sanierte Wände, Decken oder Dächer?
    pub fn any(p: &Project) -> bool {
        let m = |r: &Option<Renovation>| r.as_ref().is_some_and(marked);
        p.walls.iter().any(|w| m(&w.renovation)) || p.ceilings.iter().flatten().any(|c| m(&c.renovation)) || p.roofs.iter().flatten().any(|r| m(&r.renovation))
    }

    /// Ist die Wand als saniert markiert?
    pub fn marked(r: &Renovation) -> bool {
        r.renovated == Some(true) || r.new_type_id.as_deref().is_some_and(|s| !s.trim().is_empty())
    }

    /// Ursprünglicher Typ und Achslage (auch einer schon umgestellten Ersatzwand).
    pub fn origin(w: &Wall) -> (String, Option<f64>, Option<WallReferenceLine>) {
        if let Some(o) = w.extra.0.get(ORIGIN) {
            let t = o.get("type").and_then(|x| x.as_str()).unwrap_or(&w.wall_type_id).to_string();
            let off = o.get("refOffset").and_then(|x| x.as_f64());
            let line = o.get("refLine").and_then(|x| serde_json::from_value(x.clone()).ok());
            return (t, off, line);
        }
        (w.wall_type_id.clone(), w.reference_offset, w.reference_line)
    }

    /// Typ-Paar einer sanierten Wand: Bestandstyp, Sanierungstyp, Bezugsseite, Zuordnung. `None` = nicht saniert, Typ
    /// fehlt, gleicher Typ oder ein Aufbau ohne Dicke.
    pub fn pair<'a>(p: &'a Project, w: &Wall) -> Option<(&'a WallType, &'a WallType, RenovationSide, Matched)> {
        let r = w.renovation.as_ref().filter(|r| marked(r))?;
        let (old_id, _, _) = origin(w);
        let old = p.wall_types.iter().find(|t| t.id == old_id)?;
        let target = r.new_type_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).or(old.renovation_target.as_deref())?;
        type_pair(p, old, target)
    }

    /// Typ-Paar Bestandstyp `old` → `target` mit Zuordnung (die manuelle gilt nur für den eingetragenen Sanierungstyp).
    pub fn type_pair<'a>(p: &'a Project, old: &'a WallType, target: &str) -> Option<(&'a WallType, &'a WallType, RenovationSide, Matched)> {
        type_pair_in(&p.wall_types, old, target)
    }

    /// Typ-Paar unter den Typen `types` (Wand-, Decken- oder Dachtypen), wie [`type_pair`].
    pub fn type_pair_in<'a, T: Layered>(types: &'a [T], old: &'a T, target: &str) -> Option<(&'a T, &'a T, RenovationSide, Matched)> {
        let new = types.iter().find(|t| t.type_id() == target)?;
        if new.type_id() == old.type_id() || total(old.type_layers()) <= TOL || total(new.type_layers()) <= TOL {
            return None;
        }
        let side = match old.side() {
            Some(RenovationSide::Outside) => RenovationSide::Outside,
            _ => RenovationSide::Inside,
        };
        let own = old.target() == Some(target);
        let (oo, no) = if own { (old.old_ov().unwrap_or_default(), old.new_ov().unwrap_or_default()) } else { (&[][..], &[][..]) };
        let m = match_layers(old.type_layers(), new.type_layers(), side, oo, no);
        Some((old, new, side, m))
    }

    /// Sanierungstyp eines Elements: Ausnahme `newTypeId`, sonst der eingetragene des Bestandstyps.
    fn target_of<'a, T: Layered>(r: &'a Renovation, old: &'a T) -> Option<&'a str> {
        r.new_type_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).or(old.target())
    }

    /// Ursprünglicher Deckentyp, Dicke und Höhenbindungen (auch einer schon umgestellten Ersatzdecke).
    pub fn ceiling_origin(c: &Ceiling) -> Ceiling {
        let mut c = c.clone();
        restore_ceiling(&mut c);
        c
    }

    /// Ersatzdecke auf ihren Ursprung zurückstellen (Marke [`ORIGIN`]).
    pub fn restore_ceiling(c: &mut Ceiling) {
        let Some(o) = c.extra.0.remove(ORIGIN) else { return };
        c.ceiling_type_id = o.get("type").and_then(|x| x.as_str()).map(String::from);
        c.thickness = o.get("thickness").and_then(|x| x.as_f64());
        c.top = o.get("top").and_then(|x| serde_json::from_value(x.clone()).ok());
        c.bottom = o.get("bottom").and_then(|x| serde_json::from_value(x.clone()).ok());
    }

    /// Ersatzdach auf seinen Ursprung zurückstellen (Marke [`ORIGIN`]).
    pub fn restore_roof(r: &mut Roof) {
        let Some(o) = r.extra.0.remove(ORIGIN) else { return };
        r.roof_type_id = o.get("type").and_then(|x| x.as_str()).map(String::from);
        r.base_elevation = o.get("base").and_then(|x| x.as_f64());
    }

    /// Ursprünglicher Dachtyp und Traufhöhe (auch eines schon umgestellten Ersatzdachs).
    pub fn roof_origin(r: &Roof) -> Roof {
        let mut r = r.clone();
        restore_roof(&mut r);
        r
    }

    /// Typ-Paar einer sanierten Decke (nur mit Deckentyp, wie [`pair`]).
    pub fn ceiling_pair<'a>(p: &'a Project, c: &Ceiling) -> Option<(&'a CeilingType, &'a CeilingType, RenovationSide, Matched)> {
        let r = c.renovation.as_ref().filter(|r| marked(r))?;
        let types = p.ceiling_types.as_deref()?;
        let id = if c.extra.0.contains_key(ORIGIN) { ceiling_origin(c).ceiling_type_id? } else { c.ceiling_type_id.clone()? };
        let old = types.iter().find(|t| t.id == id)?;
        type_pair_in(types, old, target_of(r, old)?)
    }

    /// Typ-Paar eines sanierten Dachs (nur mit Dachtyp).
    pub fn roof_pair<'a>(p: &'a Project, x: &Roof) -> Option<(&'a RoofType, &'a RoofType, RenovationSide, Matched)> {
        let r = x.renovation.as_ref().filter(|r| marked(r))?;
        let types = p.roof_types.as_deref()?;
        let id = if x.extra.0.contains_key(ORIGIN) { roof_origin(x).roof_type_id? } else { x.roof_type_id.clone()? };
        let old = types.iter().find(|t| t.id == id)?;
        type_pair_in(types, old, target_of(r, old)?)
    }

    /// Gezeigter Aufbau einer sanierten Wand im Filter.
    #[derive(Clone, Debug)]
    pub struct WallLook {
        pub shown: Shown,
        pub pieces: Vec<Piece>,
        /// Darstellung je Schicht (gleich lang wie `pieces`).
        pub treat: Vec<Treat>,
        /// Typ der Ersatzwand (`None` = der Bestandstyp bleibt); bei Decken und Dächern Träger von Id, Name und
        /// Schichten des Ersatz-Decken- bzw. -Dachtyps.
        pub new_type: Option<WallType>,
        /// Typ, den die Wand in der Darstellung trägt.
        pub type_id: String,
        /// Achsversatz der Ersatzwand (`Wall.referenceOffset`): die Bezugsseite bleibt stehen.
        pub ref_offset: f64,
        /// Decke: neue Oberkante (absolut), Dach: neue Traufhöhe; `None` = bleibt. Die Bezugsseite bleibt stehen, die
        /// andere Seite verschiebt sich um die Dickendifferenz.
        pub level: Option<f64>,
        /// Umbau-Farbe des Abbruchs, wenn der Filter ihn farbig zeigt (gestrichelte Kanten, Kontur im Umbauplan).
        pub demolish: Option<Style>,
        /// Hilfs-Bauteile der Schichten „Neu über Abbruch“ (Kopien des Baustoffs, in [`Resolved::project`] ergänzt).
        pub components: Vec<Component>,
    }

    impl WallLook {
        /// Schicht-Aktionen (Füllung ohne Muster) der farbigen Schichten über `lov` (Index = Schicht des Typs).
        pub fn layer_actions(&self, lov: &mut Vec<crate::plan::overrides::LayerActions>) {
            if lov.len() < self.pieces.len() {
                lov.resize(self.pieces.len(), Default::default());
            }
            for (i, t) in self.treat.iter().enumerate() {
                if let Treat::Style(st) = t {
                    lov[i].fill_color = Some(st.fill.clone());
                    lov[i].hatch = Some("none".into());
                }
            }
        }

        /// Darstellung der Schicht `li` des gezeigten Aufbaus (Schnitt).
        pub fn layer_style(&self, li: usize) -> Option<Style> {
            match self.treat.get(li)? {
                Treat::Style(st) => {
                    let mut st = st.clone();
                    // Neu über Abbruch: die Kontur der abgebrochenen Schicht gestrichelt.
                    if self.pieces[li].kind == Kind::NewOverDemolish && self.demolish.is_some() {
                        st.dashed = true;
                    }
                    Some(st)
                }
                _ => None,
            }
        }
    }

    fn reference(off: Option<f64>, line: Option<WallReferenceLine>) -> crate::joins::Reference {
        use crate::joins::Reference;
        match (off, line) {
            (Some(v), _) => Reference::Offset(v),
            (None, Some(WallReferenceLine::Left)) => Reference::Left,
            (None, Some(WallReferenceLine::Right)) => Reference::Right,
            _ => Reference::Center,
        }
    }

    /// Aufbau der Wand `w` im Filter `v` (`None` = nicht saniert).
    pub fn look(v: &View, p: &Project, w: &Wall) -> Option<WallLook> {
        let (old, new, side, m) = pair(p, w)?;
        let mut look = look_core(v, p, w.renovation.as_ref(), old, new, side, &m);
        let (_, off, line) = origin(w);
        let t_old = total(&old.layers);
        let t_eff: f64 = look.pieces.iter().map(|q| thick(&q.layer)).sum();
        let r_old = crate::joins::reference_offset(reference(off, line), t_old);
        let ref_offset = if side == RenovationSide::Outside { r_old - t_old / 2.0 + t_eff / 2.0 } else { r_old + t_old / 2.0 - t_eff / 2.0 };
        look.ref_offset = if ref_offset.is_finite() { ref_offset } else { 0.0 };
        Some(look)
    }

    /// Aufbau der Decke `c` im Filter `v` (`None` = nicht saniert). Bezugsseite innen = unten (die Rohdecke bleibt, die
    /// Oberkante verschiebt sich um die Dickendifferenz), aussen = oben (die Unterkante verschiebt sich).
    pub fn ceiling_look(v: &View, p: &Project, c: &Ceiling) -> Option<WallLook> {
        let (old, new, side, m) = ceiling_pair(p, c)?;
        let mut look = look_core(v, p, c.renovation.as_ref(), old, new, side, &m);
        if look.new_type.is_some() && side != RenovationSide::Outside {
            let (uk, ok) = p.ceiling_vertical_extent(&ceiling_origin(c));
            let t_eff: f64 = look.pieces.iter().map(|q| thick(&q.layer)).sum();
            look.level = Some(uk + t_eff).filter(|z| z.is_finite() && (z - ok).abs() > TOL);
        }
        Some(look)
    }

    /// Aufbau des Dachs `x` im Filter `v` (`None` = nicht saniert). Bezugsseite innen (Vorgabe): Tragwerk und
    /// Verkleidung bleiben, die Dachhaut hebt sich um die Dickendifferenz (senkrecht zur Fläche; lotrecht über die
    /// Hauptneigung umgerechnet, an der Traufhöhe angesetzt); aussen: die Dachhaut bleibt, die Unterseite verschiebt sich.
    pub fn roof_look(v: &View, p: &Project, x: &Roof) -> Option<WallLook> {
        let (old, new, side, m) = roof_pair(p, x)?;
        let mut look = look_core(v, p, x.renovation.as_ref(), old, new, side, &m);
        if look.new_type.is_some() && side != RenovationSide::Outside {
            let t_eff: f64 = look.pieces.iter().map(|q| thick(&q.layer)).sum();
            let pitch = if x.pitch_deg.is_finite() { x.pitch_deg.clamp(0.0, 85.0) } else { 0.0 };
            let cos = crate::jsnum::cos(pitch.to_radians());
            let base = p.roof_base_elevation(&roof_origin(x));
            let z = base + (t_eff - total(&old.layers)) / cos;
            look.level = Some(z).filter(|z| z.is_finite() && (z - base).abs() > TOL);
        }
        Some(look)
    }

    /// Gezeigter Aufbau eines Typ-Paars im Filter (ohne Lage): Teilstücke, Darstellung je Schicht, Ersatztyp.
    fn look_core<T: Layered>(v: &View, p: &Project, ren: Option<&Renovation>, old: &T, new: &T, side: RenovationSide, m: &Matched) -> WallLook {
        let phase = ren.and_then(|r| r.phase.clone());
        let virt = |status| Renovation { status, phase: phase.clone(), ..Default::default() };
        let td = v.treat(Some(&virt(RenovationStatus::Demolish)));
        let tn = v.treat(Some(&virt(RenovationStatus::New)));
        let tk = v.treat(ren);
        let shown = match (td != Treat::Hide, tn != Treat::Hide) {
            (true, false) => Shown::Old,
            (false, true) => Shown::New,
            (true, true) => Shown::Both,
            (false, false) => Shown::Kept,
        };
        let mut pieces = pieces(old.type_layers(), new.type_layers(), m, side, shown);
        // Überlagert: neue Schichten über abgebrochenen bekommen ein eigenes (gleich aussehendes) Bauteil, damit
        // Schnitt und 3D sie nicht mit der übrigen neuen Schicht gleichen Baustoffs zusammenfassen — sonst fehlte dort die
        // Kontur der abgebrochenen Schicht.
        let mut components: Vec<Component> = Vec::new();
        for q in pieces.iter_mut().filter(|q| q.kind == Kind::NewOverDemolish) {
            let id = format!("{}~abbruch{}", q.layer.component_id, q.old.unwrap_or(0));
            if !components.iter().any(|c| c.id == id) {
                components.push(Component { id: id.clone(), ..p.component_or_fallback(&q.layer.component_id).clone() });
            }
            q.layer.component_id = id;
        }
        let treat = pieces
            .iter()
            .map(|q| match q.kind {
                Kind::Kept => tk.clone(),
                Kind::Demolish => td.clone(),
                Kind::New | Kind::NewOverDemolish => tn.clone(),
            })
            .collect();
        let new_type = (shown != Shown::Old).then(|| {
            let tag = match shown {
                Shown::New => "neu",
                Shown::Both => "umbau",
                _ => "bleibt",
            };
            let name = if shown == Shown::New { new.type_name().to_string() } else { format!("{} → {}", old.type_name(), new.type_name()) };
            WallType { id: format!("{}~{}~{}", old.type_id(), new.type_id(), tag), name, layers: pieces.iter().map(|q| q.layer.clone()).collect(), ..Default::default() }
        });
        let type_id = new_type.as_ref().map_or_else(|| old.type_id().to_string(), |t| t.id.clone());
        let demolish = match td {
            Treat::Style(s) => Some(s),
            _ => None,
        };
        WallLook { shown, pieces, treat, new_type, type_id, ref_offset: 0.0, level: None, demolish, components }
    }

    /// Grundriss: Kanten der Wand (Umriss, Fugen, Stirnseiten) in `prims[from..]` je Schicht stricheln — Kanten einer
    /// Abbruch-Schicht gestrichelt, im Umbauplan die Grenzen abgebrochener Schichten innerhalb einer neuen Schicht als
    /// gestrichelte Kontur in der Abbruch-Farbe. Nur gerade Wände (Frame `start`→`end`, Achsversatz `ref_off`).
    pub fn dash_edges(look: &WallLook, prims: &mut Vec<Primitive>, from: usize, wall_id: &str, start: Vec2, end: Vec2, ref_off: f64) {
        let Some(dem) = &look.demolish else { return };
        let (dx, dy) = (end.x - start.x, end.y - start.y);
        let len = (dx * dx + dy * dy).sqrt();
        if !(len > 1e-9) || from >= prims.len() {
            return;
        }
        let m = (-dy / len, dx / len);
        let n_of = |q: Vec2| (q.x - start.x) * m.0 + (q.y - start.y) * m.1;
        let t: f64 = look.pieces.iter().map(|q| thick(&q.layer)).sum();
        let mut bounds = vec![ref_off - t / 2.0];
        for q in &look.pieces {
            bounds.push(bounds[bounds.len() - 1] + thick(&q.layer));
        }
        let eps = 1e-6;
        let piece_at = |n: f64| (0..look.pieces.len()).find(|&k| bounds[k] < n && n < bounds[k + 1]);
        let dem_like = |k: Option<usize>| k.is_none_or(|k| look.pieces[k].kind == Kind::Demolish);
        let contour = Style { fill: dem.fill.clone(), line: Some(dem.line.clone().unwrap_or_else(|| dem.fill.clone())), dashed: true, ghost: false };
        // Stil eines Teilstücks (a, b) einer Kante; `None` = unverändert.
        let style_of = |na: f64, nb: f64| -> Option<&Style> {
            if (na - nb).abs() < eps {
                return match bounds.iter().position(|b| (b - na).abs() < eps) {
                    Some(bi) => {
                        let below = bi.checked_sub(1);
                        let above = (bi < look.pieces.len()).then_some(bi);
                        if dem_like(below) && dem_like(above) && (below.is_some() || above.is_some()) {
                            Some(dem)
                        } else {
                            match (below.map(|k| &look.pieces[k]), above.map(|k| &look.pieces[k])) {
                                (Some(a), Some(b)) if a.new.is_some() && a.new == b.new && a.old != b.old && (a.kind == Kind::NewOverDemolish || b.kind == Kind::NewOverDemolish) => Some(&contour),
                                _ => None,
                            }
                        }
                    }
                    None => piece_at(na).filter(|&k| look.pieces[k].kind == Kind::Demolish).map(|_| dem),
                };
            }
            piece_at((na + nb) / 2.0).filter(|&k| look.pieces[k].kind == Kind::Demolish).map(|_| dem)
        };
        // Kante in Teilstücke an den Schichtgrenzen zerlegen.
        let split = |a: Vec2, b: Vec2| -> Vec<(Vec2, Vec2, Option<Style>)> {
            let (na, nb) = (n_of(a), n_of(b));
            let mut ts: Vec<f64> = vec![0.0, 1.0];
            if (na - nb).abs() > eps {
                for &bn in &bounds {
                    let s = (bn - na) / (nb - na);
                    if s > 1e-9 && s < 1.0 - 1e-9 {
                        ts.push(s);
                    }
                }
            }
            ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
            let at = |s: f64| Vec2 { x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s };
            ts.windows(2).map(|w| (at(w[0]), at(w[1]), style_of(na + (nb - na) * w[0], na + (nb - na) * w[1]).cloned())).collect()
        };
        let dash = || Some(Some(DEMOLISH_DASH.to_vec()));
        let mut extra = Vec::new();
        for q in prims[from..].iter_mut() {
            match q {
                Primitive::Line { a, b, cls, opening_id: None, .. } if matches!(&**cls, "wall-outline" | "layer-joint" | "layer-joint-l") => {
                    let parts = split(*a, *b);
                    if parts.iter().all(|x| x.2.is_none()) {
                        continue;
                    }
                    let template = q.clone();
                    for (k, (pa, pb, st)) in parts.into_iter().enumerate() {
                        let mut l = template.clone();
                        if let Primitive::Line { a, b, dash: d, color, zigzag, motif, .. } = &mut l {
                            *a = pa;
                            *b = pb;
                            if let Some(st) = st {
                                *d = dash();
                                *zigzag = None;
                                *motif = None;
                                if let Some(c) = &st.line {
                                    *color = Some(c.clone().into());
                                }
                            }
                        }
                        // Das erste Stück ersetzt die Kante an ihrem Platz (Bereiche dahinter bleiben gültig).
                        if k == 0 {
                            *q = l;
                        } else {
                            extra.push(l);
                        }
                    }
                }
                Primitive::Polygon { pts, stroke, stroke_width_mm, wall_id: Some(wid), opening_id: None, no_stroke_edges, greyed, .. } if wid == wall_id && stroke.trim() != "none" && !stroke.is_empty() && *stroke_width_mm > 0.0 && pts.len() >= 2 => {
                    let skip: HashSet<usize> = no_stroke_edges.iter().flatten().filter(|x| x.is_finite() && **x >= 0.0).map(|x| *x as usize).collect();
                    let n = pts.len();
                    let mut lines = Vec::new();
                    let mut any = false;
                    for i in (0..n).filter(|i| !skip.contains(i)) {
                        for (pa, pb, st) in split(pts[i], pts[(i + 1) % n]) {
                            any |= st.is_some();
                            let color = st.as_ref().and_then(|s| s.line.clone()).unwrap_or_else(|| stroke.clone());
                            lines.push(Primitive::Line { a: pa, b: pb, cls: "wall-outline".into(), weight_mm: *stroke_width_mm, dash: if st.is_some() { dash() } else { None }, zigzag: None, motif: None, color: Some(color.into()), drawing_id: None, opening_id: None, stair_id: None, greyed: *greyed, opacity: None });
                        }
                    }
                    if any {
                        *stroke = "none".into();
                        extra.extend(lines);
                    }
                }
                _ => {}
            }
        }
        prims.extend(extra);
    }

    /// [274] IFC: Status je Schicht eines sanierten Bauteils (Wand, Decke, Dach; `id`), unabhängig vom Umbaufilter —
    /// Bestandstyp und Sanierungstyp je als Liste „Baustoff Dicke cm: EXISTING|DEMOLISH|NEW“ (Schichten aussen/oben →
    /// innen/unten). IFC kennt den Status nur je Bauteil (`Pset_*Common.Status`, PEnum_ElementStatus) und keinen je
    /// Materialschicht; die Liste steht darum in `Dossier_Umbau` (`SchichtenBestand`, `SchichtenSanierung`). `None` ohne Sanierung.
    pub fn ifc_layer_status(p: &Project, id: &str) -> Option<(String, String)> {
        fn text(p: &Project, layers: &[Layer], fates: &[Fate]) -> String {
            let word = |f: Fate| match f {
                Fate::Kept => "EXISTING",
                Fate::Demolish => "DEMOLISH",
                Fate::New => "NEW",
            };
            layers.iter().zip(fates).map(|(l, f)| format!("{} {:.1} cm: {}", p.component_or_fallback(&l.component_id).name, thick(l) * 100.0, word(*f))).collect::<Vec<_>>().join("; ")
        }
        fn of<T: Layered>(p: &Project, x: Option<(&T, &T, RenovationSide, Matched)>) -> Option<(String, String)> {
            let (old, new, _, m) = x?;
            Some((text(p, old.type_layers(), &m.old), text(p, new.type_layers(), &m.new)))
        }
        if let Some(w) = p.walls.iter().find(|w| w.id == id) {
            return of(p, pair(p, w));
        }
        if let Some(c) = p.ceilings.iter().flatten().find(|c| c.id == id) {
            return of(p, ceiling_pair(p, c));
        }
        let r = p.roofs.iter().flatten().find(|r| r.id == id)?;
        of(p, roof_pair(p, r))
    }

    /// Bestandstyp, Markierung „saniert“ und gezeigter Sanierungstyp je Element einer Bauteilart (Zähler der Abfragen).
    fn members(p: &Project, host: Host) -> Vec<(Option<String>, bool, Option<String>)> {
        let m = |r: &Option<Renovation>| r.as_ref().is_some_and(marked);
        match host {
            Host::Wall => p.walls.iter().map(|w| (Some(origin(w).0), m(&w.renovation), pair(p, w).map(|x| x.1.id.clone()))).collect(),
            Host::Ceiling => p.ceilings.iter().flatten().map(|c| (ceiling_origin(c).ceiling_type_id, m(&c.renovation), ceiling_pair(p, c).map(|x| x.1.id.clone()))).collect(),
            Host::Roof => p.roofs.iter().flatten().map(|r| (roof_origin(r).roof_type_id, m(&r.renovation), roof_pair(p, r).map(|x| x.1.id.clone()))).collect(),
        }
    }

    /// Abfrage `renovationPair` (Typ-Paar-Editor, Vorschau): Schichten alt/neu mit Zuordnung und Ergebnis-Streifen
    /// (Umbauplan). `text` = `{"type": Bestandstyp-Id, "target": Sanierungstyp-Id (fehlt = eingetragener), "kind": "wall" |
    /// "ceiling" | "roof" (fehlt = Wand)}`; `null` ohne Paar. `elements`/`renovated`: Elemente des Bestandstyps bzw. mit
    /// diesem Sanierungstyp saniert.
    pub fn pair_json(p: &Project, text: &str) -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let host = Host::parse(v.get("kind").and_then(|x| x.as_str()).unwrap_or(""));
        match host {
            Host::Wall => pair_json_in(p, &p.wall_types, host, &v),
            Host::Ceiling => pair_json_in(p, p.ceiling_types.as_deref().unwrap_or(&[]), host, &v),
            Host::Roof => pair_json_in(p, p.roof_types.as_deref().unwrap_or(&[]), host, &v),
        }
    }

    fn pair_json_in<T: Layered>(p: &Project, types: &[T], host: Host, v: &serde_json::Value) -> serde_json::Value {
        let Some(old) = v.get("type").and_then(|x| x.as_str()).and_then(|id| types.iter().find(|t| t.type_id() == id)) else { return serde_json::Value::Null };
        let target = v.get("target").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).or(old.target());
        let Some((old, new, side, m)) = target.and_then(|t| type_pair_in(types, old, t)) else { return serde_json::Value::Null };
        let layer = |l: &Layer, f: Fate| {
            let c = p.component_or_fallback(&l.component_id);
            serde_json::json!({"componentId": l.component_id, "name": c.name, "color": c.color, "thickness": thick(l), "fate": f})
        };
        let fill = |k: Kind| match k {
            Kind::Kept => style(p, RenovationStatus::Existing).fill,
            Kind::Demolish => style(p, RenovationStatus::Demolish).fill,
            _ => style(p, RenovationStatus::New).fill,
        };
        let strip = |shown: Shown| -> Vec<serde_json::Value> { pieces(old.type_layers(), new.type_layers(), &m, side, shown).iter().map(|q| serde_json::json!({"thickness": thick(&q.layer), "kind": q.kind, "fill": fill(q.kind)})).collect() };
        let list = members(p, host);
        let of_type = |x: &(Option<String>, bool, Option<String>)| x.0.as_deref() == Some(old.type_id());
        let elements = list.iter().filter(|x| of_type(x)).count();
        let renovated = list.iter().filter(|x| of_type(x) && x.2.as_deref() == Some(new.type_id())).count();
        serde_json::json!({
            "kind": host.key(), "type": old.type_id(), "target": new.type_id(), "side": if side == RenovationSide::Outside { "outside" } else { "inside" },
            "old": old.type_layers().iter().zip(&m.old).map(|(l, f)| layer(l, *f)).collect::<Vec<_>>(),
            "new": new.type_layers().iter().zip(&m.new).map(|(l, f)| layer(l, *f)).collect::<Vec<_>>(),
            "oldStrip": strip(Shown::Old), "newStrip": strip(Shown::New), "result": strip(Shown::Both),
            "elements": elements, "renovated": renovated,
        })
    }

    /// Abfrage `renovationPairs` (Umbau-Panel): je Bestandstyp mit Sanierungstyp (Wände, Decken, Dächer) das Ziel und die
    /// Anzahl Elemente bzw. sanierter Elemente; dazu die Zahl aller sanierten Bauteile.
    pub fn pairs_json(p: &Project) -> serde_json::Value {
        fn of<T: Layered>(p: &Project, types: &[T], host: Host, out: &mut Vec<serde_json::Value>) -> usize {
            let list = members(p, host);
            for t in types {
                let Some(target) = t.target().filter(|s| !s.is_empty()) else { continue };
                let new = types.iter().find(|x| x.type_id() == target);
                let elements = list.iter().filter(|x| x.0.as_deref() == Some(t.type_id())).count();
                let renovated = list.iter().filter(|x| x.0.as_deref() == Some(t.type_id()) && x.1).count();
                out.push(serde_json::json!({"kind": host.key(), "type": t.type_id(), "name": t.type_name(), "target": target, "targetName": new.map(|n| n.type_name()), "elements": elements, "renovated": renovated}));
            }
            list.iter().filter(|x| x.2.is_some()).count()
        }
        let mut pairs = Vec::new();
        let total = of(p, &p.wall_types, Host::Wall, &mut pairs) + of(p, p.ceiling_types.as_deref().unwrap_or(&[]), Host::Ceiling, &mut pairs) + of(p, p.roof_types.as_deref().unwrap_or(&[]), Host::Roof, &mut pairs);
        serde_json::json!({"pairs": pairs, "renovated": total})
    }
}

pub use build_up::WallLook;

#[cfg(test)]
#[path = "renovation_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "renovation_tests2.rs"]
mod tests2;

#[cfg(test)]
#[path = "renovation_layers_tests.rs"]
mod layers_tests;

#[cfg(test)]
#[path = "renovation_style_tests.rs"]
mod style_tests;
