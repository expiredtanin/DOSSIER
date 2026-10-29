// Geometrie der Türen und Fenster für den IFC-Export ([B5], Port von `src/export/ifcOpenings.ts`, 28.10.):
// statt einer Box getrennte Körper im selben Bauteil — Rahmen/Zarge, Türblatt bzw. Glas — plus
// OperationType (Tür) und PartitioningType (Fenster). Alles sind vertikale Extrusionen von Grundriss-
// Rechtecken (wie die Wände), Profile in Welt-XY, Höhen ab Öffnungs-Unterkante; `ifc_export.rs` rechnet sie
// ins Füllungssystem. TS sammelt nur die Parameter aus dem Modell (`FillParams`, Kodierung im Kopf von
// `ifc_export.rs`).
//
// Masse kommen aus dem Modell, soweit es sie hergibt (Rahmenbreite/-tiefe, Schichteinzug, Flügelzahl und
// -tabelle, Verglasung, Blattzahl, Glasanteil, Oberlicht). Fehlendes füllen dieselben Konstanten wie das 3D
// (`src-tauri/core/src/openings3d.rs`), damit IFC und Ansicht dasselbe zeigen:
//   - Rahmenbreite 6 cm, Rahmentiefe 7 cm (reale Rahmen sind 70–90 mm tief, nicht so dick wie die Wand),
//     Türblatt 4 cm.
//   - Glaspaket: nur im IFC nötig, das 3D zeichnet Einzelscheiben. 1 Scheibe 6 mm, 2 Scheiben 24 mm
//     (4-16-4, übliches Isolierglas), 3 Scheiben 36 mm (4-12-4-12-4 ≈ 36 mm).
// Nicht abgebildet (bewusst einfach): Sprossen, Fensterbank/Rollladenkasten, Schwelle, Flügelrahmen im
// Blendrahmen, Kassettenfelder, Schiebe-Laufschiene — die Körper stehen im geschlossenen Zustand.
//
// Bitgleich zur TS-Fassung (Golden-Vergleich der IFC-Ausgabe): JS-Zahlsemantik für Math.min/max/round und
// Math.hypot (Kopien aus `src-tauri/core/src/jsnum.rs`/`jsmath.rs`, fileio hängt nicht vom Kern ab),
// Rechenreihenfolge wie in TS.

pub const DEFAULT_FRAME_WIDTH: f64 = 0.06;
pub const DEFAULT_FRAME_DEPTH: f64 = 0.07;
pub const DOOR_LEAF_THICK: f64 = 0.04;
/// Glaspaket-Dicke je Scheibenzahl (1, 2, 3).
pub const GLASS_PACKAGE_THICKNESS: [f64; 3] = [0.006, 0.024, 0.036];
/// Glasanteil des Türblatts, wenn der Typ keinen angibt.
const DEFAULT_GLAZING_RATIO: f64 = 0.5;
/// Kleinste Teilabmessung, damit nie ein flaches Profil entsteht (Meter).
const MIN_DIM: f64 = 0.005;
/// Pfostenbreite einer Flügeltabelle ohne Angabe.
const DEFAULT_POST_WIDTH: f64 = 0.06;
/// Höchstzahl Flügel (Unsinn-Schutz; TS kennt 1–4).
pub const MAX_SASHES: usize = 64;

/// `Math.min(a, b)` (NaN gewinnt; −0 < +0).
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}
/// `Math.max(a, b)` (NaN gewinnt; +0 > −0).
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}
/// `Math.round(x)`.
fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    if x > 0.0 && x < 0.5 {
        return 0.0;
    }
    if x < 0.0 && x >= -0.5 {
        return -0.0;
    }
    let r = x.ceil();
    if r - 0.5 > x { r - 1.0 } else { r }
}
/// `Math.hypot(a, b)` wie V8.
fn js_hypot2(a: f64, b: f64) -> f64 {
    let v = [a, b];
    let mut max = 0.0f64;
    let mut nan = false;
    for &x in &v {
        let a = x.abs();
        if a.is_infinite() {
            return f64::INFINITY;
        }
        if a.is_nan() {
            nan = true;
        } else if a > max {
            max = a;
        }
    }
    if nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let (mut sum, mut comp) = (0.0f64, 0.0f64);
    for &x in &v {
        let n = x.abs() / max;
        let summand = n * n - comp;
        let prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    sum.sqrt() * max
}

type V2 = (f64, f64);

/// Ein Eintrag der Flügeltabelle (`SashDef`), wie im Modell.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sash {
    /// `kind === "pfosten"`.
    pub post: bool,
    /// `postWidth` (None = nicht gesetzt).
    pub post_width: Option<f64>,
    /// `autoWidth === false`.
    pub fixed: bool,
    /// `width` (None = nicht gesetzt).
    pub width: Option<f64>,
}

