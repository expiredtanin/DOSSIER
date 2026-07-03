//! Analytischer Schnitt/Ansicht-Extraktor fuer Prismen-Modelle (Waende, Decken).
//!
//! ANSATZ: kein generisches Hidden-Line-Removal (HLR) ueber ein CAD-Kernel (OCCT),
//! sondern die Ausnutzung einer Modell-Invariante: JEDES Bauteil ist ein Prisma —
//! ein 2D-Grundriss-Polygon (`footprint`, Modell-Meter), konstant extrudiert ueber
//! ein Hoehenintervall `[z0, z1]` (siehe `WallInput`/`SlabInput`/`mesh.rs`). Bei
//! konstantem Querschnitt ueber die Hoehe ist der Schnitt einer VERTIKALEN Ebene
//! mit einem Prisma immer ein Rechteck (u-Intervall x Hoehenintervall) — nie ein
//! Trapez —, weil die Hoehe unabhaengig von der Grundriss-Position ist. Das macht
//! die Schnittgeometrie analytisch trivial im Vergleich zu generischem HLR.
//!
//! ## Schnittebene (`SectionPlane`)
//!
//! Repraesentiert generisch als Punkt + Normale (Normale == Blickrichtung, zeigt
//! vom Betrachter ins Modell). Komfort-Konstruktoren decken die vier
//! Architektur-Standardfaelle ab: vertikale Ebene senkrecht zur Grundriss-X- bzw.
//! -Y-Achse, Blick nach `+X`/`-X`/`+Y`/`-Y` (wie Schnitt A-A/B-B mit Pfeilen im
//! Grundriss). Nur VERTIKALE Ebenen (Normale ohne Hoehen-Komponente) werden
//! unterstuetzt — Horizontalschnitte (Grundriss-Ebenen) sind Sache der bestehenden
//! 2D-Plan-Pipeline, nicht dieses Moduls.
//!
//! ## Koordinatensystem der Ausgabe (u, v)
//!
//! - **Ursprung:** `SectionPlane::point`, projiziert.
//! - **u (horizontal in der Zeichnung):** Strecke entlang der Schnittebene,
//!   senkrecht zur Blickrichtung, in der Horizontalen. Berechnet als
//!   `u_axis = normalize(cross(normal, world_up))` — dieselbe rechtshaendige
//!   Kamera-Konvention wie `math::look_at` (dort `s = cross(f, up)`), damit die
//!   Vorzeichen-Konvention modulübergreifend konsistent bleibt. Bei den
//!   Standard-Konstruktoren entspricht `u` direkt der jeweils ANDEREN
//!   Grundriss-Achse (Schnitt entlang X -> u = Modell-Y, Schnitt entlang Y ->
//!   u = -Modell-X).
//! - **v (vertikal in der Zeichnung, "Hoehe"):** `v = world.y`, ABSOLUT (nicht
//!   relativ zur Schnittebene). `world.y` ist in dieser Codebasis durchgaengig
//!   die Hoehen-Achse (Y-up, siehe `types.rs`/`mesh.rs`/`math.rs`: "world.y =
//!   Hoehe"). Diese Doku benutzt bewusst `v = world.y` statt `world.z`, um mit
//!   der etablierten Y-up-Konvention der gesamten Crate konsistent zu bleiben.
//! - **Einheiten:** Meter, wie ueberall in `render3d`.
//!
//! ## Cut-Polygone vs. Projektions-Kanten
//!
//! - `cut_polygons`: Prismen, deren Grundriss von der Schnittlinie (der
//!   Grundriss-Projektion der Ebene) durchquert wird — das GESCHNITTENE
//!   Material (spaeter Schnitt-Schraffur). Immer Rechtecke (siehe oben).
//! - `visible_edges`/`hidden_edges`: die Draufsicht-Silhouette (Kanten der
//!   Boxen: 4 vertikale Eckkanten + Boden-/Deckel-Umrisskanten je Prisma) ALLER
//!   Prismen, die (zumindest teilweise) HINTER der Ebene liegen (Blickrichtung),
//!   orthogonal auf die Ebene projiziert. Sichtbarkeit wird gegen alle anderen
//!   Prismen (inkl. des eigenen — Selbstverdeckung der Rueckseite durch die
//!   Vorderseite EINES Bauteils ist real und gewollt) getestet: ein Prisma
//!   verdeckt einen projizierten Punkt, wenn es (a) an dieser u-Position liegt,
//!   (b) bei dieser Hoehe existiert UND (c) naeher an der Ebene liegt als der
//!   Punkt. Kanten werden dafuer in Sichtbarkeits-Teilstuecke zerlegt (echtes
//!   1D-Intervall-Clipping in ihrem Parameterbereich, kein Nur-Mittelpunkt-Test).
//!
//! ## Oeffnungen (Tueren/Fenster)
//!
//! `WallInput::openings` (siehe `types.rs`) gibt je Wand ein Intervall entlang
//! der Wandachse (`from`/`to`, Meter ab `start`) plus eine vertikale Bruestungs-/
//! Kopfhoehe (`sill`/`height`, relativ zu `base_elevation`) an. Dieses Modul
//! nutzt das fuer zwei getrennte Faelle:
//!
//! - **Cut-Polygone:** trifft die Schnittlinie eine Wand exakt im Bereich einer
//!   Oeffnung, wird die volle Rechteck-Hoehe `[z0,z1]` in bis zu ZWEI Rechtecke
//!   gesplittet (Bruestung `[z0, z0+sill]`, Sturz `[z0+sill+height, z1]`) statt
//!   eines einzelnen Vollrechtecks — bevorzugt gegenueber einem Loch-Polygon
//!   (Ring mit Aussparung): mehrere einfache, konvexe Rechtecke sind fuer die
//!   spaetere Schraffur/Fuellung (Ziel: `render2d::types::FillPolygon`, das
//!   NUR einfache Ringe kennt) direkt verwendbar, waehrend ein Loch-Polygon
//!   ein Ring-mit-Loch-Format braeuchte, das die Zielstruktur (noch) nicht hat.
//!   Liegt die Oeffnung ausserhalb der aktuellen Schnittposition, entsteht wie
//!   zuvor ein einzelnes Vollrechteck (Regressionsfall, siehe Tests).
//! - **Projektion/Ansicht:** eine Wand mit Oeffnungen bekommt zusaetzlich zur
//!   Boxen-Drahtsilhouette die vier Rahmenkanten jeder Oeffnung (zwei Leibungen,
//!   Sturz, Bruestung) als eigene projizierte Kanten. Fuer die Verdeckung wird
//!   jede Wand-Bounding-Box um ihre Oeffnungen als "Loch" reduziert (siehe
//!   `PrismBounds::opening_voids`): ein anderes (oder das gleiche) Bauteil
//!   hinter der Wand wird in exakt dem (u, Hoehe)-Rechteck der Oeffnung NICHT
//!   von dieser Wand verdeckt — "Durchblick".
//!
//!   GENAUIGKEIT (bewusste Vereinfachung, siehe auch unten "Bekannte
//!   Vereinfachungen"): die Zuordnung "welche Wandachsen-Position entspricht
//!   dieser u-Projektionsposition" ist nur DANN exakt/aussagekraeftig, wenn die
//!   Wandachse hinreichend parallel zur u-Achse der Schnittebene steht — das ist
//!   GENAU der Fall, in dem man die Wand als Ansicht/Elevation von vorne sieht
//!   (und ein Fenster darin ueberhaupt als Durchblick sichtbar waere). Steht die
//!   Wand naeher an "senkrecht zur u-Achse" (Wand auf Kante gesehen bzw. der
//!   Cut-Fall), wird die Durchblick-Berechnung uebersprungen und die Wand bleibt
//!   fuer die Verdeckung VOLL UNDURCHSICHTIG (konservativ hidden) — ein
//!   Kante-auf-Kante gesehenes Fenster liefert ohnehin keine sinnvolle
//!   Durchblick-Flaeche in der Projektion. Schwelle: siehe `AXIS_ALIGN_EPS`.
//!
//!   Die eigenen Rahmenkanten einer Oeffnung werden NICHT gegen das eigene
//!   Bauteil auf Verdeckung geprueft (ein Loch kann sich nicht selbst verdecken);
//!   gegen ALLE ANDEREN Bauteile gilt die normale Verdeckungslogik.
//!
//! ## Bekannte Vereinfachungen (siehe auch docs/design/engine-section-pipeline.md)
//!
//! - Verdeckung nutzt die ACHSPARALLELE (u, Tiefe)-Bounding-Box jedes Prismas,
//!   nicht dessen exakte (ggf. konkave/diagonale) Grundrissform. Fuer Waende
//!   (Rechteck-Baender) und Decken (i.d.R. konvexe Rechtecke) ist das exakt;
//!   fuer stark diagonale oder konkave Grundrisse kann es zu Ueberverdeckung
//!   fuehren.
//! - Keine Wandknoten-Verschneidung (T-/X-Stoesse): DIESES Modul behandelt
//!   Waende weiterhin als eigenstaendige, stumpf abgeschlossene Quader, die
//!   sich an Ecken UEBERLAPPEN (kein Miter-Join) — sowohl fuer die Cut-Polygone
//!   als auch fuer die Verdeckungs-Bounding-Box. `mesh.rs` (die Vollkoerper-
//!   Extrusion fuer die 3D-Ansicht) berechnet die Eck-Gehrung inzwischen SELBST
//!   (`mesh::compute_wall_miters`, aus der Wandkonnektivitaet); dieses Modul
//!   zieht davon bewusst KEINEN Nutzen, weil seine Verdeckungs-Bounding-Box
//!   ohnehin nur die achsparallele Grundflaeche kennt (siehe oben) — eine
//!   gehrte, nicht-achsparallele Kante wuerde dort keinen Praezisionsgewinn
//!   bringen. Das kann in Ecknaehe dazu fuehren, dass eine Wand als "in eine
//!   andere eingebettet" verdeckt erscheint (siehe Test
//!   `eck_ueberlappung_verdeckt_kante_am_wandknoten` unten) — real, aber ein
//!   Artefakt der fehlenden Verschneidungslogik DIESES Moduls, kein Bug.
//! - Oeffnungen werden hier (Cut + Projektion) UND von der Vollkoerper-
//!   Extrusion in `mesh.rs` ausgewertet (`mesh::wall_solid_segments`) — beide
//!   nutzen dieselbe Bruestungs-/Sturz-Zerlegung (`crate::openings::
//!   split_range_by_voids`), damit Cut-Ansicht und 3D-Solid-Ansicht
//!   konsistent bleiben.
//! - Oeffnungs-Durchblick nutzt dieselbe achsparallele Bounding-Box-Naeherung
//!   wie die allgemeine Verdeckung (kein exaktes Polygon-Clipping der Lochflaeche
//!   gegen dahinterliegende Kanten) und wird bei Wand-Orientierungen nahe
//!   "senkrecht zur u-Achse" konservativ auf "kein Durchblick" zurueckgestuft
//!   (siehe Abschnitt "Oeffnungen" oben).
//! - Vertices exakt AUF der Schnittlinie werden nicht robust (kein Tie-Breaking/
//!   Pertubation); die Testszenarien vermeiden diesen Sonderfall bewusst.

