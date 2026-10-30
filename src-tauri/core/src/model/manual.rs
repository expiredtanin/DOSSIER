//! Von Hand geschriebene Teile des Modells: Typen mit Tag (diskriminierte Unions) und `Vec2`.
//! Quelle der entsprechenden TS-Typen in `src/model/types.generated.ts` ([K4] S4).

use super::generated::*;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Felder, die das Modell (noch) nicht kennt: bleiben beim Hin-und-zurück erhalten, damit Rust
/// nichts verliert, was neuere Programmstände oder Erweiterungen in die Datei geschrieben haben.
/// In Tests meldet ein unbekanntes Feld sich als Panic — so fällt eine Lücke im Modell auf.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Extra(pub serde_json::Map<String, serde_json::Value>);

thread_local! {
    /// Gesetzt während [`to_value_typed_only`]: `Extra` schreibt dann nichts.
    static OMIT_EXTRA: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

impl Serialize for Extra {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if OMIT_EXTRA.with(|f| f.get()) {
            serde_json::Map::new().serialize(s)
        } else {
            self.0.serialize(s)
        }
    }
}

/// Serialisiert nur, was das typisierte Modell kennt (ohne `Extra`-Felder) — für den
/// Rundreise-Test TS → Rust → TS ([K4] S4): fehlt dem Modell ein Feld, fehlt es hier.
pub fn to_value_typed_only<T: Serialize>(v: &T) -> serde_json::Result<serde_json::Value> {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            OMIT_EXTRA.with(|f| f.set(false));
        }
    }
    OMIT_EXTRA.with(|f| f.set(true));
    let _reset = Reset;
    serde_json::to_value(v)
}

impl<'de> Deserialize<'de> for Extra {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let m = serde_json::Map::<String, serde_json::Value>::deserialize(d)?;
        #[cfg(test)]
        if !m.is_empty() {
            panic!("Modell kennt Felder nicht: {:?}", m.keys().collect::<Vec<_>>());
        }
        Ok(Extra(m))
    }
}

impl Extra {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, TS)]
#[cfg_attr(test, serde(deny_unknown_fields))]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

/// Vertikale Bindung einer Wandkante (UK/OK).
///   • "floor"  — an ein Geschoss gebunden: Z = baseElevation des Geschosses
///     (+ optionalem `offset`). Stapelt automatisch mit dem Geschoss.
///   • "custom" — fester absoluter Z-Wert (Meter).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "mode")]
pub enum VerticalAnchor {
    #[serde(rename = "floor")]
    Floor {
        #[serde(rename = "floorId")]
        floor_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        offset: Option<f64>,
    },
    #[serde(rename = "custom")]
    Custom { z: f64 },
}

// ── Stütze (Column, Tragwerk) ──────────────────────────────────────────────
// Eine Stütze ist im Kern eine PLATZIERTE PROFIL-EXTRUSION: ein an `position`
// gesetztes 2D-Profil (Rechteck oder Kreis), um `rotation` gedreht, über `height`
// nach oben extrudiert. Anders als der generische `ExtrudedSolid` trägt sie
// vollständige BIM-Attribute (Geschoss, Kategorie, optionales Bauteil, UK/OK-
// Anker) — sie lebt daher in `Project.columns` mit eigenem Selektionskanal.

/// Querschnitt einer Stütze im Grundriss (Modell-Meter), lokal um `position`.
///   • "rect"  — Rechteck `width` (X, quer) × `depth` (Y, längs), vor Rotation.
///   • "round" — Kreis mit `radius`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind")]
pub enum ColumnProfile {
    #[serde(rename = "rect")]
    Rect { width: f64, depth: f64 },
    #[serde(rename = "round")]
    Round { radius: f64 },
}