/// Art einer Tür (`DoorType.kind`, Inline `doorType: "wandoeffnung"`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DoorKind {
    #[default]
    Swing,
    Sliding,
    WallOpening,
    /// Pendeltür (schlägt nach beiden Seiten auf).
    DoubleSwing,
}

/// Parameter einer Füllung aus dem Modell (TS `fillParams`); fehlende Typwerte als `None`.
#[derive(Clone, Debug, Default)]
pub struct FillParams {
    pub wall_start: V2,
    pub wall_end: V2,
    /// Achs-Intervall (Abstand ab `wall_start`) und absolute Höhen der Öffnung.
    pub from: f64,
    pub to: f64,
    pub z_bottom: f64,
    pub z_top: f64,
    /// Querausdehnung der Wand entlang der linken Normalen ab `wall_start` (`n_lo` = Aussenseite).
    pub n_lo: f64,
    pub n_hi: f64,
    pub is_door: bool,
    /// Typ: `frameDepth`, `insetFromFace`, `insetFace === "aussen"` (Standard), `frameWidth`.
    pub frame_depth: Option<f64>,
    pub inset: Option<f64>,
    pub inset_outside: bool,
    pub frame_width: Option<f64>,
    /// Fenster: Flügelzahl (`opening.wingCount ?? type.wingCount ?? 1`), Scheiben (1–3), Flügeltabelle.
    pub wing_count: f64,
    pub panes: usize,
    pub sashes: Vec<Sash>,
    /// Tür: Art, Blattzahl, Aufschlagseite (+1 links der Achse / −1), Richtung (+1 innen / −1 aussen),
    /// Scharnier am Anfang, Oberlichthöhe, Glasblatt, Glasanteil.
    pub door_kind: DoorKind,
    pub leaf_count: f64,
    pub swing_sign: f64,
    pub dir_sign: f64,
    pub hinge_at_start: bool,
    pub transom_height: f64,
    pub glazed: bool,
    pub glazing_ratio: Option<f64>,
}

