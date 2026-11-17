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

/// SIA-400-Vorgabe: Bestand grau, Abbruch gelb und gestrichelt, Neu rot.
pub fn default_style(s: RenovationStatus) -> Style {
    match s {
        RenovationStatus::Demolish => Style { fill: "#ffd800".into(), line: None, dashed: true, ghost: false },
        RenovationStatus::New => Style { fill: "#e3001b".into(), line: Some("#c00016".into()), dashed: false, ghost: false },
        _ => Style { fill: "#a6a6a6".into(), line: None, dashed: false, ghost: false },
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
    /// [272] Bearbeitungsvariante der Bildschirm-Darstellung (Stift; [`View::editing`]), `None` = keine.
    pub edit: Option<crate::design_options::Edit>,
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
        Some(View { filter, options, upto, phases, styles, edit: None })
    }

    /// [272] Mit Bearbeitungsvariante (Stift, nur Bildschirm-Anfragen `designOptionEdit`): die Variante ist sichtbar (geht
    /// der Kombination vor — Stift impliziert Auge), mit `grey` bekommt alles ausserhalb [`ghost_style`]. Gibt es
    /// sonst keine `View` (kein Filter, keine Elemente in Varianten), entsteht eine. `edit = None` ⇒ `v` unverändert.
    pub fn editing(v: Option<View>, p: &Project, edit: Option<crate::design_options::Edit>) -> Option<View> {
        let Some(e) = edit else { return v };
        let mut v = v.unwrap_or_else(|| {
            let styles = [style(p, RenovationStatus::Existing), style(p, RenovationStatus::Demolish), style(p, RenovationStatus::New)];
            View { filter: None, options: None, upto: None, phases: HashMap::new(), styles, edit: None }
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
        if self.filter.is_some() {
            self.resolve_filter(p, &mut out);
        }
        // [272] Grau ausserhalb der Bearbeitungsvariante: geht der Umbau-Farbe vor; Ausgeblendetes bleibt weg.
        if let Some(e) = self.edit.as_ref().filter(|e| e.grey) {
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
            put(&w.id, self.treat_state(s), out);
        }
        for o in p.openings.iter().flatten() {
            let host = wall_state.get(o.host_wall_id.as_str()).copied().flatten();
            if out.hidden.contains(&o.host_wall_id) {
                out.hidden.insert(o.id.clone());
                continue;
            }
            let s = self.state(opening_renovation(p, o));
            put(&o.id, self.treat_state(s), out);
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
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.roofs.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.stairs.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.columns.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        for x in p.extruded_solids.iter().flatten() {
            put(&x.id, self.treat(x.renovation.as_ref()), out);
        }
        // [271] 2D-Zeichnungen (Möbel, Symbole und Elemente mit ausdrücklichem Status) und Bäume ([149]: Status = Umbau-Status).
        for x in p.drawings2d.iter().filter(|d| drawing_takes_part(d)) {
            put(&x.id, self.treat(x.renovation.as_ref()), &mut out);
        }
        for t in p.trees.iter().flatten() {
            put(&t.id, self.treat(Some(&tree_renovation(t))), &mut out);
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
        let edit = self.edit.as_ref().map_or(String::new(), |e| format!("|edit:{}", e.key()));
        match &self.filter {
            Some(f) => format!("{}:{:?}{:?}{:?}:{:?}:{:?}|{opts}{edit}", f.id, f.existing, f.demolish, f.new, self.upto, self.styles),
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
}

impl Resolved {
    pub fn is_empty(&self) -> bool {
        self.hidden.is_empty() && self.styled.is_empty() && self.patches.is_empty()
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
        Some(v) => {
            let r = v.resolve(p);
            if r.hidden.is_empty() {
                std::borrow::Cow::Borrowed(p)
            } else {
                std::borrow::Cow::Owned(without_hidden(p, &r.hidden))
            }
        }
        None => std::borrow::Cow::Borrowed(p),
    }
}

/// Das Projekt im Zustand eines Filters (`filter`: Id/Name, `phase`: Etappe); ohne gültigen Filter unverändert.
pub fn project_in_state<'a>(p: &'a Project, filter: Option<&str>, phase: Option<&str>) -> std::borrow::Cow<'a, Project> {
    match View::new(p, filter, phase) {
        Some(v) => {
            let r = v.resolve(p);
            if r.hidden.is_empty() {
                std::borrow::Cow::Borrowed(p)
            } else {
                std::borrow::Cow::Owned(without_hidden(p, &r.hidden))
            }
        }
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
    let st = Style { fill: st.fill.clone(), line: Some(st.line.clone().unwrap_or_else(|| st.fill.clone())), dashed: st.dashed };
    let mut extra = Vec::new();
    for q in prims[from..].iter_mut() {
        restyle_with(q, &st, &mut extra, fill);
    }
    prims.extend(extra);
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
    if r.styled.is_empty() {
        return;
    }
    let rgb = |id: &str| r.styled.get(id).map(|s| crate::style::hex_to_rgb(&s.fill, crate::style::WALL_RGB));
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

#[cfg(test)]
#[path = "renovation_tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "renovation_tests2.rs"]
mod tests2;