use serde::{Deserialize, Serialize};

use crate::math;
use crate::types::{Opening, Point2, Rgb, SlabInput, WallInput};

/// Toleranz fuer "naeher an der Ebene" / Grenzwert-Vergleiche (Meter, Tiefe/Hoehe).
const EPS: f32 = 1e-4;
/// Mindestlaenge eines Ueberdeckungs-Teilstuecks, damit es als echte Verdeckung
/// zaehlt (verhindert hauchduenne Treffer durch reine Kanten-/Eckenberuehrung).
const MIN_SPAN: f32 = 1e-4;

// ─────────────────────────────────────────────────────────────────────────────
// Schnittebene
// ─────────────────────────────────────────────────────────────────────────────

/// Eine Schnitt-/Ansichtsebene: Punkt auf der Ebene + Normale. Die Normale ist
/// GLEICHZEITIG die Blickrichtung (zeigt vom Betrachter weg, ins Modell hinein).
/// Nur vertikale Ebenen (Normale ohne Y-Komponente) sind fuer dieses Modul
/// sinnvoll — siehe Moduldoc.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SectionPlane {
    pub point: [f32; 3],
    pub normal: [f32; 3],
}

impl SectionPlane {
    /// Generischer Konstruktor; die Normale wird normalisiert.
    pub fn new(point: [f32; 3], normal: [f32; 3]) -> Self {
        Self {
            point,
            normal: math::normalize(normal),
        }
    }

    /// Vertikaler Schnitt/Ansicht bei Grundriss-X = `x`, Blick nach +X.
    pub fn looking_plus_x(x: f32) -> Self {
        Self::new([x, 0.0, 0.0], [1.0, 0.0, 0.0])
    }

    /// Vertikaler Schnitt/Ansicht bei Grundriss-X = `x`, Blick nach -X.
    pub fn looking_minus_x(x: f32) -> Self {
        Self::new([x, 0.0, 0.0], [-1.0, 0.0, 0.0])
    }

    /// Vertikaler Schnitt/Ansicht bei Grundriss-Y = `y`, Blick nach +Y.
    pub fn looking_plus_y(y: f32) -> Self {
        Self::new([0.0, 0.0, y], [0.0, 0.0, 1.0])
    }

    /// Vertikaler Schnitt/Ansicht bei Grundriss-Y = `y`, Blick nach -Y.
    pub fn looking_minus_y(y: f32) -> Self {
        Self::new([0.0, 0.0, y], [0.0, 0.0, -1.0])
    }

    /// u-Achse der Projektion: horizontal, senkrecht zur Blickrichtung (siehe
    /// Moduldoc — dieselbe Konvention wie `math::look_at`s `right`-Vektor).
    fn u_axis(&self) -> [f32; 3] {
        let up = [0.0, 1.0, 0.0];
        let u = math::cross(self.normal, up);
        if math::length(u) > 1e-6 {
            math::normalize(u)
        } else {
            // Entartet nur, wenn die Normale (fast) vertikal ist — fuer dieses
            // Modul kein sinnvoller Eingabefall (siehe Moduldoc), Fallback
            // verhindert NaN.
            [1.0, 0.0, 0.0]
        }
    }

    /// Projiziert einen Weltpunkt nach (u, v). `v = world.y` (absolute Hoehe).
    pub fn project(&self, p: [f32; 3]) -> [f32; 2] {
        let rel = math::sub(p, self.point);
        [math::dot(rel, self.u_axis()), p[1]]
    }

    /// Vorzeichenbehaftete Tiefe entlang der Blickrichtung (`normal`). `> 0`
    /// heisst "hinter der Ebene" (im Blickfeld, wie es die Moduldoc nutzt).
    pub fn depth(&self, p: [f32; 3]) -> f32 {
        math::dot(math::sub(p, self.point), self.normal)
    }

    /// Grundriss-Anteil der Normale (X,Z-Komponenten der Weltnormale).
    fn plan_normal(&self) -> [f32; 2] {
        [self.normal[0], self.normal[2]]
    }

    /// Grundriss-Anteil des Ebenenpunkts.
    fn plan_point(&self) -> Point2 {
        [self.point[0], self.point[2]]
    }

    /// Grundriss-Anteil der u-Achse.
    fn plan_u_axis(&self) -> Point2 {
        let u = self.u_axis();
        [u[0], u[2]]
    }
}

/// Modell-Punkt `[x, y]` (Grundriss) + Hoehe -> Weltpunkt (siehe `types.rs`:
/// `world.x = model.x, world.z = model.y, world.y = Hoehe`).
fn to_world(p: Point2, height: f32) -> [f32; 3] {
    [p[0], height, p[1]]
}

// ─────────────────────────────────────────────────────────────────────────────
// Bauteil-Referenz + Ausgabetypen
// ─────────────────────────────────────────────────────────────────────────────

/// Herkunfts-Art eines Prismas (fuer `ComponentRef`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComponentKind {
    Wall,
    Slab,
}

/// Referenz auf das Ursprungs-Bauteil eines Cut-Polygons/einer Kante: Art +
/// Index in das jeweilige Eingabe-Array (`walls`/`slabs`, wie hereingereicht).
/// `WallInput`/`SlabInput` haben (noch) keine eigene Id — der Index ist die
/// einzige stabile Referenz, die die aktuellen Typen hergeben; eine echte
/// Component-Id/Material-Referenz ist eine bekannte Luecke (siehe Moduldoc /
/// `docs/design/engine-section-pipeline.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentRef {
    pub kind: ComponentKind,
    pub index: usize,
}

/// Ein geschnittenes Bauteil-Rechteck in Schnittkoordinaten (u, v), Meter.
/// Bei diesem Modell (konstanter Querschnitt ueber die Hoehe) immer ein
/// Rechteck, aber generisch als Ring abgelegt (Kompatibilitaet zu
/// `render2d::types::FillPolygon`, das spaetere Ziel-Format).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CutPolygon {
    pub component: ComponentRef,
    pub color: Rgb,
    /// Ring-Ecken (u, v); erste != letzte (Ring implizit geschlossen).
    pub pts: Vec<[f32; 2]>,
}

/// Ein Liniensegment in Schnittkoordinaten (u, v), Meter.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SectionEdge {
    pub component: ComponentRef,
    pub a: [f32; 2],
    pub b: [f32; 2],
}

/// Vollstaendige Ausgabe eines Schnitt-/Ansichts-Laufs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SectionOutput {
    #[serde(rename = "cutPolygons")]
    pub cut_polygons: Vec<CutPolygon>,
    #[serde(rename = "visibleEdges")]
    pub visible_edges: Vec<SectionEdge>,
    #[serde(rename = "hiddenEdges")]
    pub hidden_edges: Vec<SectionEdge>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Interne Prisma-Repraesentation (Wand ODER Decke, vereinheitlicht)