/// Rolle eines Körpers: 0 Rahmen/Zarge, 1 Türblatt, 2 Glas.
#[derive(Clone, Debug, PartialEq)]
pub struct FillPart {
    pub role: usize,
    /// Profil in Welt-XY (Rechteck, gegen den Uhrzeigersinn in Achs-/Normalenrichtung).
    pub pts: Vec<V2>,
    /// Unterkante ab Öffnungs-Unterkante (m).
    pub z_rel: f64,
    /// Höhe des Körpers (m).
    pub depth: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FillGeometry {
    /// Ursprung des Füllungssystems (Welt-XY): Öffnungsmitte auf der Wandachse.
    pub origin: V2,
    /// X-Richtung des Füllungssystems (Einheitsvektor); Y = linke Normale davon.
    pub u: V2,
    /// IfcDoorTypeOperationEnum bzw. IfcWindowTypePartitioningEnum; None = Modell gibt nichts her.
    pub kind: Option<&'static str>,
    pub parts: Vec<FillPart>,
}

/// Flügeleinteilung, auf die Achsbreite aufgelöst: (von, bis, Pfosten?) ab Laibungsanfang.
struct SashSpan {
    from: f64,
    to: f64,
    post: bool,
}

/// Löst Flügel und Pfosten zu Intervallen auf: Pfosten und Flügel mit fester Breite behalten sie, die
/// übrigen teilen den Rest gleichmässig (gleiche Regel wie `sashSegments` im 2D). Ohne Tabelle:
/// `wing_count` gleiche Flügel.
fn sash_spans(sashes: &[Sash], wing_count: f64, total: f64) -> Vec<SashSpan> {
    let list: Vec<Sash> = if !sashes.is_empty() {
        sashes.to_vec()
    } else {
        // Array.from({ length: Math.max(1, Math.round(wingCount)) }) — NaN ergibt eine leere Liste.
        let n = js_max(1.0, js_round(wing_count));
        let n = if n.is_nan() { 0 } else { (n as usize).min(MAX_SASHES) };
        vec![Sash::default(); n]
    };
    let post_w = |s: &Sash| js_max(0.0, s.post_width.unwrap_or(DEFAULT_POST_WIDTH));
    let fixed_w = |s: &Sash| -> Option<f64> {
        if s.post {
            Some(post_w(s))
        } else if s.fixed {
            Some(js_max(0.0, s.width.unwrap_or(0.0)))
        } else {
            None
        }
    };
    let mut fixed = 0.0;
    let mut auto = 0usize;
    for s in &list {
        match fixed_w(s) {
            None => auto += 1,
            Some(w) => fixed += w,
        }
    }
    let auto_w = if auto > 0 { js_max(0.0, total - fixed) / auto as f64 } else { 0.0 };
    let mut out = Vec::with_capacity(list.len());
    let mut at = 0.0;
    for s in &list {
        let w = fixed_w(s).unwrap_or(auto_w);
        out.push(SashSpan { from: at, to: at + w, post: s.post });
        at += w;
    }
    out
}

/// Körper und Ausführung der Füllung einer Öffnung (Gegenstück der früheren TS-Funktion `fillGeometry`).
pub fn fill_geometry(p: &FillParams) -> FillGeometry {
    let (dx, dy) = (p.wall_end.0 - p.wall_start.0, p.wall_end.1 - p.wall_start.1);
    let len = js_hypot2(dx, dy);
    let len = if len == 0.0 || len.is_nan() { 1.0 } else { len };
    let u = (dx / len, dy / len);
    let n = (-u.1, u.0);
    let w = p.to - p.from;
    let h = p.z_top - p.z_bottom;
    let at = |a: f64, b: f64| -> V2 { (p.wall_start.0 + u.0 * a + n.0 * b, p.wall_start.1 + u.1 * a + n.1 * b) };
    let rect = |a0: f64, a1: f64, b0: f64, b1: f64| vec![at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)];
    let center = p.from + w / 2.0;
    let origin = at(center, 0.0);
    let mut parts: Vec<FillPart> = Vec::new();
    let mut add = |role: usize, a0: f64, a1: f64, b0: f64, b1: f64, z0: f64, z1: f64| {
        if a1 - a0 < 1e-6 || b1 - b0 < 1e-6 || z1 - z0 < 1e-6 {
            return;
        }
        parts.push(FillPart { role, pts: rect(a0, a1, b0, b1), z_rel: z0, depth: z1 - z0 });
    };

    // Querlage des Rahmens: Tiefe (Typ oder 7 cm), Schichteinzug von der gewählten Wandfläche, auf die
    // Wanddicke geklemmt — dieselbe Rechnung wie `windowSymbol` (2D) und `resolveFrameNormalRange` (3D).
    let total = p.n_hi - p.n_lo;
    let fd = match p.frame_depth {
        Some(d) if d > 1e-9 => d,
        _ => DEFAULT_FRAME_DEPTH,
    };
    let frame_depth = js_min(total, fd);
    let inset = js_max(0.0, p.inset.unwrap_or(0.0));
    let front = if p.inset_outside { p.n_lo + inset } else { p.n_hi - inset };
    let back = if p.inset_outside { front + frame_depth } else { front - frame_depth };
    let mut b0 = js_max(p.n_lo, js_min(p.n_hi, js_min(front, back)));
    let mut b1 = js_max(p.n_lo, js_min(p.n_hi, js_max(front, back)));
    if b1 - b0 < MIN_DIM {
        b0 = p.n_lo;
        b1 = p.n_hi;
    }
    let b_mid = (b0 + b1) / 2.0;

    // Sichtbare Rahmenbreite: höchstens ein Viertel der kleineren Öffnungsabmessung, sonst bliebe nichts offen.
    let fw_t = match p.frame_width {
        Some(x) if x > 1e-9 => x,
        _ => DEFAULT_FRAME_WIDTH,
    };
    let fw = js_max(MIN_DIM, js_min(fw_t, js_min(w, h) / 4.0));
    let a_in0 = p.from + fw;
    let a_in1 = p.to - fw;