/// Merkmal, an dem ein Bemassungspunkt hängt ([38], `dim_assoc.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum DimFeature {
    /// Punkt auf einer Wandlinie: `index` = Schichtgrenze (0 = erste Fläche, wie die Fanglinien;
    /// fehlt = Achse), `t` = Anteil entlang Anfang→Ende (0/1 = Wandende).
    #[serde(rename = "wall")]
    Wall,
    /// Öffnung: `index` 0 = Leibung Anfang, 1 = Leibung Ende, 2 = Mitte; `index2` = Schichtgrenze
    /// der Wirtswand (fehlt = Achse).
    #[serde(rename = "opening")]
    Opening,
    /// Eckpunkt `index` (Stützen-Umriss, Decken-/Dach-/Raum-Umriss, Punkte einer 2D-Zeichnung).
    #[serde(rename = "vertex")]
    Vertex,
    /// Punkt auf Kante `index` (Anfang→nächster Eckpunkt) beim Anteil `t` (0.5 = Mitte).
    #[serde(rename = "edge")]
    Edge,
    /// Mittelpunkt (Stütze, Kreis, Bogen, Ellipse).
    #[serde(rename = "center")]
    Center,
    /// Schnittpunkt der Wandlinie (`id`, `index`) mit der Wandlinie (`id2`, `index2`) — Ecken.
    #[serde(rename = "intersection")]
    Intersection,
}

