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

/// Umbau-Farbe eines Status, aufgelöst (Projekt-Vorgabe über der SIA-Vorgabe).
#[derive(Clone, Debug, PartialEq)]
pub struct Style {
    /// Füllung der Schnittflächen (ohne Muster).
    pub fill: String,
    /// Linienfarbe (`None` = Linien wie ohne Filter).
    pub line: Option<String>,
    /// Linien gestrichelt ([`DEMOLISH_DASH`]).
    pub dashed: bool,
}

/// SIA-400-Vorgabe: Bestand grau, Abbruch gelb und gestrichelt, Neu rot.
pub fn default_style(s: RenovationStatus) -> Style {
    match s {
        RenovationStatus::Demolish => Style { fill: "#ffd800".into(), line: None, dashed: true },
        RenovationStatus::New => Style { fill: "#e3001b".into(), line: Some("#c00016".into()), dashed: false },
        _ => Style { fill: "#a6a6a6".into(), line: None, dashed: false },
    }
}

/// Umbau-Farbe eines Status im Projekt.
pub fn style(p: &Project, s: RenovationStatus) -> Style {
    let mut st = default_style(s);
    let own = p.renovation.as_ref().and_then(|r| r.styles.as_ref()).and_then(|x| match s {
        RenovationStatus::Demolish => x.demolish.as_ref(),
        RenovationStatus::New => x.new.as_ref(),
        _ => x.existing.as_ref(),
    });
    if let Some(o) = own {
        if let Some(f) = o.fill.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
            st.fill = f.to_string();
        }
        if let Some(l) = o.line.as_deref().map(str::trim) {
            st.line = (!l.is_empty()).then(|| l.to_string());
        }
        if let Some(d) = o.dashed {
            st.dashed = d;
        }
    }
    st
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
    phases: HashMap<String, usize>,
    styles: [Style; 3],
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
        Some(View { filter, options, upto, phases, styles })
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

    /// Darstellung eines Zustands im Filter.
    pub fn treat_state(&self, s: Option<RenovationStatus>) -> Treat {
        let Some(s) = s else { return Treat::Hide };
        let Some(filter) = &self.filter else { return Treat::Show };
        let (show, k) = match s {
            RenovationStatus::Demolish => (filter.demolish, 1),
            RenovationStatus::New => (filter.new, 2),
            _ => (filter.existing, 0),
        };
        match show {
            RenovationShow::Hide => Treat::Hide,
            RenovationShow::Override => Treat::Style(self.styles[k].clone()),
            _ => Treat::Show,
        }
    }

    /// Darstellung eines Elements mit diesen Umbau-Angaben.
    pub fn treat(&self, r: Option<&Renovation>) -> Treat {
        self.treat_state(self.state(r))
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
        if self.filter.is_none() {
            return out;
        }
        let mut put = |id: &str, t: Treat, out: &mut Resolved| match t {
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
            put(&w.id, self.treat_state(s), &mut out);
        }
        for o in p.openings.iter().flatten() {
            let host = wall_state.get(o.host_wall_id.as_str()).copied().flatten();
            if out.hidden.contains(&o.host_wall_id) {
                out.hidden.insert(o.id.clone());
                continue;
            }
            let s = self.state(opening_renovation(p, o));
            put(&o.id, self.treat_state(s), &mut out);
            // Ersatzstück nur, wenn die Öffnung einen anderen Zustand hat als ihre (Bestands-)Wand.
            if o.renovation.is_none() || host != Some(RenovationStatus::Existing) {
                continue;
            }
            let virt = match s {
                Some(RenovationStatus::New) => RenovationStatus::Demolish,
                Some(RenovationStatus::Demolish) => RenovationStatus::New,
                _ => continue,
            };
            if let Treat::Style(st) = self.treat_state(Some(virt)) {
                out.patches.push(Patch { opening_id: o.id.clone(), wall_id: o.host_wall_id.clone(), status: virt, style: st, closed: out.hidden.contains(&o.id) });
            }
        }
        for x in p.ceilings.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), &mut out);
        }
        for x in p.roofs.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), &mut out);
        }
        for x in p.stairs.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), &mut out);
        }
        for x in p.columns.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), &mut out);
        }
        for x in p.extruded_solids.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), &mut out);
        }
        // Räume: nur sichtbar oder nicht (ein Raum ist kein Bauteil, er bekommt keine Umbau-Farbe).
        for x in p.rooms.iter().flatten() {
            if !self.visible(x.renovation.as_ref()) {
                out.hidden.insert(x.id.clone());
            }
        }
        out
    }

    /// Füll- und Linienfarben der Status, die der Filter farbig zeigt (bleiben in Schwarz-Weiss erhalten).
    pub fn colors(&self) -> Vec<String> {
        let mut out = Vec::new();
        let Some(f) = &self.filter else { return out };
        for (show, st) in [(f.existing, &self.styles[0]), (f.demolish, &self.styles[1]), (f.new, &self.styles[2])] {
            if show == RenovationShow::Override {
                out.push(st.fill.clone());
                out.extend(st.line.clone());
            }
        }
        out
    }

    /// Schlüssel für Caches (Filter samt Darstellungen, Etappe, Farben).
    pub fn key(&self) -> String {
        let opts = self.options.as_ref().map_or(String::new(), |c| c.key());
        match &self.filter {
            Some(f) => format!("{}:{:?}{:?}{:?}:{:?}:{:?}|{opts}", f.id, f.existing, f.demolish, f.new, self.upto, self.styles),
            None => format!("-|{opts}"),
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
    /// [274] Ansichtsflächen sanierter Wände (Ansicht, Axo, 3D): Farbe der äussersten Schicht.
    pub faces: HashMap<String, Style>,
    /// [274] Eine schon umgestellte Ersatzwand muss auf den Bestand zurück ([`Self::swap_build_ups`]).
    pub restore: bool,
}

impl Resolved {
    pub fn is_empty(&self) -> bool {
        self.hidden.is_empty() && self.styled.is_empty() && self.patches.is_empty() && self.walls.is_empty()
    }

    /// Umbau-Farbe einer Ansichtsfläche (Element-Farbe, sonst die der äussersten Schicht einer sanierten Wand).
    pub fn surface(&self, id: &str) -> Option<&Style> {
        self.styled.get(id).or_else(|| self.faces.get(id))
    }

    /// Ersetzt der Filter Aufbauten (Wände mit anderem gezeigtem Aufbau)?
    pub fn swaps(&self) -> bool {
        self.restore || self.walls.values().any(|l| l.new_type.is_some())
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
        for c in self.walls.values().flat_map(|l| l.components.iter()) {
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
    // [272] 2D-Zeichnungen anderer Varianten.
    q.drawings2d.retain(|x| !hidden.contains(&x.id));
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
        Primitive::Line { color, dash: d, .. } => {
            if let Some(l) = &st.line {
                *color = Some(l.clone().into());
            }
            if st.dashed {
                *d = dash();
            }
        }
        Primitive::Arc { color, dash: d, .. } => {
            if let Some(l) = &st.line {
                *color = Some(l.clone().into());
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

/// Umbau-Farben auf `prims[from..]`: jedes Primitiv nach seinem Element ([`prim_element`]), sonst nach `owner`
/// (z. B. die Wand, deren Umrisslinien keine Id tragen). Umrisslinien gestrichelter Flächen kommen dahinter.
pub fn restyle_range(r: &Resolved, prims: &mut Vec<Primitive>, from: usize, owner: Option<&str>) {
    if r.styled.is_empty() || from >= prims.len() {
        return;
    }
    let mut extra = Vec::new();
    for q in prims[from..].iter_mut() {
        let id = prim_element(q).or(owner);
        if let Some(st) = id.and_then(|id| r.styled.get(id)) {
            // Symbole und Ansichten (Fenster, Türflügel, Treppenstufen, Decken- und Dachkanten): nur Linien.
            let f = cut_fill(q);
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

/// Grundriss: Fläche eines Ersatzstücks (Wandband zwischen den Leibungen der Öffnung), `None` bei Bogenwänden
/// oder ohne gültige Lage.
pub fn patch_ring(p: &Project, w: &Wall, o: &Opening) -> Option<Vec<Vec2>> {
    if crate::wall_arc::WallArc::of_wall(w).is_some() {
        return None;
    }
    let total = p.wall_thickness(w, 0.2);
    let ref_off = crate::joins::reference_offset(crate::model3d::wall_reference(w), total);
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
        restyle(&mut q, &Style { fill: st.fill.clone(), line: None, dashed: true }, &mut extra);
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
    None
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

    /// Hat das Projekt sanierte Wände?
    pub fn any(p: &Project) -> bool {
        p.walls.iter().any(|w| w.renovation.as_ref().is_some_and(marked))
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
        let new = p.wall_types.iter().find(|t| t.id == target)?;
        if new.id == old.id || total(&old.layers) <= TOL || total(&new.layers) <= TOL {
            return None;
        }
        let side = match old.renovation_side {
            Some(RenovationSide::Outside) => RenovationSide::Outside,
            _ => RenovationSide::Inside,
        };
        let own = old.renovation_target.as_deref() == Some(target);
        let (oo, no) = if own { (old.renovation_old.clone().unwrap_or_default(), old.renovation_new.clone().unwrap_or_default()) } else { (Vec::new(), Vec::new()) };
        let m = match_layers(&old.layers, &new.layers, side, &oo, &no);
        Some((old, new, side, m))
    }

    /// Gezeigter Aufbau einer sanierten Wand im Filter.
    #[derive(Clone, Debug)]
    pub struct WallLook {
        pub shown: Shown,
        pub pieces: Vec<Piece>,
        /// Darstellung je Schicht (gleich lang wie `pieces`).
        pub treat: Vec<Treat>,
        /// Wandtyp der Ersatzwand (`None` = der Bestandstyp bleibt).
        pub new_type: Option<WallType>,
        /// Typ, den die Wand in der Darstellung trägt.
        pub type_id: String,
        /// Achsversatz der Ersatzwand (`Wall.referenceOffset`): die Bezugsseite bleibt stehen.
        pub ref_offset: f64,
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
        let phase = w.renovation.as_ref().and_then(|r| r.phase.clone());
        let virt = |status| Renovation { status, phase: phase.clone(), ..Default::default() };
        let td = v.treat_state(v.state(Some(&virt(RenovationStatus::Demolish))));
        let tn = v.treat_state(v.state(Some(&virt(RenovationStatus::New))));
        let tk = v.treat(w.renovation.as_ref());
        let shown = match (td != Treat::Hide, tn != Treat::Hide) {
            (true, false) => Shown::Old,
            (false, true) => Shown::New,
            (true, true) => Shown::Both,
            (false, false) => Shown::Kept,
        };
        let mut pieces = pieces(&old.layers, &new.layers, &m, side, shown);
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
        let (_, off, line) = origin(w);
        let t_old = total(&old.layers);
        let t_eff: f64 = pieces.iter().map(|q| thick(&q.layer)).sum();
        let r_old = crate::joins::reference_offset(reference(off, line), t_old);
        let ref_offset = if side == RenovationSide::Outside { r_old - t_old / 2.0 + t_eff / 2.0 } else { r_old + t_old / 2.0 - t_eff / 2.0 };
        let new_type = (shown != Shown::Old).then(|| {
            let tag = match shown {
                Shown::New => "neu",
                Shown::Both => "umbau",
                _ => "bleibt",
            };
            let name = if shown == Shown::New { new.name.clone() } else { format!("{} → {}", old.name, new.name) };
            WallType { id: format!("{}~{}~{}", old.id, new.id, tag), name, layers: pieces.iter().map(|q| q.layer.clone()).collect(), ..Default::default() }
        });
        let type_id = new_type.as_ref().map_or_else(|| old.id.clone(), |t| t.id.clone());
        let demolish = match td {
            Treat::Style(s) => Some(s),
            _ => None,
        };
        Some(WallLook { shown, pieces, treat, new_type, type_id, ref_offset: if ref_offset.is_finite() { ref_offset } else { 0.0 }, demolish, components })
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
        let contour = Style { fill: dem.fill.clone(), line: Some(dem.line.clone().unwrap_or_else(|| dem.fill.clone())), dashed: true };
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

    /// Abfrage `renovationPair` (Typ-Paar-Editor, Vorschau): Schichten alt/neu mit Zuordnung und Ergebnis-Streifen
    /// (Umbauplan). `text` = `{"type": Bestandstyp-Id, "target": Sanierungstyp-Id (fehlt = eingetragener)}`; `null` ohne Paar.
    pub fn pair_json(p: &Project, text: &str) -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let Some(old) = v.get("type").and_then(|x| x.as_str()).and_then(|id| p.wall_types.iter().find(|t| t.id == id)) else { return serde_json::Value::Null };
        let target = v.get("target").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).or(old.renovation_target.as_deref());
        let Some((old, new, side, m)) = target.and_then(|t| type_pair(p, old, t)) else { return serde_json::Value::Null };
        let layer = |l: &Layer, f: Fate| {
            let c = p.component_or_fallback(&l.component_id);
            serde_json::json!({"componentId": l.component_id, "name": c.name, "color": c.color, "thickness": thick(l), "fate": f})
        };
        let fill = |k: Kind| match k {
            Kind::Kept => style(p, RenovationStatus::Existing).fill,
            Kind::Demolish => style(p, RenovationStatus::Demolish).fill,
            _ => style(p, RenovationStatus::New).fill,
        };
        let strip = |shown: Shown| -> Vec<serde_json::Value> { pieces(&old.layers, &new.layers, &m, side, shown).iter().map(|q| serde_json::json!({"thickness": thick(&q.layer), "kind": q.kind, "fill": fill(q.kind)})).collect() };
        let walls = p.walls.iter().filter(|w| origin(w).0 == old.id).count();
        let renovated = p.walls.iter().filter(|w| origin(w).0 == old.id && pair(p, w).is_some_and(|x| x.1.id == new.id)).count();
        serde_json::json!({
            "type": old.id, "target": new.id, "side": if side == RenovationSide::Outside { "outside" } else { "inside" },
            "old": old.layers.iter().zip(&m.old).map(|(l, f)| layer(l, *f)).collect::<Vec<_>>(),
            "new": new.layers.iter().zip(&m.new).map(|(l, f)| layer(l, *f)).collect::<Vec<_>>(),
            "oldStrip": strip(Shown::Old), "newStrip": strip(Shown::New), "result": strip(Shown::Both),
            "walls": walls, "renovated": renovated,
        })
    }

    /// Abfrage `renovationPairs` (Umbau-Panel): je Bestandstyp mit Sanierungstyp das Ziel und die Anzahl Wände bzw.
    /// sanierter Wände; dazu die Zahl aller sanierten Wände.
    pub fn pairs_json(p: &Project) -> serde_json::Value {
        let pairs: Vec<serde_json::Value> = p
            .wall_types
            .iter()
            .filter_map(|t| {
                let target = t.renovation_target.as_deref().filter(|s| !s.is_empty())?;
                let new = p.wall_types.iter().find(|x| x.id == target);
                let walls = p.walls.iter().filter(|w| origin(w).0 == t.id).count();
                let renovated = p.walls.iter().filter(|w| origin(w).0 == t.id && w.renovation.as_ref().is_some_and(marked)).count();
                Some(serde_json::json!({"type": t.id, "name": t.name, "target": target, "targetName": new.map(|n| n.name.clone()), "walls": walls, "renovated": renovated}))
            })
            .collect();
        let total = p.walls.iter().filter(|w| pair(p, w).is_some()).count();
        serde_json::json!({"pairs": pairs, "renovated": total})
    }
}

pub use build_up::WallLook;

#[cfg(test)]
#[path = "renovation_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "renovation_layers_tests.rs"]
mod layers_tests;