    if !p.is_door {
        // ── Fenster: Blendrahmen (Pfosten links/rechts, Sturz, Sohlbank), Mittelpfosten, Glas je Flügel ──
        add(0, p.from, a_in0, b0, b1, 0.0, h);
        add(0, a_in1, p.to, b0, b1, 0.0, h);
        add(0, a_in0, a_in1, b0, b1, h - fw, h);
        add(0, a_in0, a_in1, b0, b1, 0.0, fw);
        let pane = GLASS_PACKAGE_THICKNESS[p.panes.clamp(1, 3) - 1];
        let gt = js_min(pane, b1 - b0);
        let g0 = b_mid - gt / 2.0;
        let g1 = b_mid + gt / 2.0;
        let spans = sash_spans(&p.sashes, p.wing_count, a_in1 - a_in0);
        let mut glass_count = 0;
        for (i, s) in spans.iter().enumerate() {
            let x0 = a_in0 + s.from;
            let x1 = a_in0 + s.to;
            if s.post {
                add(0, x0, x1, b0, b1, fw, h - fw);
                continue;
            }
            // Zwischen zwei Flügeln ohne Pfosten steht ein Mittelpfosten (Breite = Rahmenbreite) auf der Grenze.
            let gx0 = if i == 0 || spans[i - 1].post { x0 } else { x0 + fw / 2.0 };
            let gx1 = if i == spans.len() - 1 || spans[i + 1].post { x1 } else { x1 - fw / 2.0 };
            if spans.get(i + 1).is_some_and(|nx| !nx.post) {
                add(0, x1 - fw / 2.0, x1 + fw / 2.0, b0, b1, fw, h - fw);
            }
            add(2, gx0, gx1, g0, g1, fw, h - fw);
            glass_count += 1;
        }
        // Teilung nach IFC: nur die senkrechten Standardfälle sind benannt (sonst NOTDEFINED, das Modell
        // kennt Sprossen und Seitenverhältnisse, die IFC nicht als Enum führt).
        let kind = match glass_count {
            1 => "SINGLE_PANEL",
            2 => "DOUBLE_PANEL_VERTICAL",
            3 => "TRIPLE_PANEL_VERTICAL",
            _ => "NOTDEFINED",
        };
        return FillGeometry { origin, u, kind: Some(kind), parts };
    }

    // ── Tür ──
    // Aufschlagrichtung wie `doorSymbol`: linke Achsnormale, Richtung „aussen“ spiegelt sie.
    let swing_dir = (n.0 * p.swing_sign * p.dir_sign, n.1 * p.swing_sign * p.dir_sign);
    // Füllungssystem der Tür: Y = Aufschlagrichtung (IFC: die Tür schlägt nach +Y auf), X = Y × Z.
    let door_u = (swing_dir.1, -swing_dir.0);
    if p.door_kind == DoorKind::WallOpening {
        return FillGeometry { origin, u: door_u, kind: None, parts: Vec::new() };
    }

    // Zarge: Pfosten links/rechts über die ganze Höhe und Sturz (keine Schwelle).
    add(0, p.from, a_in0, b0, b1, 0.0, h);
    add(0, a_in1, p.to, b0, b1, 0.0, h);
    add(0, a_in0, a_in1, b0, b1, h - fw, h);

    // Oberlicht: fester Glasstreifen über einem Kämpfer (Riegel in Rahmenbreite) innerhalb der Öffnungshöhe.
    let th = p.transom_height;
    let has_transom = th > MIN_DIM && th < h - fw - 0.5;
    let leaf_top = if has_transom { h - fw - th - fw } else { h - fw };
    if has_transom {
        add(0, a_in0, a_in1, b0, b1, leaf_top, leaf_top + fw);
        let gt = js_min(GLASS_PACKAGE_THICKNESS[1], b1 - b0);
        add(2, a_in0, a_in1, b_mid - gt / 2.0, b_mid + gt / 2.0, leaf_top + fw, h - fw);
    }