// ─────────────────────────────────────────────────────────────────────────────

/// Ein Prisma: Grundriss-Polygon (Modell-Meter, `[x, y]`) extrudiert ueber
/// `[z0, z1]` (absolute Hoehe, Meter). Vereinheitlicht Wand-Baender und
/// Decken-Umrisse fuer die Schnittlogik.
struct Prism {
    kind: ComponentKind,
    index: usize,
    footprint: Vec<Point2>,
    z0: f32,
    z1: f32,
    color: Rgb,
    /// Nur fuer Waende: Achse + Oeffnungen (siehe `WallAxis`). `None` fuer
    /// Decken (Slabs kennen keine Oeffnungen).
    wall_axis: Option<WallAxis>,
}

/// Wandachse + Oeffnungen, wie sie fuer die Oeffnungs-Zuordnung bei Cut-
/// Polygonen/Projektion gebraucht werden (siehe Moduldoc "Oeffnungen").
struct WallAxis {
    /// Achsen-Startpunkt (== `WallInput::start`).
    start: Point2,
    /// Normalisierte Achsenrichtung (Start -> Ende).
    dir: Point2,
    /// Achsenlaenge (Meter).
    length: f32,
    /// Oeffnungen entlang der Achse (unveraendert aus `WallInput::openings`).
    openings: Vec<Opening>,
}

/// Schwelle fuer `|dot(u_axis, wall_dir)|`, ab der eine Wandachse als
/// "hinreichend parallel zur u-Achse" gilt (siehe Moduldoc "Oeffnungen" ->
/// Genauigkeit). Darunter wird die Oeffnungs-Durchblick-Berechnung fuer diese
/// Wand konservativ uebersprungen (Wand bleibt fuer die Verdeckung blickdicht).
const AXIS_ALIGN_EPS: f32 = 1e-3;

/// Affine Abbildung `u -> Wandachsen-Position` fuer eine Wand in einer
/// gegebenen Schnittebene: `along_wall(u) = c + d*u`. Herleitung: ein Punkt bei
/// Projektions-Parameter `u` auf der Schnittlinie liegt bei
/// `plane.plan_point() + u * plane.plan_u_axis()` (siehe `project`/`u_of` in
/// `footprint_u_intervals`); seine Position entlang der Wandachse ist das
/// Skalarprodukt aus (Punkt - Wandstart) und der (normalisierten) Wandrichtung.
/// Ausmultipliziert ergibt das die affine Form unten. `d == 0` heisst: die
/// Wandachse steht senkrecht auf der u-Achse (Wand auf Kante gesehen / reiner
/// Cut-Fall) — dort ist `along_wall` konstant ueber das ganze u-Intervall.
fn axis_map(plane: &SectionPlane, axis: &WallAxis) -> (f32, f32) {
    let p0 = plane.plan_point();
    let ua = plane.plan_u_axis();
    let c = (p0[0] - axis.start[0]) * axis.dir[0] + (p0[1] - axis.start[1]) * axis.dir[1];
    let d = ua[0] * axis.dir[0] + ua[1] * axis.dir[1];
    (c, d)
}

/// 2D-Links-Normale (90 Grad CCW) — 1:1 gespiegelt aus `mesh::left_normal`
/// (dort privat), weil hier nur die Grundriss-Bandecken gebraucht werden, nicht
/// die volle 3D-Extrusion.
fn left_normal2(start: Point2, end: Point2) -> Point2 {
    let dx = end[0] - start[0];
    let dy = end[1] - start[1];
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return [0.0, 0.0];
    }
    [-dy / len, dx / len]
}

/// Baut das Band-Grundriss-Polygon einer Wand (identische Ecken-Konstruktion
/// wie `mesh::extrude_wall`: g0..g3 CCW um die Achse).
fn wall_prism(index: usize, wall: &WallInput) -> Option<Prism> {
    let n = left_normal2(wall.start, wall.end);
    if n == [0.0, 0.0] {
        return None; // entartete Wand (Start == Ende), wie mesh::extrude_wall
    }
    let h = wall.thickness * 0.5;
    let off = |p: Point2, s: f32| -> Point2 { [p[0] + n[0] * s * h, p[1] + n[1] * s * h] };
    let footprint = vec![
        off(wall.start, 1.0),
        off(wall.end, 1.0),
        off(wall.end, -1.0),
        off(wall.start, -1.0),
    ];
    // Achsenrichtung aus der bereits berechneten Links-Normale ableiten (90 Grad
    // zurueckgedreht): n = (-dir.y, dir.x)  =>  dir = (n.y, -n.x).
    let dir = [n[1], -n[0]];
    let dx = wall.end[0] - wall.start[0];
    let dy = wall.end[1] - wall.start[1];
    let length = (dx * dx + dy * dy).sqrt();
    Some(Prism {
        kind: ComponentKind::Wall,
        index,
        footprint,
        z0: wall.base_elevation,
        z1: wall.base_elevation + wall.height,
        color: wall.color,
        wall_axis: Some(WallAxis {
            start: wall.start,
            dir,
            length,
            openings: wall.openings.clone(),
        }),
    })
}