/// Bezug eines Bemassungspunkts auf ein Element ([38]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct DimRef {
    /// Element-id (Wand, Öffnung, Stütze, Decke, Dach, Raum oder 2D-Zeichnung).
    pub id: String,
    pub feature: DimFeature,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub t: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id2: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub index2: Option<u32>,
    /// Normalabstand Merkmal → Masslinie (Modell-Meter, links der Masslinie positiv); fehlt = 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub d: Option<f64>,
    /// Bezug ungültig (Element/Punkt weg): der Punkt bleibt an der zuletzt gespeicherten Lage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lost: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Offset2 {
    pub along: f64,
    pub perp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum KoteKind {
    #[serde(rename = "okFertig")]
    OkFertig,
    #[serde(rename = "ukFertig")]
    UkFertig,
    #[serde(rename = "okRoh")]
    OkRoh,
    #[serde(rename = "ukRoh")]
    UkRoh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SplineMode {
    Fit,
    Control,
}

/// Geometrie eines 2D-Zeichenelements (Tag `shape`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "shape")]
pub enum Drawing2DGeom {
    #[serde(rename = "line")]
    Line { a: Vec2, b: Vec2 },
    /// Konstruktionslinie (Hilfslinie): unendliche Ausrichtungslinie durch `a`
    /// und `b`, nur zwei gesetzte Punkte gespeichert — beim Rendern/Picken WEIT
    /// über beide hinaus verlängert (s. `XLINE_EXTEND_M`), damit sie optisch/
    /// funktional unendlich wirkt, ohne echte Unendlichkeits-Sonderfälle in der
    /// SVG-/PDF-/DXF-Pipeline zu brauchen. Bewusst NICHT offset-/trim-/
    /// extend-/join-fähig (reine Ausrichtungshilfe, kein reales Bauteil).
    #[serde(rename = "xline")]
    Xline { a: Vec2, b: Vec2 },
    /// Strahl (Nutzer-Wunsch: „Ray, halb-unendliche Linie — nur `xline`,
    /// beidseitig unendlich, existiert"): `a` ist der FESTE Anker (wird NICHT
    /// verlängert), `b` bestimmt nur die Richtung — beim Rendern/Picken weit
    /// über `b` hinaus verlängert (dieselbe `XLINE_EXTEND_M`-Konstante), aber
    /// NICHT über `a` hinaus. Sonst wie `xline`: bewusst NICHT offset-/trim-/
    /// extend-/join-fähig.
    #[serde(rename = "ray")]
    Ray { a: Vec2, b: Vec2 },
    #[serde(rename = "polyline")]
    Polyline {
        pts: Vec<Vec2>,
        closed: bool,
        /// Optionale Bogen-Segmente (DXF-„Bulge"-Konvention): `bulge[i]` krümmt
        /// das Segment `pts[i] → pts[i+1]` (bei `closed` zusätzlich `bulge[pts.
        /// length-1]` für das Schliess-Segment `pts[letzter] → pts[0]`) zu einem
        /// Kreisbogen statt einer Geraden. `bulge[i] = tan(Δ/4)` (Δ = Öffnungs-
        /// winkel des Bogens); Vorzeichen bestimmt die Seite (positiv = links von
        /// a→b, s. `geometry/bulge.ts::bulgeArcPoints`). Fehlt der Eintrag oder
        /// ist er 0/nahe 0 (`< 1e-9`), bleibt das Segment gerade — rein additiv,
        /// jede bestehende Polylinie ohne `bulge` verhält sich exakt wie bisher.
        /// Nur DIESES Feld unterscheidet eine „echte" Bogen-Polylinie von der
        /// bisherigen rein geradlinigen; Rendering/Fläche/Export tessellieren den
        /// Bogen (kein eigenes SVG-Arc-Primitiv, analog Ellipse/Spline/Bezier).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        bulge: Option<Vec<f64>>,
    },
    #[serde(rename = "rect")]
    Rect { min: Vec2, max: Vec2 },
    #[serde(rename = "circle")]
    Circle { center: Vec2, r: f64 },
    #[serde(rename = "arc")]
    Arc { center: Vec2, r: f64, a0: f64, a1: f64 },
    /// Ellipse — achsparalleles Zentrum + zwei Halbachsen + Drehung (Radiant,
    /// CCW). Das Zeichen-Werkzeug erzeugt bewusst nur `rotation: 0`; das Feld
    /// existiert für zukünftige Dreh-Bearbeitung bzw. gedrehte Ellipsen aus
    /// anderen Quellen. Rendering/Snapping/Griffe tessellieren sie (wie ehemals
    /// `circle`), kein eigenes glattes SVG-Primitiv (s. `generatePlan/drawing2d.ts`).
    #[serde(rename = "ellipse")]
    Ellipse { center: Vec2, rx: f64, ry: f64, rotation: f64 },
    /// Kubische Bezier-Kette: `pts.length` ≡ 1 (mod 3), ≥ 4 — Punkte im Muster
    /// Anker·Griff·Griff·Anker·Griff·Griff·Anker·… (jedes weitere Segment fügt
    /// 3 Punkte an). Manuell gesetzte Kontrollpunkte (klassisches Bezier-
    /// Werkzeug), im Unterschied zu `spline` (Kurve DURCH Punkte, automatisch
    /// geglättet). Immer offen (kein `closed`-Feld).
    #[serde(rename = "bezier")]
    Bezier { pts: Vec<Vec2> },
    /// Glatte Kurve über `pts`, analog `polyline`, aber mit gerundetem statt
    /// geradem Verlauf zwischen den Wegpunkten. `closed` schliesst den Ring
    /// (letzter Wegpunkt → erster). `mode` (optional, Default `"fit"` bei
    /// Fehlen — additiv wie üblich): `"fit"` = Kurve verläuft DURCH `pts`
    /// (uniformer Catmull-Rom, das bisherige/einzige Verhalten); `"control"` =
    /// `pts` sind Kontrollpunkte eines kubischen B-Splines (CV-Modus), die
    /// Kurve wird nur von ihnen gezogen, berührt sie i. A. NICHT (Ausnahme:
    /// Start/Ende bei offener Kurve, geklemmt). S. `tools/curves.ts::
    /// sampleUniformBSpline` für die Geometrie.
    #[serde(rename = "spline")]
    Spline {
        pts: Vec<Vec2>,
        closed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, inline)]
        mode: Option<SplineMode>,
    },
    /// Masslinie (lineare Bemassung, SIA 400 B.5.3): misst den Abstand `a`↔`b`.
    /// `offset` ist der VORZEICHENBEHAFTETE Normalabstand (Modell-Meter, links
    /// von a→b positiv), in dem die eigentliche Masslinie parallel zu a-b liegt
    /// — Masshilfslinien laufen von a/b bis zu dieser Linie. Die Masszahl wird
    /// beim Rendern aus `dist(a,b)` abgeleitet (nicht gespeichert), bleibt also
    /// beim Verschieben der Griffe automatisch korrekt. Rein 2D (kein Bezug auf
    /// andere Elemente — Assoziativität nur über die eigenen Endpunkte).
    ///
    /// `pts.length` ≥ 2, IMMER kollinear (Werkzeug erzwingt das beim Zeichnen/
    /// Ergänzen — eine Masskette ist eine Gerade, kein Zickzack-Pfad). Jedes
    /// aufeinanderfolgende Punktpaar ist EIN gemessenes Segment (Reihenbemassung,
    /// SIA 400 Figur 14), alle teilen denselben `offset`. EIN Element für die
    /// ganze Kette (nicht mehrere) — spätere Bearbeitung kann Punkte ergänzen
    /// (verlängern ODER dazwischen einfügen, s. `commands/cmds/dimension.ts`).
    #[serde(rename = "dimension")]
    Dimension {
        pts: Vec<Vec2>,
        offset: f64,
        /// Darstellungs-Feinheiten der Bemassung, ALLE optional und in
        /// PAPIER-MILLIMETERN — so, wie die Zeichnungsnorm sie angibt
        /// („Überstand 2 mm"), also unabhängig vom Massstab. Umgerechnet wird
        /// beim Erzeugen des jeweiligen Plans (`model/dimension.ts::mmToModel`);
        /// der Plan wird je Ziel — Bildschirm bzw. Layout-Viewport — eigens
        /// erzeugt, der Massstab ist dort also bekannt und eindeutig.
        /// Fehlt ein Wert, gilt `DIM_DEFAULTS_MM`.
        ///
        /// Abstand Masshilfslinie → bemessener Punkt (Default 1 mm).
        #[serde(rename = "gapMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        gap_mm: Option<f64>,
        /// Überstand der Masshilfslinie ÜBER die Masslinie hinaus (Default 1 mm).
        #[serde(rename = "overshootMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        overshoot_mm: Option<f64>,
        /// Länge der Massstriche an den Masslinien-Enden (Default 3 mm).
        #[serde(rename = "tickLenMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tick_len_mm: Option<f64>,
        /// Schrifthöhe der Masszahl (Default 4 mm).
        #[serde(rename = "textHeightMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        text_height_mm: Option<f64>,
        /// Strichstärken der drei Bestandteile, in PAPIER-MILLIMETERN (wie jede
        /// andere Strichstärke hier — erst beim Rendern aufgelöst und daher
        /// massstabsunabhängig; im Gegensatz zu den Abständen oben, die
        /// zwangsläufig Modellmass sind). Fehlt ein Wert, gilt der bisherige
        /// Default: Masslinie und Masshilfslinien erben die Strichstärke des
        /// Elements, die Massstriche werden doppelt so dick gezeichnet
        /// (Erkennbarkeit, SIA 400 Figur 13).
        #[serde(rename = "lineWeightMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        line_weight_mm: Option<f64>,
        #[serde(rename = "extWeightMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        ext_weight_mm: Option<f64>,
        #[serde(rename = "tickWeightMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tick_weight_mm: Option<f64>,
        /// Verschiebung der Masszahl aus ihrer Standardlage, ebenfalls in
        /// PAPIER-MILLIMETERN, im Segment-Koordinatensystem: `along` entlang
        /// der Masslinie (+ = Richtung b), `perp` quer dazu (+ = von der
        /// Masslinie weg). Fehlt es, sitzt die Zahl mittig knapp über der
        /// Masslinie. Bei einer Masskette gilt der Versatz je Segment,
        /// Index = Segmentnummer.
        #[serde(rename = "textOffsetsMm", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, inline)]
        text_offsets_mm: Option<Vec<Offset2>>,
        /// Assoziative Bemassung ([38]): je Punkt (Index wie `pts`) der Bezug auf ein Merkmal eines
        /// Elements (`null` = freier Punkt). Der Kern führt `pts` nach jeder Änderung nach
        /// (`dim_assoc.rs`); `pts` ist damit immer die zuletzt aufgelöste Lage und der Rückfall,
        /// wenn ein Bezug ungültig wird. Fehlt das Feld, ist die Bemassung frei wie bisher.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        refs: Option<Vec<Option<DimRef>>>,
    },
    /// Höhenkote (SIA 400 B.5.4, Figur 18): Dreieck-Symbol + Höhenwert (Meter,
    /// ±0.00-Referenz frei wählbar, s. Norm) an einem Punkt. `kind` bestimmt
    /// Dreieck-Richtung (OK = Spitze nach unten, UK = Spitze nach oben) UND
    /// Füllung (fertig = Kontur/hohl, roh = voll gefüllt) — vier norm-genaue
    /// Varianten, die fünfte („OK fertig UND roh kombiniert") ist nicht gebaut.
    /// `at` ist die SPITZE des Dreiecks (der exakte referenzierte Punkt).
    #[serde(rename = "kote")]
    Kote {
        at: Vec2,
        value: f64,
        #[ts(inline)]
        kind: KoteKind,
        /// Drehung (Radiant); Werkzeug erzeugt bewusst nur 0, s. Ellipse-Muster.
        rotation: f64,
    },
    /// Detail-/Schnitt-Verweis-Symbol (Nutzer-Wunsch: „Nur `leaderTarget` an
    /// Text — kein zweiteiliges Verweis-Symbol, das eine Sheet/Layout-ID
    /// trägt"). Klassische zweigeteilte Verweisblase: Kreis mit waagrechter
    /// Trennlinie, `label` oben (Detail-/Schnitt-Bezeichner, z. B. „A"/„1"),
    /// Blattbezeichnung unten (`sheetLayoutId` verweist auf ein echtes
    /// `Project.layouts`-Blatt und LÖST seinen Namen zur Anzeige auf; fehlt der
    /// Verweis oder ist das Blatt gelöscht, zeigt `sheetLabel` einen manuell
    /// getippten Platzhalter). Fixe Modell-Meter-Grösse wie beim strukturell
    /// ähnlichen `kote`-Symbol (keine Papier-mm-Skalierung — dieselbe bewusste
    /// Vereinfachung).
    #[serde(rename = "detailref")]
    Detailref {
        /// Zentrum des Kreises.
        at: Vec2,
        /// Obere Zeile: Detail-/Schnitt-Bezeichner.
        label: String,
        /// Verknüpftes Blatt (`Project.layouts[].id`); `undefined` = kein Verweis.
        #[serde(rename = "sheetLayoutId", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sheet_layout_id: Option<String>,
        /// Untere Zeile OHNE Verweis (oder als Blatt gelöscht wurde): manuell
        /// getippter Platzhalter. Mit gültigem `sheetLayoutId` wird stattdessen
        /// der ECHTE Blattname angezeigt (immer aktuell, keine Duplizierung).
        #[serde(rename = "sheetLabel", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sheet_label: Option<String>,
    },
    /// Massstabsbalken (Nutzer-Wunsch: „kein Massstabsbalken existiert"). Anders
    /// als Bemassung/Kote/Detail-Verweis ist die BALKENLÄNGE bewusst in ECHTEN
    /// Modell-Metern angegeben (nicht Papier-mm): der ganze Plan wird ohnehin im
    /// Papier-Massstab abgebildet, ein 1-Meter-Segment erscheint dadurch
    /// automatisch in der richtigen Papiergrösse für JEDEN Massstab — keine
    /// eigene Umrechnung nötig. Nur die Balkenhöhe/Beschriftungsgrösse sind
    /// (wie bei Bemassung/Kote) Papier-mm, damit sie unabhängig vom Massstab
    /// lesbar bleiben. Achsparallel (horizontal) — keine Drehung in v1, analog
    /// zur bewusst einfachen Ellipse-Erzeugung.
    #[serde(rename = "scalebar")]
    Scalebar {
        /// Linke untere Ecke des Balkens.
        at: Vec2,
        /// Länge EINES Segments in ECHTEN Modell-Metern.
        #[serde(rename = "segmentLength")]
        segment_length: f64,
        /// Anzahl Segmente (abwechselnd gefüllt/leer).
        segments: f64,
    },
    /// Punkt-/Knotenmarker (Nutzer-Wunsch: „Punkt-/Knotenmarker" aus der
    /// Werkzeug-Lücken-Liste). Kleines, fest grosses Kreuz-in-Kreis-Symbol an
    /// `at` — markiert einen einzelnen Referenz-/Vermessungspunkt im Plan (z. B.
    /// einen Fixpunkt), OHNE selbst Bemassung/Text zu tragen. Fixe Modell-
    /// Meter-Grösse wie `kote`/`detailref` (keine Papier-mm-Skalierung) — ein
    /// physischer Bodenpunkt hat eine reale, vom Papier-Massstab unabhängige
    /// Grösse ist hier bewusst NICHT das Ziel; wie bei `kote` geht es um
    /// gleichbleibende Lesbarkeit im Plan.
    #[serde(rename = "pointmarker")]
    Pointmarker { at: Vec2 },
    #[serde(rename = "text")]
    Text {
        at: Vec2,
        text: String,
        height: f64,
        angle: f64,
        /// Optionale Spaltenbreite in Metern (Textspalte/Absatztext). Ist sie gesetzt,
        /// wird der Text beim Rendern wortweise auf diese Breite umgebrochen; fehlt
        /// sie, bleibt es einzeiliger Text (heutiges Verhalten).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        width: Option<f64>,
        /// Optionale einheitliche Formatierung des ganzen Texts (Schriftfamilie, fett/
        /// kursiv, Farbe …) — gesetzt über die Text-Formatier-Gruppe der Oberleiste,
        /// wenn dieser Text selektiert ist. Die Grösse bleibt bewusst über `height`
        /// (Modell-Meter) geführt, nicht über `marks.sizePt`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        marks: Option<Marks>,
        /// Reiches Textfeld (mehrere Absätze, gemischte Formatierung pro Zeichen —
        /// InDesign-/Affinity-artig): gesetzt über den Doppelklick-Editor
        /// (TextEditorDialog/RichTextEditor). Ist `doc` gesetzt, hat es Vorrang vor
        /// `text`/`marks` beim Rendern; `text` wird beim Schreiben als Reintext-
        /// Spiegel nachgeführt (DXF-Export, Suche, Alt-Konsumenten lesen weiter
        /// `text`). `width` bricht wie gehabt wortweise um.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        doc: Option<RichTextDoc>,
        /// Legenden-/Vorführungspfeil (Leader): optionale Zielposition, auf die
        /// eine dünne Linie + Pfeilspitze vom Text aus zeigt (z. B. Beschriftung
        /// eines entfernten Details). Kein eigener Shape — erbt dadurch die
        /// komplette Inline-Text-Editor-Infrastruktur (analog `width` bei der
        /// Textspalte). Gesetzt vom `leader`-Befehl, am normalen `text`-Werkzeug
        /// unverändert `undefined`.
        #[serde(rename = "leaderTarget", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        leader_target: Option<Vec2>,
        /// Zwischen-Knickpunkte der Hinweislinie, zwischen `at` (Textanker) und
        /// `leaderTarget` (Spitze) — Nutzer-Wunsch: „Hinweislinie hat nur EIN
        /// Segment, kein Knick-Punkt wie bei AutoCADs Multileader". Reihenfolge
        /// vom TEXTANKER zur SPITZE (wie die Zeichenrichtung im `leader`-Befehl:
        /// erst Spitze, dann rückwärts über die Knicke zum Text). Fehlt das
        /// Feld (Alt-Daten/einfache Hinweislinie), bleibt es bei der bisherigen
        /// geraden Linie `at → leaderTarget` — rein additiv, kein Format-Bruch.
        #[serde(rename = "leaderBendPoints", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        leader_bend_points: Option<Vec<Vec2>>,
        /// Text-entlang-Pfad: mind. 2 Stützpunkte, entlang derer der Text (nur
        /// `text`, KEIN `doc`/Rich-Formatting — v1 bewusst einstilig) über ein
        /// echtes SVG `<textPath>` fliesst. Ist gesetzt, bestimmt der Pfad die
        /// Position/Neigung jedes Zeichens; `at`/`angle` werden dann ignoriert
        /// (bleiben nur als Fallback für Alt-Konsumenten, die `pathPts` nicht
        /// kennen — s. `drawing2d.ts`). Griffe sind dann die Pfadpunkte selbst
        /// (wie bei `polyline`), nicht der einzelne Anker.
        #[serde(rename = "pathPts", default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        path_pts: Option<Vec<Vec2>>,
    },
    /// Platzierte Instanz eines wiederverwendbaren 2D-Symbols (`Project.
    /// blockDefs`, s. dort). `rotation` in Radiant. Trägt selbst KEINE Geometrie
    /// — die kommt beim Rendern/Picken/Snapping aus `blockDefId` + dieser
    /// Transformation. Verweist die Instanz auf eine gelöschte/unbekannte
    /// `blockDefId`, rendert sie schlicht nichts (kein Crash, s. `drawing2d.ts`).
    #[serde(rename = "block")]
    Block {
        #[serde(rename = "blockDefId")]
        block_def_id: String,
        at: Vec2,
        rotation: f64,
        /// Uniformer Skalierungsfaktor der Blockinstanz (Default 1, additiv/
        /// optional — alte Projektdateien ohne dieses Feld bleiben gültig).
        /// Nutzer-Wunsch: „Skalierung beim Einfügen" — zuvor gab es dafür kein
        /// Modellfeld, ein `scale`-Transform auf eine Blockinstanz war damit ein
        /// kompletter No-Op (kein Feld zum Multiplizieren). Bewusst NUR ein
        /// uniformer Skalar (keine unabhängigen x/y-Faktoren) — konsistent mit
        /// `rotation` (auch nur EIN Winkel, keine Scherung).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        scale: Option<f64>,
    },
    #[serde(rename = "image")]
    Image {
        /// Obere-linke Ecke der Bild-Box (Modell-Meter).
        min: Vec2,
        /// Untere-rechte Ecke der Bild-Box (Modell-Meter).
        max: Vec2,
        /// Bildquelle als Data-URL (PNG/JPEG) — eingebettet, keine externe Datei.
        src: String,
        /// Deckkraft 0..1 (Default 1).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        opacity: Option<f64>,
    },
}

/// Parametrische Wandregel (Tag `type`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
pub enum ParametricRule {
    #[serde(rename = "grid")]
    Grid(GridRule),
    #[serde(rename = "module")]
    Module(ModuleRule),
    #[serde(rename = "conditional-thickness")]
    ConditionalThickness(ConditionalThicknessRule),
    #[serde(rename = "reference-line")]
    ReferenceLine(ReferenceLineRule),
    #[serde(rename = "sequence")]
    Sequence(SequenceRule),
}

/// Kontext-Objekt (Tag `type`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
pub enum ContextObject {
    #[serde(rename = "importedMesh")]
    ImportedMesh(ImportedMesh),
    #[serde(rename = "contourSet")]
    ContourSet(ContourSet),
    #[serde(rename = "terrainMesh")]
    TerrainMesh(TerrainMesh),
    #[serde(rename = "image")]
    Image(ContextImage),
}

impl Default for Drawing2DGeom {
    fn default() -> Self {
        Drawing2DGeom::Pointmarker { at: Vec2::default() }
    }
}

impl Default for ColumnProfile {
    fn default() -> Self {
        ColumnProfile::Rect { width: 0.0, depth: 0.0 }
    }
}