    // Türblatt/-blätter im lichten Mass der Zarge, mittig in der Rahmentiefe.
    let lt = js_min(DOOR_LEAF_THICK, b1 - b0);
    let l0 = b_mid - lt / 2.0;
    let l1 = b_mid + lt / 2.0;
    let leaf_spans: Vec<(f64, f64)> = if p.leaf_count >= 2.0 {
        vec![(a_in0, (a_in0 + a_in1) / 2.0), ((a_in0 + a_in1) / 2.0, a_in1)]
    } else {
        vec![(a_in0, a_in1)]
    };
    let ratio = js_min(0.9, js_max(0.05, p.glazing_ratio.unwrap_or(DEFAULT_GLAZING_RATIO)));
    for (x0, x1) in leaf_spans {
        if !p.glazed {
            add(1, x0, x1, l0, l1, 0.0, leaf_top);
            continue;
        }
        // Glastür: Glasfläche = Glasanteil des Blatts (gleichmässig verkleinert um die Blattmitte), das Blatt
        // als umlaufender Rahmen darum; das Glas füllt die Blattdicke zu 60 % (4–24 mm, mittig).
        let s = ratio.sqrt();
        let cx = (x0 + x1) / 2.0;
        let cz = leaf_top / 2.0;
        let gw = (x1 - x0) * s;
        let gh = leaf_top * s;
        let (px0, px1, pz0, pz1) = (cx - gw / 2.0, cx + gw / 2.0, cz - gh / 2.0, cz + gh / 2.0);
        add(1, x0, x1, l0, l1, 0.0, pz0);
        add(1, x0, x1, l0, l1, pz1, leaf_top);
        add(1, x0, px0, l0, l1, pz0, pz1);
        add(1, px1, x1, l0, l1, pz0, pz1);
        let gt = js_min(GLASS_PACKAGE_THICKNESS[1], lt * 0.6);
        add(2, px0, px1, b_mid - gt / 2.0, b_mid + gt / 2.0, pz0, pz1);
    }

    // OperationType: Blattzahl und Scharnierseite. IFC blickt von der Aufschlagseite (+Y des Füllungssystems)
    // auf die Tür; "links" = Scharnier auf der +X-Seite des Systems (X = Y × Z, von +Y aus gesehen links).
    let hinge_axis = if p.hinge_at_start { p.from } else { p.to };
    let ha = at(hinge_axis, 0.0);
    let hinge_local_x = (ha.0 - origin.0) * door_u.0 + (ha.1 - origin.1) * door_u.1;
    let left = hinge_local_x > 0.0;
    let op = if p.door_kind == DoorKind::Sliding {
        if p.leaf_count >= 2.0 {
            "DOUBLE_DOOR_SLIDING"
        } else if left {
            "SLIDING_TO_LEFT"
        } else {
            "SLIDING_TO_RIGHT"
        }
    } else if p.door_kind == DoorKind::DoubleSwing {
        if p.leaf_count >= 2.0 {
            "DOUBLE_DOOR_DOUBLE_SWING"
        } else if left {
            "DOUBLE_SWING_LEFT"
        } else {
            "DOUBLE_SWING_RIGHT"
        }
    } else if p.leaf_count >= 2.0 {
        "DOUBLE_DOOR_SINGLE_SWING"
    } else if left {
        "SINGLE_SWING_LEFT"
    } else {
        "SINGLE_SWING_RIGHT"
    };
    FillGeometry { origin, u: door_u, kind: Some(op), parts }
}

// Tests: die früheren TS-Fälle (`ifcOpenings.test.ts`), Wand entlang +X von (0,0) nach (5,0), 0.4 dick.
#[cfg(test)]
mod tests {
    use super::*;