fn slab_prism(index: usize, slab: &SlabInput) -> Option<Prism> {
    if slab.outline.len() < 3 {
        return None;
    }
    let z0 = slab.z_bottom.min(slab.z_top);
    let z1 = slab.z_bottom.max(slab.z_top);
    if (z1 - z0) < 1e-6 {
        return None;
    }
    Some(Prism {
        kind: ComponentKind::Slab,
        index,
        footprint: slab.outline.clone(),
        z0,
        z1,
        color: slab.color,
        wall_axis: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Cut-Polygone: Grundriss-Linie x Fussabdruck-Polygon -> u-Intervalle
// ─────────────────────────────────────────────────────────────────────────────

/// Findet die u-Intervalle, in denen die Schnittlinie (Grundriss-Projektion der
/// Ebene) INNERHALB von `footprint` verlaeuft. Allgemeines Polygon-Linie-
/// Clipping: Vorzeichen-Abstand jeder Kante zur Linie, Kreuzungspunkte
/// sammeln, sortieren, paarweise als Innen-Intervalle interpretieren (gerade
/// Anzahl Kreuzungen fuer ein einfaches Polygon).
fn footprint_u_intervals(plane: &SectionPlane, footprint: &[Point2]) -> Vec<(f32, f32)> {
    let n = footprint.len();
    if n < 3 {
        return Vec::new();
    }
    let pn = plane.plan_normal();
    let p0 = plane.plan_point();
    let ua = plane.plan_u_axis();
    let dist = |p: Point2| (p[0] - p0[0]) * pn[0] + (p[1] - p0[1]) * pn[1];
    let u_of = |p: Point2| (p[0] - p0[0]) * ua[0] + (p[1] - p0[1]) * ua[1];

    let eps = 1e-6;
    let mut crossings: Vec<f32> = Vec::new();
    for i in 0..n {
        let a = footprint[i];
        let b = footprint[(i + 1) % n];
        let da = dist(a);
        let db = dist(b);
        if da.abs() < eps && db.abs() < eps {
            continue; // Kante liegt auf der Linie -> bekannter Sonderfall, ignoriert
        }
        if da.abs() < eps {
            crossings.push(u_of(a));
            continue;
        }
        if (da < 0.0) != (db < 0.0) {
            let t = da / (da - db);
            let px = a[0] + t * (b[0] - a[0]);
            let py = a[1] + t * (b[1] - a[1]);
            crossings.push(u_of([px, py]));
        }
    }
    crossings.sort_by(|x, y| x.partial_cmp(y).unwrap());
    crossings.dedup_by(|x, y| (*x - *y).abs() < eps);

    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < crossings.len() {
        out.push((crossings[i], crossings[i + 1]));
        i += 2;
    }
    out
}

/// Zerlegt EIN Cut-u-Intervall `[u_lo, u_hi]` (volle Rechteck-Hoehe `[prism.z0,
/// prism.z1]`) an den Oeffnungen der Wand in mehrere Rechtecke `(u0, u1, v0,
/// v1)`. Ohne Oeffnungen (oder fuer Decken, `wall_axis == None`) liefert das
/// exakt das eine Vollrechteck von vorher (Regressionsfall). Siehe Moduldoc
/// "Oeffnungen" fuer die Herleitung von `axis_map`.
fn wall_cut_rectangles(
    plane: &SectionPlane,
    prism: &Prism,
    u_lo: f32,
    u_hi: f32,
) -> Vec<(f32, f32, f32, f32)> {
    let Some(axis) = &prism.wall_axis else {
        return vec![(u_lo, u_hi, prism.z0, prism.z1)];
    };
    if axis.openings.is_empty() {
        return vec![(u_lo, u_hi, prism.z0, prism.z1)];
    }
    let (c, d) = axis_map(plane, axis);

    // Oeffnungs-u-Teilintervalle sammeln (auf [u_lo,u_hi] geclippt), sortiert.
    let mut voids: Vec<(f32, f32, &Opening)> = Vec::new();
    for op in &axis.openings {
        let from = op.from.max(0.0);
        let to = op.to.min(axis.length);
        if to <= from {
            continue;
        }
        let (open_lo, open_hi) = if d.abs() < 1e-6 {
            // Wandachse (nahezu) senkrecht zur u-Achse: die Wandachsen-Position
            // ist ueber das gesamte Cut-Intervall praktisch konstant (reiner
            // Quer-Schnitt, wie in der Moduldoc beschrieben) -> ganz drin oder
            // ganz draussen.
            if c >= from - EPS && c <= to + EPS {
                (u_lo, u_hi)
            } else {
                continue;
            }
        } else {
            let t0 = (from - c) / d;
            let t1 = (to - c) / d;
            (t0.min(t1), t0.max(t1))
        };
        let lo = open_lo.max(u_lo);
        let hi = open_hi.min(u_hi);
        if hi - lo > MIN_SPAN {
            voids.push((lo, hi, op));
        }
    }
    if voids.is_empty() {
        return vec![(u_lo, u_hi, prism.z0, prism.z1)];
    }
    // Bruestungs-/Sturz-Zerlegung ist ab hier koordinatenraum-neutral (nur noch
    // u-Intervall + Hoehe + geclippte Voids) -> gemeinsame Basis mit
    // `mesh::wall_solid_segments` (siehe `crate::openings`-Moduldoc), damit
    // Cut-Ansicht und 3D-Solid-Mesh garantiert dasselbe Oeffnungsmodell nutzen.
    crate::openings::split_range_by_voids(u_lo, u_hi, prism.z0, prism.z1, voids)
}

// ─────────────────────────────────────────────────────────────────────────────
// Projektions-Kanten + Verdeckung
// ─────────────────────────────────────────────────────────────────────────────

/// Achsparallele Bounding-Box eines Prismas in (u, Tiefe, Hoehe) — genutzt als
/// Verdeckungs-Naeherung (siehe Moduldoc "Bekannte Vereinfachungen"). `kind`/
/// `index` erlauben es, das Bauteil bei der Verdeckungspruefung gezielt
/// auszuschliessen (fuer die eigenen Oeffnungs-Rahmenkanten, siehe Moduldoc
/// "Oeffnungen"). `opening_voids` sind (u0,u1,v0,v1)-Rechtecke, in denen diese
/// Bounding-Box NICHT verdeckt (Oeffnungs-"Loch", siehe `axis_map`/Moduldoc).
struct PrismBounds {
    kind: ComponentKind,
    index: usize,
    u_min: f32,
    u_max: f32,
    depth_min: f32,
    z0: f32,
    z1: f32,
    opening_voids: Vec<(f32, f32, f32, f32)>,
}

fn prism_bounds(plane: &SectionPlane, prism: &Prism) -> PrismBounds {
    let mut u_min = f32::INFINITY;
    let mut u_max = f32::NEG_INFINITY;
    let mut depth_min = f32::INFINITY;
    for &p in &prism.footprint {
        let w = to_world(p, 0.0); // u/Tiefe sind hoehenunabhaengig (vertikale Ebene)
        let u = plane.project(w)[0];
        let d = plane.depth(w);
        u_min = u_min.min(u);
        u_max = u_max.max(u);
        depth_min = depth_min.min(d);
    }

    let mut opening_voids = Vec::new();
    if let Some(axis) = &prism.wall_axis {
        if !axis.openings.is_empty() {
            let (c, d) = axis_map(plane, axis);
            // Nur bei hinreichend u-paralleler Wandachse: siehe Moduldoc
            // "Oeffnungen" -> Genauigkeit. Sonst bleibt die Wand blickdicht.
            if d.abs() >= AXIS_ALIGN_EPS {
                for op in &axis.openings {
                    let from = op.from.max(0.0);
                    let to = op.to.min(axis.length);
                    if to <= from {
                        continue;
                    }
                    let ua = (from - c) / d;
                    let ub = (to - c) / d;
                    let (open_u0, open_u1) = (ua.min(ub), ua.max(ub));
                    let sill_abs = prism.z0 + op.sill.max(0.0);
                    let head_abs = (sill_abs + op.height).min(prism.z1);
                    if head_abs > sill_abs + MIN_SPAN {
                        opening_voids.push((open_u0, open_u1, sill_abs, head_abs));
                    }
                }
            }
        }
    }

    PrismBounds {
        kind: prism.kind,
        index: prism.index,
        u_min,
        u_max,
        depth_min,
        z0: prism.z0,
        z1: prism.z1,
        opening_voids,
    }
}

/// Rolle einer Kante bzgl. der Hoehen-Randbehandlung beim Verdeckungstest.
/// Boden-/Deckelkanten liegen KONSTANT auf der eigenen Unter-/Oberkante ihres
/// Prismas (`z0`/`z1`) — bei einer rein geschlossenen (beidseitig inklusiven)
/// Bereichspruefung wuerde ein bloss VERTIKAL angrenzendes (aber nicht wirklich
/// ueberlappendes) Fremd-Prisma faelschlich als Verdecker zaehlen, sobald sich
/// zwei Bauteile exakt an einer Flaeche beruehren (z. B. eine Wand, die exakt
/// auf einer Bodenplatte steht: Wand-`z0` == Platte-`z1`). Boden-/Deckelkanten
/// bekommen daher eine ASYMMETRISCHE (halboffene) Grenzbehandlung, passend zur
/// Richtung, in die das EIGENE Prisma von dieser Kante aus "waechst": eine
/// Bodenkante (Prisma waechst nach oben) zaehlt ein Fremd-Prisma nur, wenn
/// dessen Material an/oberhalb seiner eigenen Unterkante beginnt UND diese
/// Hoehe noch UNTERHALB seiner Oberkante liegt (`[lo, hi)`); eine Deckelkante
/// (Prisma waechst nach unten) symmetrisch mit `(lo, hi]`. Vertikale Eckkanten
/// (Hoehe variiert ueber die volle Prisma-Hoehe) brauchen das nicht: dort
/// ergibt eine reine Beruehrung ohnehin ein Intervall der Laenge 0, das ueber
/// `MIN_SPAN` herausfaellt (siehe `merge_intervals`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeightBias {
    /// Vertikale Eckkante: Hoehe variiert, geschlossenes Clipping.
    Vertical,
    /// Bodenkante (konstant auf `z0` des eigenen Prismas).
    BottomCap,
    /// Deckelkante (konstant auf `z1` des eigenen Prismas).
    TopCap,
}

/// t-Bereich (Teilmenge von [0,1]), in dem `v0 + t*(v1-v0)` in `[lo, hi]`
/// liegt. `bias` steuert die Randbehandlung fuer den KONSTANTEN Fall (siehe
/// `HeightBias`); der variierende Fall (vertikale Kante) ist davon unberuehrt.
fn height_in_range(v0: f32, v1: f32, lo: f32, hi: f32, bias: HeightBias) -> Option<(f32, f32)> {
    const TOUCH: f32 = 1e-5;
    if (v1 - v0).abs() < 1e-9 {
        let inside = match bias {
            HeightBias::Vertical => v0 >= lo - EPS && v0 <= hi + EPS,
            HeightBias::BottomCap => v0 >= lo - TOUCH && v0 <= hi - TOUCH,
            HeightBias::TopCap => v0 >= lo + TOUCH && v0 <= hi + TOUCH,
        };
        return if inside { Some((0.0, 1.0)) } else { None };
    }
    let ta = (lo - v0) / (v1 - v0);
    let tb = (hi - v0) / (v1 - v0);
    let t0 = ta.min(tb).max(0.0);
    let t1 = ta.max(tb).min(1.0);
    if t0 <= t1 + EPS {
        Some((t0.max(0.0), t1.min(1.0)))
    } else {
        None
    }
}

/// t-Bereich, in dem `v0 + t*(v1-v0)` STRENG groesser als `min_val` ist (fuer
/// den Tiefenvergleich "naeher als der Blocker").
fn linear_greater_than(v0: f32, v1: f32, min_val: f32) -> Option<(f32, f32)> {
    if (v1 - v0).abs() < 1e-9 {
        return if v0 > min_val { Some((0.0, 1.0)) } else { None };
    }
    let slope = v1 - v0;
    let t_cross = (min_val - v0) / slope;
    let (t0, t1) = if slope > 0.0 {
        (t_cross, f32::INFINITY)
    } else {
        (f32::NEG_INFINITY, t_cross)
    };
    let t0c = t0.max(0.0);
    let t1c = t1.min(1.0);
    if t0c <= t1c + EPS {
        Some((t0c.max(0.0), t1c.min(1.0)))
    } else {
        None
    }
}

fn intersect_ranges(a: Option<(f32, f32)>, b: Option<(f32, f32)>) -> Option<(f32, f32)> {
    let (a0, a1) = a?;
    let (b0, b1) = b?;
    let lo = a0.max(b0);
    let hi = a1.min(b1);
    if lo <= hi + EPS {
        Some((lo.max(0.0), hi.min(1.0)))
    } else {
        None
    }
}

/// Vereinigt (moeglicherweise ueberlappende) t-Intervalle zu einer sortierten,
/// disjunkten Liste.
fn merge_intervals(mut ivs: Vec<(f32, f32)>) -> Vec<(f32, f32)> {
    ivs.retain(|(s, e)| *e - *s > MIN_SPAN);
    ivs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut out: Vec<(f32, f32)> = Vec::new();
    for (s, e) in ivs {
        if let Some(last) = out.last_mut() {
            if s <= last.1 + MIN_SPAN {
                last.1 = last.1.max(e);
                continue;
            }
        }
        out.push((s, e));
    }
    out
}

/// Entfernt `cut` aus jedem Intervall in `pieces` (kann ein Intervall in ZWEI
/// Stuecke spalten, wenn `cut` es mittig trifft). Genutzt, um ein Oeffnungs-
/// "Loch" (`PrismBounds::opening_voids`) aus einem sonst blockierten
/// t-Teilstueck herauszuschneiden (siehe Moduldoc "Oeffnungen").
fn subtract_range(pieces: Vec<(f32, f32)>, cut: (f32, f32)) -> Vec<(f32, f32)> {
    let (cs, ce) = cut;
    let mut out = Vec::with_capacity(pieces.len());
    for (s, e) in pieces {
        if ce <= s + MIN_SPAN || cs >= e - MIN_SPAN {
            out.push((s, e)); // keine nennenswerte Ueberlappung
            continue;
        }
        if cs > s + MIN_SPAN {
            out.push((s, cs));
        }
        if ce < e - MIN_SPAN {
            out.push((ce, e));
        }
    }
    out
}

/// Komplement der (sortierten, disjunkten) Intervalle `blocked` in [0, 1].
fn subtract_from_unit(blocked: &[(f32, f32)]) -> Vec<(f32, f32)> {
    let mut visible = Vec::new();
    let mut cursor = 0.0f32;
    for &(s, e) in blocked {
        if s > cursor + MIN_SPAN {
            visible.push((cursor, s));
        }
        cursor = cursor.max(e);
    }
    if cursor < 1.0 - MIN_SPAN {
        visible.push((cursor, 1.0));
    }
    visible
}

/// Fuer eine projizierte Kante (u0,v0)->(u1,v1) bei Tiefen (d0,d1): die
/// Teilbereiche (t in [0,1]), die durch `bounds` verdeckt werden (Vereinigung
/// ueber alle Blocker). `exclude` (falls gesetzt) nimmt EIN Bauteil von der
/// Verdeckungspruefung aus — fuer die eigenen Oeffnungs-Rahmenkanten eines
/// Bauteils, die sich nicht selbst verdecken koennen (siehe Moduldoc
/// "Oeffnungen"). Jeder Blocker mit `opening_voids` (Fenster/Tueren) gibt an
/// diesen Stellen NICHTS zur Verdeckung bei ("Durchblick").
#[allow(clippy::too_many_arguments)]
fn blocked_intervals(
    u0: f32,
    u1: f32,
    v0: f32,
    v1: f32,
    d0: f32,
    d1: f32,
    bias: HeightBias,
    bounds: &[PrismBounds],
    exclude: Option<ComponentRef>,
) -> Vec<(f32, f32)> {
    let mut ivs = Vec::new();
    for b in bounds {
        if let Some(ex) = exclude {
            if ex.kind == b.kind && ex.index == b.index {
                continue;
            }
        }
        let ru = height_in_range(u0, u1, b.u_min, b.u_max, HeightBias::Vertical);
        let rv = height_in_range(v0, v1, b.z0, b.z1, bias);
        let rd = linear_greater_than(d0, d1, b.depth_min + EPS);
        let Some(solid) = intersect_ranges(intersect_ranges(ru, rv), rd) else {
            continue;
        };
        let mut pieces = vec![solid];
        for &(vu0, vu1, vz0, vz1) in &b.opening_voids {
            let vru = height_in_range(u0, u1, vu0, vu1, HeightBias::Vertical);
            let vrv = height_in_range(v0, v1, vz0, vz1, HeightBias::Vertical);
            if let Some(void_range) = intersect_ranges(vru, vrv) {
                pieces = subtract_range(pieces, void_range);
            }
        }
        ivs.extend(pieces);
    }
    merge_intervals(ivs)
}

fn lerp_uv(u0: f32, v0: f32, u1: f32, v1: f32, t: f32) -> [f32; 2] {
    [u0 + t * (u1 - u0), v0 + t * (v1 - v0)]
}

/// Baut die Draht-Kanten EINES Prismas: n vertikale Eckkanten + n Boden- + n
/// Deckelkanten (n = Anzahl Fussabdruck-Ecken), je als Weltpunkt-Paar + ihre
/// `HeightBias` (siehe dort) fuer den Verdeckungstest.
fn prism_wireframe_edges(prism: &Prism) -> Vec<([f32; 3], [f32; 3], HeightBias)> {
    let n = prism.footprint.len();
    let mut edges = Vec::with_capacity(3 * n);
    for i in 0..n {
        edges.push((
            to_world(prism.footprint[i], prism.z0),
            to_world(prism.footprint[i], prism.z1),
            HeightBias::Vertical,
        ));
    }
    for i in 0..n {
        let a = prism.footprint[i];
        let b = prism.footprint[(i + 1) % n];
        edges.push((to_world(a, prism.z0), to_world(b, prism.z0), HeightBias::BottomCap));
        edges.push((to_world(a, prism.z1), to_world(b, prism.z1), HeightBias::TopCap));
    }
    edges
}

/// Baut die vier Rahmenkanten JEDER Oeffnung einer Wand (zwei Leibungen, Sturz,
/// Bruestung) als Weltpunkt-Paare — analog zu `prism_wireframe_edges`, aber
/// fuer die Loch-Geometrie statt die Aussenhuelle. Die horizontale Position
/// nutzt die Wandachsen-Mittellinie (siehe Moduldoc "Oeffnungen": dieselbe
/// Vereinfachung wie die Bounding-Box-Verdeckung — keine eigene Dicken-
/// Aufloesung der Leibungsflaeche). `HeightBias::Vertical` fuer alle vier
/// Kanten: weder Leibungen (echte Hoehenvariation) noch Sturz/Bruestung
/// (konstante Hoehe, aber keine Prisma-Deckel-/Bodenkante) brauchen die
/// asymmetrische Cap-Randbehandlung (siehe `HeightBias`-Doku).
fn opening_wire_edges(prism: &Prism) -> Vec<([f32; 3], [f32; 3], HeightBias)> {
    let Some(axis) = &prism.wall_axis else {
        return Vec::new();
    };
    let mut edges = Vec::new();
    for op in &axis.openings {
        let from = op.from.max(0.0);
        let to = op.to.min(axis.length);
        if to <= from {
            continue;
        }
        let sill_abs = prism.z0 + op.sill.max(0.0);
        let head_abs = (sill_abs + op.height).min(prism.z1);
        if head_abs <= sill_abs + MIN_SPAN {
            continue;
        }
        let at = |t: f32| -> Point2 { [axis.start[0] + t * axis.dir[0], axis.start[1] + t * axis.dir[1]] };
        let p_from = at(from);
        let p_to = at(to);
        let jamb_from = (to_world(p_from, sill_abs), to_world(p_from, head_abs));
        let jamb_to = (to_world(p_to, sill_abs), to_world(p_to, head_abs));
        let sill_edge = (to_world(p_from, sill_abs), to_world(p_to, sill_abs));
        let head_edge = (to_world(p_from, head_abs), to_world(p_to, head_abs));
        edges.push((jamb_from.0, jamb_from.1, HeightBias::Vertical));
        edges.push((jamb_to.0, jamb_to.1, HeightBias::Vertical));
        edges.push((sill_edge.0, sill_edge.1, HeightBias::Vertical));
        edges.push((head_edge.0, head_edge.1, HeightBias::Vertical));
    }
    edges
}

fn compute_view_edges(
    plane: &SectionPlane,
    prisms: &[Prism],
) -> (Vec<SectionEdge>, Vec<SectionEdge>) {
    let bounds: Vec<PrismBounds> = prisms.iter().map(|p| prism_bounds(plane, p)).collect();
    let mut visible = Vec::new();
    let mut hidden = Vec::new();

    for prism in prisms {
        let cref = ComponentRef {
            kind: prism.kind,
            index: prism.index,
        };
        // Box-Silhouette (Selbstverdeckung gewollt, siehe Moduldoc) + eigene
        // Oeffnungs-Rahmenkanten (NICHT gegen das eigene Bauteil verdeckt).
        let mut all_edges: Vec<(([f32; 3], [f32; 3], HeightBias), bool)> = prism_wireframe_edges(prism)
            .into_iter()
            .map(|e| (e, false))
            .collect();
        all_edges.extend(opening_wire_edges(prism).into_iter().map(|e| (e, true)));

        for ((pa, pb, bias), self_exclude) in all_edges {
            let da = plane.depth(pa);
            let db = plane.depth(pb);
            if da <= EPS && db <= EPS {
                continue; // komplett vor/auf der Ebene -> nicht im Blickfeld dahinter
            }
            // Auf den Anteil HINTER der Ebene clippen, falls eine Seite davor liegt.
            let (ca, cb) = if da > EPS && db > EPS {
                (pa, pb)
            } else {
                let t = (EPS - da) / (db - da);
                let clip = |p0: [f32; 3], p1: [f32; 3]| -> [f32; 3] {
                    [
                        p0[0] + t * (p1[0] - p0[0]),
                        p0[1] + t * (p1[1] - p0[1]),
                        p0[2] + t * (p1[2] - p0[2]),
                    ]
                };
                if da <= EPS {
                    (clip(pa, pb), pb)
                } else {
                    (pa, clip(pa, pb))
                }
            };

            let [u0, v0] = plane.project(ca);
            let [u1, v1] = plane.project(cb);
            if (u0 - u1).abs() < 1e-5 && (v0 - v1).abs() < 1e-5 {
                continue; // kantenparallel zur Blickrichtung -> entartet (Punkt)
            }
            let d0 = plane.depth(ca);
            let d1 = plane.depth(cb);

            let exclude = if self_exclude { Some(cref) } else { None };
            let blocked = blocked_intervals(u0, u1, v0, v1, d0, d1, bias, &bounds, exclude);
            for &(s, e) in &blocked {
                hidden.push(SectionEdge {
                    component: cref,
                    a: lerp_uv(u0, v0, u1, v1, s),
                    b: lerp_uv(u0, v0, u1, v1, e),
                });
            }
            for (s, e) in subtract_from_unit(&blocked) {
                visible.push(SectionEdge {
                    component: cref,
                    a: lerp_uv(u0, v0, u1, v1, s),
                    b: lerp_uv(u0, v0, u1, v1, e),
                });
            }
        }
    }
    (visible, hidden)
}

// ─────────────────────────────────────────────────────────────────────────────
// Oeffentliche Einstiegsfunktion
// ─────────────────────────────────────────────────────────────────────────────

/// Fuehrt einen Schnitt/eine Ansicht entlang `plane` gegen das Modell (Waende +
/// Decken) aus. Siehe Moduldoc fuer Format/Konventionen.
pub fn cut_section(plane: &SectionPlane, walls: &[WallInput], slabs: &[SlabInput]) -> SectionOutput {
    let mut prisms: Vec<Prism> = Vec::new();
    for (i, w) in walls.iter().enumerate() {
        if let Some(p) = wall_prism(i, w) {
            prisms.push(p);
        }
    }
    for (i, s) in slabs.iter().enumerate() {
        if let Some(p) = slab_prism(i, s) {
            prisms.push(p);
        }
    }

    let mut cut_polygons = Vec::new();
    for prism in &prisms {
        for (u0, u1) in footprint_u_intervals(plane, &prism.footprint) {
            let (lo, hi) = (u0.min(u1), u0.max(u1));
            for (rlo, rhi, rz0, rz1) in wall_cut_rectangles(plane, prism, lo, hi) {
                cut_polygons.push(CutPolygon {
                    component: ComponentRef {
                        kind: prism.kind,
                        index: prism.index,
                    },
                    color: prism.color,
                    pts: vec![[rlo, rz0], [rhi, rz0], [rhi, rz1], [rlo, rz1]],
                });
            }
        }
    }

    let (visible_edges, hidden_edges) = compute_view_edges(plane, &prisms);

    SectionOutput {
        cut_polygons,
        visible_edges,
        hidden_edges,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// L-foermige Wand (zwei Schenkel im rechten Winkel) + Bodenplatte, wie im
    /// OCCT-HLR-Spike (`docs/welle-c-hlr-spike/FEASIBILITY.md`) beschrieben.
    ///
    /// Schenkel A: Achse (0,0)->(0,3) (Grundriss-Y-Richtung), Dicke 0.2, Hoehe
    /// 2.5. Schenkel B: Achse (0,3)->(3,3) (Grundriss-X-Richtung), rechter
    /// Winkel bei (0,3), gleiche Dicke/Hoehe. Bodenplatte: Rechteck, die den
    /// gesamten L-Grundriss ueberdeckt, z in [-0.2, 0] (unterhalb der Waende).
    fn l_wall_scene() -> (Vec<WallInput>, Vec<SlabInput>) {
        let color = [0.8, 0.8, 0.8];
        let walls = vec![
            WallInput {
                start: [0.0, 0.0],
                end: [0.0, 3.0],
                thickness: 0.2,
                height: 2.5,
                base_elevation: 0.0,
                color,
                openings: vec![],
                layers: None,
            },
            WallInput {
                start: [0.0, 3.0],
                end: [3.0, 3.0],
                thickness: 0.2,
                height: 2.5,
                base_elevation: 0.0,
                color,
                openings: vec![],
                layers: None,
            },
        ];
        let slabs = vec![SlabInput {
            outline: vec![[-0.5, -0.5], [3.5, -0.5], [3.5, 3.5], [-0.5, 3.5]],
            z_bottom: -0.2,
            z_top: 0.0,
            color: [0.86, 0.86, 0.88],
        }];
        (walls, slabs)
    }

    // --- Konstruktoren -------------------------------------------------------

    #[test]
    fn standardkonstruktoren_setzen_blickrichtung_korrekt() {
        let px = SectionPlane::looking_plus_x(2.0);
        assert_eq!(px.point, [2.0, 0.0, 0.0]);
        assert_eq!(px.normal, [1.0, 0.0, 0.0]);

        let mx = SectionPlane::looking_minus_x(2.0);
        assert_eq!(mx.normal, [-1.0, 0.0, 0.0]);

        let py = SectionPlane::looking_plus_y(4.0);
        assert_eq!(py.point, [0.0, 0.0, 4.0]);
        assert_eq!(py.normal, [0.0, 0.0, 1.0]);

        let my = SectionPlane::looking_minus_y(4.0);
        assert_eq!(my.normal, [0.0, 0.0, -1.0]);
    }

    #[test]
    fn u_achse_steht_senkrecht_auf_blickrichtung_und_ist_horizontal() {
        let plane = SectionPlane::looking_plus_x(0.0);
        let u = plane.u_axis();
        assert!((u[1]).abs() < 1e-6, "u-Achse ist horizontal (keine Y-Komponente)");
        assert!(
            math::dot(u, plane.normal).abs() < 1e-6,
            "u-Achse orthogonal zur Blickrichtung"
        );
        // Fuer looking_plus_x ist u = Modell-Y (world +Z).
        assert!((u[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn project_und_depth_generischer_konstruktor() {
        let plane = SectionPlane::new([1.0, 0.0, 0.0], [2.0, 0.0, 0.0]); // unnormalisiert
        assert!((math::length(plane.normal) - 1.0).abs() < 1e-6, "Normale wird normalisiert");
        let d = plane.depth([3.0, 1.0, 5.0]);
        assert!((d - 2.0).abs() < 1e-5, "Tiefe entlang normalisierter Normale");
        let uv = plane.project([1.0, 1.5, 7.0]);
        assert!((uv[1] - 1.5).abs() < 1e-6, "v = world.y");
    }

    // --- Fall (a): Schnitt mittig durch einen Wandschenkel --------------------

    #[test]
    fn schnitt_durch_wandschenkel_b_liefert_zwei_rechtecke() {
        let (walls, slabs) = l_wall_scene();
        // Schnittebene bei Grundriss-X = 1.5: liegt in der Mitte von Schenkel B
        // (Achse x in [0,3]), aber ausserhalb von Schenkel A (Band x in
        // [-0.1,0.1]) und schneidet die volle Bodenplatte (x in [-0.5,3.5]).
        let plane = SectionPlane::looking_plus_x(1.5);
        let out = cut_section(&plane, &walls, &slabs);

        assert_eq!(
            out.cut_polygons.len(),
            2,
            "Schenkel A wird NICHT getroffen, nur Schenkel B + Bodenplatte"
        );

        let wall_cut = out
            .cut_polygons
            .iter()
            .find(|c| c.component.kind == ComponentKind::Wall)
            .expect("ein Wand-Cut-Polygon");
        assert_eq!(wall_cut.component.index, 1, "Schenkel B ist Index 1");
        let us: Vec<f32> = wall_cut.pts.iter().map(|p| p[0]).collect();
        let vs: Vec<f32> = wall_cut.pts.iter().map(|p| p[1]).collect();
        let (u_lo, u_hi) = (us.iter().cloned().fold(f32::INFINITY, f32::min), us.iter().cloned().fold(f32::NEG_INFINITY, f32::max));
        let (v_lo, v_hi) = (vs.iter().cloned().fold(f32::INFINITY, f32::min), vs.iter().cloned().fold(f32::NEG_INFINITY, f32::max));
        assert!((u_lo - 2.9).abs() < 1e-4, "u_lo={u_lo}");
        assert!((u_hi - 3.1).abs() < 1e-4, "u_hi={u_hi}");
        assert!((v_lo - 0.0).abs() < 1e-4, "v_lo={v_lo}");
        assert!((v_hi - 2.5).abs() < 1e-4, "v_hi={v_hi}");

        let slab_cut = out
            .cut_polygons
            .iter()
            .find(|c| c.component.kind == ComponentKind::Slab)
            .expect("ein Slab-Cut-Polygon");
        let us: Vec<f32> = slab_cut.pts.iter().map(|p| p[0]).collect();
        let vs: Vec<f32> = slab_cut.pts.iter().map(|p| p[1]).collect();
        let (u_lo, u_hi) = (us.iter().cloned().fold(f32::INFINITY, f32::min), us.iter().cloned().fold(f32::NEG_INFINITY, f32::max));
        let (v_lo, v_hi) = (vs.iter().cloned().fold(f32::INFINITY, f32::min), vs.iter().cloned().fold(f32::NEG_INFINITY, f32::max));
        assert!((u_lo + 0.5).abs() < 1e-4, "u_lo={u_lo}");
        assert!((u_hi - 3.5).abs() < 1e-4, "u_hi={u_hi}");
        assert!((v_lo + 0.2).abs() < 1e-4, "v_lo={v_lo}");
        assert!((v_hi - 0.0).abs() < 1e-4, "v_hi={v_hi}");
    }

    #[test]
    fn schnitt_ausserhalb_des_modells_liefert_keine_cut_polygone() {
        let (walls, slabs) = l_wall_scene();
        // x = 10 liegt weit ausserhalb aller Fussabdruecke.
        let plane = SectionPlane::looking_plus_x(10.0);
        let out = cut_section(&plane, &walls, &slabs);
        assert!(out.cut_polygons.is_empty());
    }

    // --- Fall (b): Ansicht/Projektion, Ebene VOR dem Modell -------------------

    #[test]
    fn ansicht_vor_dem_modell_hat_keine_cut_polygone_aber_verdeckung() {
        let (walls, slabs) = l_wall_scene();
        // Ebene bei x = -2, Blick nach +X: das gesamte Modell liegt dahinter
        // (kleinste Fussabdruck-X ist -0.5 bei der Bodenplatte).
        let plane = SectionPlane::looking_plus_x(-2.0);
        let out = cut_section(&plane, &walls, &slabs);

        assert!(
            out.cut_polygons.is_empty(),
            "Ebene liegt ausserhalb aller Fussabdruecke -> keine Cut-Polygone"
        );

        // Erwartete Gesamtzahlen (siehe Kommentar/Herleitung im Modul-Review):
        //  Schenkel A (senkrecht zur Blickrichtung, wie eine Wand-Elevation):
        //    4 sichtbare (Vorderseite) + 4 verdeckte (Rueckseite, Selbstverdeckung).
        //  Schenkel B (parallel zur Blickrichtung, inkl. Eck-Ueberlappung mit A):
        //    3 sichtbare + 7 verdeckte (12 Kanten - 4 entartete Laengskanten = 8
        //    Basiskanten, davon 2 an der Eckueberlappung in je 2 Teilstuecke
        //    gesplittet -> 10 Segmente gesamt).
        //  Bodenplatte (keine Hoehen-Ueberlappung mit den Waenden -> nur
        //    Selbstverdeckung wie Schenkel A): 4 sichtbar + 4 verdeckt.
        assert_eq!(
            out.visible_edges.len(),
            11,
            "4 (Schenkel A) + 3 (Schenkel B) + 4 (Bodenplatte)"
        );
        assert_eq!(
            out.hidden_edges.len(),
            15,
            "4 (Schenkel A) + 7 (Schenkel B) + 4 (Bodenplatte)"
        );

        // Konkrete Kante: die "eingebettete" Eckkante von Schenkel B (Index 1)
        // bei u=2.9 (naeher an Schenkel A, siehe Moduldoc "Bekannte
        // Vereinfachungen" -> Eckueberlappung ohne Wandknoten-Verschneidung)
        // muss VOLLSTAENDIG verdeckt sein.
        let embedded_corner_hidden = out.hidden_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[0] - 2.9).abs() < 1e-3
                && (e.b[0] - 2.9).abs() < 1e-3
                && (e.a[1].min(e.b[1]) - 0.0).abs() < 1e-3
                && (e.a[1].max(e.b[1]) - 2.5).abs() < 1e-3
        });
        assert!(embedded_corner_hidden, "Eckkante von Schenkel B bei u=2.9 muss hidden sein");

        // Die AEUSSERE Eckkante von Schenkel B (u=3.1, ragt ueber Schenkel A
        // hinaus) bleibt dagegen sichtbar.
        let outer_corner_visible = out.visible_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[0] - 3.1).abs() < 1e-3
                && (e.b[0] - 3.1).abs() < 1e-3
        });
        assert!(outer_corner_visible, "Aeussere Eckkante von Schenkel B (u=3.1) bleibt sichtbar");

        // Die partiell gesplittete Bodenkante (u: 2.9 -> 3.1 bei v=0) zerfaellt
        // in einen sichtbaren Anteil ab u=3.0.
        let split_visible_present = out.visible_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[1].abs() < 1e-3 && e.b[1].abs() < 1e-3)
                && ((e.a[0] - 3.0).abs() < 1e-3 || (e.b[0] - 3.0).abs() < 1e-3)
        });
        assert!(split_visible_present, "Sichtbarer Teil der gesplitteten Bodenkante ab u=3.0 fehlt");
    }

    #[test]
    fn schenkel_a_hat_vier_sichtbare_und_vier_verdeckte_kanten_isoliert() {
        // Nur Schenkel A + Bodenplatte (ohne Schenkel B), um die reine
        // Box-Selbstverdeckung ohne Eck-Ueberlappung zu pruefen.
        let (walls, _) = l_wall_scene();
        let wall_a = vec![walls[0].clone()];
        let plane = SectionPlane::looking_plus_x(-2.0);
        let out = cut_section(&plane, &wall_a, &[]);
        assert_eq!(out.visible_edges.len(), 4, "Vorderseite: 2 vertikale + Boden + Deckel");
        assert_eq!(out.hidden_edges.len(), 4, "Rueckseite: 2 vertikale + Boden + Deckel");
        // Alle sichtbaren Kanten liegen bei der naeheren Tiefe (kleinerer
        // world-x als die verdeckten).
        for e in &out.visible_edges {
            assert!(e.a[1] >= -1e-4 && e.a[1] <= 2.5 + 1e-4);
        }
    }

    // --- Oeffnungen (Tueren/Fenster) -----------------------------------------

    /// Eine Wand entlang +X (Achse (0,0)->(4,0)) mit einem Fenster: Intervall
    /// entlang der Achse [1.5, 2.5] (1 m breit), Bruestung 1.0 m, Fensterhoehe
    /// 1.0 m (Sturz beginnt also bei 2.0, Wand-Oberkante bei 2.5 -> 0.5 m Sturz).
    fn wall_with_window() -> WallInput {
        WallInput {
            start: [0.0, 0.0],
            end: [4.0, 0.0],
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![Opening {
                from: 1.5,
                to: 2.5,
                sill: 1.0,
                height: 1.0,
            }],
            layers: None,
        }
    }

    #[test]
    fn schnitt_durch_fenster_liefert_bruestung_und_sturz() {
        // Schnittebene bei Grundriss-X = 2.0: liegt MITTEN im Fenster (1.5..2.5).
        // Statt eines Vollrechtecks (0..2.5) muessen zwei Teil-Rechtecke
        // entstehen: Bruestung (0..1.0) und Sturz (2.0..2.5).
        let wall = wall_with_window();
        let plane = SectionPlane::looking_plus_x(2.0);
        let out = cut_section(&plane, &[wall], &[]);

        assert_eq!(out.cut_polygons.len(), 2, "Bruestung + Sturz statt Vollrechteck");

        let bounds_of = |c: &CutPolygon| -> (f32, f32, f32, f32) {
            let us: Vec<f32> = c.pts.iter().map(|p| p[0]).collect();
            let vs: Vec<f32> = c.pts.iter().map(|p| p[1]).collect();
            (
                us.iter().cloned().fold(f32::INFINITY, f32::min),
                us.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
                vs.iter().cloned().fold(f32::INFINITY, f32::min),
                vs.iter().cloned().fold(f32::NEG_INFINITY, f32::max),
            )
        };

        let bruestung = out
            .cut_polygons
            .iter()
            .find(|c| bounds_of(c).2.abs() < 1e-3)
            .expect("Bruestungs-Rechteck (v ab 0)");
        let (u_lo, u_hi, v_lo, v_hi) = bounds_of(bruestung);
        assert!((u_lo + 0.1).abs() < 1e-4, "u_lo={u_lo}");
        assert!((u_hi - 0.1).abs() < 1e-4, "u_hi={u_hi}");
        assert!((v_lo - 0.0).abs() < 1e-4, "v_lo={v_lo}");
        assert!((v_hi - 1.0).abs() < 1e-4, "v_hi={v_hi} (Bruestungshoehe)");

        let sturz = out
            .cut_polygons
            .iter()
            .find(|c| (bounds_of(c).3 - 2.5).abs() < 1e-3)
            .expect("Sturz-Rechteck (v bis 2.5, Wand-Oberkante)");
        let (u_lo, u_hi, v_lo, v_hi) = bounds_of(sturz);
        assert!((u_lo + 0.1).abs() < 1e-4, "u_lo={u_lo}");
        assert!((u_hi - 0.1).abs() < 1e-4, "u_hi={u_hi}");
        assert!((v_lo - 2.0).abs() < 1e-4, "v_lo={v_lo} (Sturz beginnt bei sill+height=2.0)");
        assert!((v_hi - 2.5).abs() < 1e-4, "v_hi={v_hi}");
    }

    #[test]
    fn schnitt_neben_dem_fenster_liefert_volles_rechteck() {
        // Schnittebene bei Grundriss-X = 0.5: liegt ausserhalb des Fensters
        // (1.5..2.5) -> Regressionsfall, unveraendert ein Vollrechteck.
        let wall = wall_with_window();
        let plane = SectionPlane::looking_plus_x(0.5);
        let out = cut_section(&plane, &[wall], &[]);

        assert_eq!(out.cut_polygons.len(), 1, "kein Fenster an dieser Stelle -> ein Vollrechteck");
        let c = &out.cut_polygons[0];
        let us: Vec<f32> = c.pts.iter().map(|p| p[0]).collect();
        let vs: Vec<f32> = c.pts.iter().map(|p| p[1]).collect();
        let (u_lo, u_hi) = (us.iter().cloned().fold(f32::INFINITY, f32::min), us.iter().cloned().fold(f32::NEG_INFINITY, f32::max));
        let (v_lo, v_hi) = (vs.iter().cloned().fold(f32::INFINITY, f32::min), vs.iter().cloned().fold(f32::NEG_INFINITY, f32::max));
        assert!((u_lo + 0.1).abs() < 1e-4, "u_lo={u_lo}");
        assert!((u_hi - 0.1).abs() < 1e-4, "u_hi={u_hi}");
        assert!((v_lo - 0.0).abs() < 1e-4, "v_lo={v_lo}");
        assert!((v_hi - 2.5).abs() < 1e-4, "v_hi={v_hi} (volle Wandhoehe)");
    }

    #[test]
    fn ansicht_zeigt_fensterrahmen_sichtbar_und_durchblick_bei_dahinterliegender_kante() {
        // Wand mit Fenster (Index 0) + eine zweite Wand DAHINTER (Index 1,
        // ohne Oeffnung), die teils hinter dem Fenster, teils hinter der
        // geschlossenen Wandflaeche steht. Ansicht von vorne (Blick +Y, Wand-
        // achse (0,0)->(4,0) steht dabei u-parallel -> Elevations-Fall, siehe
        // Moduldoc "Oeffnungen").
        let w0 = wall_with_window();
        let w1 = WallInput {
            start: [2.0, 1.0],
            end: [4.0, 1.0],
            thickness: 0.2,
            height: 2.5,
            base_elevation: 0.0,
            color: [0.8, 0.8, 0.8],
            openings: vec![],
            layers: None,
        };
        // Blick von y = -2 nach +Y: beide Waende (y=0 bzw. y=1) liegen dahinter.
        let plane = SectionPlane::looking_plus_y(-2.0);
        let out = cut_section(&plane, &[w0, w1], &[]);

        // -- Fensterrahmen (Wand 0) ist vollstaendig sichtbar (nichts davor). --
        // Leibungen bei u=-1.5 und u=-2.5 (Fenster-Enden), v von 1.0 (Bruestung)
        // bis 2.0 (Sturzunterkante).
        let jamb_visible = |u: f32| {
            out.visible_edges.iter().any(|e| {
                e.component.kind == ComponentKind::Wall
                    && e.component.index == 0
                    && (e.a[0] - u).abs() < 1e-3
                    && (e.b[0] - u).abs() < 1e-3
                    && (e.a[1].min(e.b[1]) - 1.0).abs() < 1e-3
                    && (e.a[1].max(e.b[1]) - 2.0).abs() < 1e-3
            })
        };
        assert!(jamb_visible(-1.5), "linke Leibung (u=-1.5) muss sichtbar sein");
        assert!(jamb_visible(-2.5), "rechte Leibung (u=-2.5) muss sichtbar sein");
        // Bruestungs- und Sturzkante (horizontale Rahmenkanten bei v=1.0/2.0).
        let horizontal_edge_visible = |v: f32| {
            out.visible_edges.iter().any(|e| {
                e.component.kind == ComponentKind::Wall
                    && e.component.index == 0
                    && (e.a[1] - v).abs() < 1e-3
                    && (e.b[1] - v).abs() < 1e-3
                    && (e.a[0].min(e.b[0]) + 2.5).abs() < 1e-3
                    && (e.a[0].max(e.b[0]) + 1.5).abs() < 1e-3
            })
        };
        assert!(horizontal_edge_visible(1.0), "Bruestungskante (v=1.0) muss sichtbar sein");
        assert!(horizontal_edge_visible(2.0), "Sturzkante (v=2.0) muss sichtbar sein");
        // Keine dieser vier Rahmenkanten darf (auch nur teilweise) hidden sein
        // (Wand 0 steht als naechstes Bauteil vorne, nichts verdeckt sie).
        let frame_hidden = out.hidden_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 0
                && ((e.a[0] + 1.5).abs() < 1e-3 || (e.a[0] + 2.5).abs() < 1e-3)
                && e.a[1] >= 1.0 - 1e-3
                && e.a[1] <= 2.0 + 1e-3
        });
        assert!(!frame_hidden, "Fensterrahmen darf nicht (teilweise) hidden sein");

        // -- Durchblick: die (naeherliegende) Vorderkante von Wand 1 bei
        // u=-2.0 (Wandstart x=2, liegt IM Fenster-u-Bereich -2.5..-1.5) muss
        // GENAU im Fensterband (v: 1.0..2.0) sichtbar sein, darueber/darunter
        // (verdeckt durch Bruestung/Sturz der Wand 0) hidden. --
        let w1_visible_window = out.visible_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[0] + 2.0).abs() < 1e-3
                && (e.b[0] + 2.0).abs() < 1e-3
                && (e.a[1].min(e.b[1]) - 1.0).abs() < 1e-3
                && (e.a[1].max(e.b[1]) - 2.0).abs() < 1e-3
        });
        assert!(w1_visible_window, "Durchblick auf Wand 1 durchs Fenster (v 1.0..2.0) fehlt");

        let w1_hidden_below = out.hidden_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[0] + 2.0).abs() < 1e-3
                && (e.b[0] + 2.0).abs() < 1e-3
                && (e.a[1].min(e.b[1]) - 0.0).abs() < 1e-3
                && (e.a[1].max(e.b[1]) - 1.0).abs() < 1e-3
        });
        assert!(w1_hidden_below, "Wand 1 unterhalb der Bruestung (v 0..1.0) muss hidden sein");

        let w1_hidden_above = out.hidden_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[0] + 2.0).abs() < 1e-3
                && (e.b[0] + 2.0).abs() < 1e-3
                && (e.a[1].min(e.b[1]) - 2.0).abs() < 1e-3
                && (e.a[1].max(e.b[1]) - 2.5).abs() < 1e-3
        });
        assert!(w1_hidden_above, "Wand 1 oberhalb des Sturzes (v 2.0..2.5) muss hidden sein");

        // Kante hinter der GESCHLOSSENEN Wandflaeche (u=-4.0, ausserhalb des
        // Fensters, x=4-Ende von Wand 1) bleibt vollstaendig verdeckt.
        let w1_closed_wall_hidden = out.hidden_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall
                && e.component.index == 1
                && (e.a[0] + 4.0).abs() < 1e-3
                && (e.b[0] + 4.0).abs() < 1e-3
                && (e.a[1].min(e.b[1]) - 0.0).abs() < 1e-3
                && (e.a[1].max(e.b[1]) - 2.5).abs() < 1e-3
        });
        assert!(
            w1_closed_wall_hidden,
            "Kante hinter geschlossener Wandflaeche (u=-4.0) muss vollstaendig hidden sein"
        );
        let w1_closed_wall_visible = out.visible_edges.iter().any(|e| {
            e.component.kind == ComponentKind::Wall && e.component.index == 1 && (e.a[0] + 4.0).abs() < 1e-3
        });
        assert!(!w1_closed_wall_visible, "u=-4.0 (hinter geschlossener Wand) darf nicht sichtbar sein");
    }
}