    fn base(is_door: bool, from: f64, width: f64, z0: f64, height: f64) -> FillParams {
        FillParams {
            wall_start: (0.0, 0.0),
            wall_end: (5.0, 0.0),
            from,
            to: from + width,
            z_bottom: z0,
            z_top: z0 + height,
            n_lo: -0.2,
            n_hi: 0.2,
            is_door,
            inset_outside: true,
            wing_count: 1.0,
            panes: 2,
            leaf_count: 1.0,
            swing_sign: 1.0,
            dir_sign: 1.0,
            hinge_at_start: true,
            ..Default::default()
        }
    }
    fn win() -> FillParams {
        base(false, 1.0, 1.2, 0.9, 1.2)
    }
    fn door() -> FillParams {
        base(true, 1.0, 1.0, 0.0, 2.1)
    }
    struct B {
        x0: f64,
        x1: f64,
        y0: f64,
        y1: f64,
    }
    fn bbox(p: &[V2]) -> B {
        let f = |g: fn(&V2) -> f64, init: f64, m: fn(f64, f64) -> f64| p.iter().map(g).fold(init, m);
        B { x0: f(|q| q.0, f64::MAX, f64::min), x1: f(|q| q.0, f64::MIN, f64::max), y0: f(|q| q.1, f64::MAX, f64::min), y1: f(|q| q.1, f64::MIN, f64::max) }
    }
    fn volume(parts: &[&FillPart]) -> f64 {
        parts.iter().map(|p| {
            let b = bbox(&p.pts);
            (b.x1 - b.x0) * (b.y1 - b.y0) * p.depth
        }).sum()
    }
    fn role(g: &FillGeometry, r: usize) -> Vec<&FillPart> {
        g.parts.iter().filter(|p| p.role == r).collect()
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn fenster_rahmen_glas_konstanten() {
        let g = fill_geometry(&win());
        let (frame, glass) = (role(&g, 0), role(&g, 2));
        assert_eq!((frame.len(), glass.len(), g.kind), (4, 1, Some("SINGLE_PANEL")));
        let fw = DEFAULT_FRAME_WIDTH;
        assert!(close(volume(&frame), (1.2 * 1.2 - (1.2 - 2.0 * fw) * (1.2 - 2.0 * fw)) * DEFAULT_FRAME_DEPTH));
        let gb = bbox(&glass[0].pts);
        assert!(close(gb.x1 - gb.x0, 1.2 - 2.0 * fw) && close(gb.y1 - gb.y0, 0.024));
        assert!(close((gb.y0 + gb.y1) / 2.0, -0.2 + DEFAULT_FRAME_DEPTH / 2.0));
        assert!(close(glass[0].z_rel, fw) && close(glass[0].depth, 1.2 - 2.0 * fw));
    }

    #[test]
    fn fenster_masse_aus_typ_einzug_innen() {
        let p = FillParams { frame_width: Some(0.09), frame_depth: Some(0.1), inset: Some(0.05), inset_outside: false, panes: 3, ..win() };
        let g = fill_geometry(&p);
        let frame = role(&g, 0);
        let b = bbox(&frame[0].pts);
        assert!(close(b.y0, 0.05) && close(b.y1, 0.15));
        let gl = bbox(&role(&g, 2)[0].pts);
        assert!(close(gl.y1 - gl.y0, 0.036) && close(gl.x1 - gl.x0, 1.2 - 0.18));
        // Rahmentiefe auf die Wanddicke geklemmt.
        let g = fill_geometry(&FillParams { frame_depth: Some(1.0), ..win() });
        let b = bbox(&g.parts[0].pts);
        assert!(close(b.y0, -0.2) && close(b.y1, 0.2));
    }

    #[test]
    fn fenster_fluegel_und_tabelle() {
        for (wing, kind) in [(2.0, "DOUBLE_PANEL_VERTICAL"), (3.0, "TRIPLE_PANEL_VERTICAL"), (4.0, "NOTDEFINED")] {
            let g = fill_geometry(&FillParams { wing_count: wing, ..win() });
            assert_eq!(role(&g, 2).len(), wing as usize);
            assert_eq!(role(&g, 0).len(), 4 + wing as usize - 1);
            assert_eq!(g.kind, Some(kind));
        }
        let sashes = vec![
            Sash { fixed: true, width: Some(0.5), ..Default::default() },
            Sash { post: true, post_width: Some(0.1), ..Default::default() },
            Sash::default(),
        ];
        let g = fill_geometry(&FillParams { sashes, ..win() });
        let glass: Vec<B> = role(&g, 2).iter().map(|p| bbox(&p.pts)).collect();
        assert_eq!(glass.len(), 2);
        assert!(close(glass[0].x1 - glass[0].x0, 0.5));
        let clear = 1.2 - 2.0 * 0.06;
        assert!(close(glass[1].x1 - glass[1].x0, clear - 0.6) && close(glass[1].x0, glass[0].x1 + 0.1));
        assert_eq!(g.kind, Some("DOUBLE_PANEL_VERTICAL"));
        // Alles innerhalb der Öffnung und der Wand.
        for p in &fill_geometry(&FillParams { wing_count: 2.0, ..win() }).parts {
            let b = bbox(&p.pts);
            assert!(b.x0 >= 1.0 - 1e-9 && b.x1 <= 2.2 + 1e-9 && b.y0 >= -0.2 - 1e-9 && b.y1 <= 0.2 + 1e-9);
            assert!(p.z_rel >= -1e-9 && p.z_rel + p.depth <= 1.2 + 1e-9);
        }
        // Unsinnige Flügelzahl: keine Scheibe, kein Panic.
        assert!(role(&fill_geometry(&FillParams { wing_count: f64::NAN, ..win() }), 2).is_empty());
        assert!(fill_geometry(&FillParams { wing_count: 1e300, ..win() }).parts.len() <= 4 + 2 * MAX_SASHES);
    }

    #[test]
    fn tuer_zarge_blatt_glas_oberlicht() {
        let g = fill_geometry(&door());
        assert_eq!(role(&g, 0).len(), 3);
        let leaf = role(&g, 1);
        assert_eq!(leaf.len(), 1);
        let lb = bbox(&leaf[0].pts);
        assert!(close(lb.y1 - lb.y0, DOOR_LEAF_THICK) && close(lb.x1 - lb.x0, 1.0 - 2.0 * DEFAULT_FRAME_WIDTH));
        assert!(leaf[0].z_rel == 0.0 && close(leaf[0].depth, 2.1 - DEFAULT_FRAME_WIDTH));
        assert!(role(&g, 2).is_empty());
        // Zweiflügelig.
        let g = fill_geometry(&FillParams { leaf_count: 2.0, ..door() });
        assert_eq!((role(&g, 1).len(), g.kind), (2, Some("DOUBLE_DOOR_SINGLE_SWING")));
        // Glastür.
        let g = fill_geometry(&FillParams { glazed: true, glazing_ratio: Some(0.36), ..door() });
        let glass = role(&g, 2);
        assert_eq!(glass.len(), 1);
        let gb = bbox(&glass[0].pts);
        let (lw, lh) = (1.0 - 2.0 * DEFAULT_FRAME_WIDTH, 2.1 - DEFAULT_FRAME_WIDTH);
        assert!(close((gb.x1 - gb.x0) * glass[0].depth / (lw * lh), 0.36));
        let leaf = role(&g, 1);
        assert_eq!(leaf.len(), 4);
        assert!(close(volume(&leaf), (lw * lh - (gb.x1 - gb.x0) * glass[0].depth) * DOOR_LEAF_THICK));
        // Oberlicht.
        let g = fill_geometry(&FillParams { transom_height: 0.4, ..door() });
        let glass = role(&g, 2);
        assert!(close(glass[0].depth, 0.4) && close(glass[0].z_rel + glass[0].depth, 2.1 - DEFAULT_FRAME_WIDTH));
        let leaf = role(&g, 1)[0];
        assert!(close(leaf.z_rel + leaf.depth, 2.1 - DEFAULT_FRAME_WIDTH - 0.4 - DEFAULT_FRAME_WIDTH));
        // Reine Wandöffnung.
        let g = fill_geometry(&FillParams { door_kind: DoorKind::WallOpening, ..door() });
        assert!(g.kind.is_none() && g.parts.is_empty());
    }

    #[test]
    fn tuer_anschlag_und_system() {
        // Wand entlang +X, linke Normale +Y. Standard: Aufschlag nach +Y, Scharnier am Anfang (x klein):
        // von +Y nach −Y gesehen liegt x klein rechts → RIGHT.
        let kind = |p: FillParams| fill_geometry(&p).kind;
        assert_eq!(kind(door()), Some("SINGLE_SWING_RIGHT"));
        assert_eq!(kind(FillParams { hinge_at_start: false, ..door() }), Some("SINGLE_SWING_LEFT"));
        assert_eq!(kind(FillParams { dir_sign: -1.0, ..door() }), Some("SINGLE_SWING_LEFT"));
        assert_eq!(kind(FillParams { swing_sign: -1.0, ..door() }), Some("SINGLE_SWING_LEFT"));
        assert_eq!(kind(FillParams { door_kind: DoorKind::Sliding, ..door() }), Some("SLIDING_TO_RIGHT"));
        assert_eq!(kind(FillParams { door_kind: DoorKind::Sliding, leaf_count: 2.0, ..door() }), Some("DOUBLE_DOOR_SLIDING"));
        assert_eq!(kind(FillParams { door_kind: DoorKind::DoubleSwing, leaf_count: 2.0, ..door() }), Some("DOUBLE_DOOR_DOUBLE_SWING"));
        let g = fill_geometry(&door());
        assert_eq!(g.origin, (1.5, 0.0));
        assert!(close(g.u.0, 1.0) && close(g.u.1, 0.0));
        assert!(close(fill_geometry(&FillParams { dir_sign: -1.0, ..door() }).u.0, -1.0));
    }

    #[test]
    fn js_zahlen() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert!(js_min(0.0, -0.0).is_sign_negative() && js_max(-0.0, 0.0).is_sign_positive());
        assert_eq!(js_hypot2(3.0, 4.0), 5.0);
    }
}
