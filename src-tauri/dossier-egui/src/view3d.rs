// 3D-Ansicht: render3d rendert das Modell der sichtbaren Geschosse (plus skizzierte Wände) in
// eine Offscreen-Textur auf dem egui-Device. Orbit-Kamera (Ziehen = drehen, rechts/Mitte =
// verschieben, Rad = Abstand), Darstellungsstil über eine Auswahl im Kopf der Ansicht.

use egui::{Align2, Color32, FontId, Pos2, Rect, Sense, Vec2};
use render3d::gpu::RenderStyle;
use render3d::math::orbit_eye;
use render3d::types::{Camera, MeshInput, Projection, SlabInput, WallInput};

use crate::app::{Selection, State};
use crate::bundle::{Model3d, Shape as ElShape};
use crate::geom::band_corners;
use crate::i18n::t;
use crate::offscreen::{device_size, Offscreen};
use crate::theme;

pub struct View3d {
    renderer: Option<render3d::gpu::Renderer>,
    target: Option<Offscreen>,
    model_dirty: bool,
    highlight_dirty: bool,
    last_key: Option<[u64; 4]>,
    pub style: RenderStyle,
    style_applied: Option<RenderStyle>,
    /// Orbit: Ziel (world), Azimut, Erhebung, Abstand.
    target_pt: [f32; 3],
    yaw: f32,
    pitch: f32,
    dist: f32,
    fit_needed: bool,
    /// Erscheinungsbild beim letzten Hochladen (Bodenraster nur hell).
    uploaded_dark: Option<bool>,
}

impl Default for View3d {
    fn default() -> Self {
        Self {
            renderer: None,
            target: None,
            model_dirty: true,
            highlight_dirty: true,
            last_key: None,
            style: RenderStyle::ShadedEdges,
            style_applied: None,
            target_pt: [0.0; 3],
            yaw: -0.9,
            pitch: 0.55,
            dist: 20.0,
            fit_needed: true,
            uploaded_dark: None,
        }
    }
}

impl View3d {
    pub fn invalidate_model(&mut self) {
        self.model_dirty = true;
        self.highlight_dirty = true;
    }
    pub fn invalidate_highlight(&mut self) {
        self.highlight_dirty = true;
    }
    pub fn refit(&mut self) {
        self.fit_needed = true;
        self.model_dirty = true;
    }
}

/// Wand der Skizze als render3d-Eingabe (Standardfarbe, ohne Schichten).
fn sketch_wall(a: [f32; 2], b: [f32; 2], thickness: f32, base: f32, height: f32) -> Option<WallInput> {
    serde_json::from_value(serde_json::json!({
        "start": a, "end": b, "thickness": thickness, "height": height, "baseElevation": base,
        "color": [0.93, 0.62, 0.40]
    }))
    .ok()
}

/// Sammelt das sichtbare Modell (Geschosse + Umgebung + Skizze).
pub fn collect_model(st: &State) -> (Vec<WallInput>, Vec<SlabInput>, Vec<MeshInput>) {
    let mut walls = Vec::new();
    let mut slabs = Vec::new();
    let mut meshes = Vec::new();
    let Some(doc) = st.doc.as_ref() else { return (walls, slabs, meshes) };
    let mut add = |m: &Model3d| {
        walls.extend(m.walls.iter().cloned());
        slabs.extend(m.slabs.iter().cloned());
        meshes.extend(m.meshes.iter().cloned());
    };
    for (i, l) in doc.bundle.levels.iter().enumerate() {
        if st.visible3d.get(i).copied().unwrap_or(true) {
            add(&l.model3d);
        }
    }
    if st.context_visible {
        if let Some(c) = &doc.bundle.context3d {
            add(c);
        }
    }
    for w in &st.sketch {
        if !st.visible3d.get(w.level).copied().unwrap_or(true) {
            continue;
        }
        let (base, h) = doc.bundle.levels.get(w.level).map(|l| (l.elevation, if l.height > 0.0 { l.height } else { 2.6 })).unwrap_or((0.0, 2.6));
        walls.extend(sketch_wall(w.a, w.b, w.thickness, base, h));
    }
    (walls, slabs, meshes)
}

/// Hülle (world: x, Höhe, y) wie `render_png::bounds`.
fn world_bounds(walls: &[WallInput], slabs: &[SlabInput], meshes: &[MeshInput]) -> Option<([f32; 3], [f32; 3])> {
    let mut min = [f32::MAX; 3];
    let mut max = [f32::MIN; 3];
    let mut any = false;
    let mut add = |x: f32, y: f32, z: f32| {
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            return;
        }
        any = true;
        for (i, v) in [x, z, y].into_iter().enumerate() {
            min[i] = min[i].min(v);
            max[i] = max[i].max(v);
        }
    };
    for w in walls {
        for p in [w.start, w.end] {
            add(p[0], p[1], w.base_elevation);
            add(p[0], p[1], w.base_elevation + w.height);
        }
    }
    for s in slabs {
        for p in &s.outline {
            add(p[0], p[1], s.z_bottom);
            add(p[0], p[1], s.z_top);
        }
    }
    for m in meshes {
        for c in m.positions.chunks(3) {
            if c.len() == 3 {
                add(c[0], c[1], c[2]);
            }
        }
    }
    any.then_some((min, max))
}

/// Kanten der Auswahl als LineList `[x,y,z, r,g,b]` (world), als Prisma über dem Grundriss.
pub fn selection_lines(st: &State) -> Vec<f32> {
    let Some(doc) = st.doc.as_ref() else { return vec![] };
    let (ring, base, top): (Vec<[f32; 2]>, f32, f32) = match st.selection {
        Some(Selection::Element { level, index }) => {
            let Some(l) = doc.bundle.levels.get(level) else { return vec![] };
            let Some(e) = l.elements.get(index) else { return vec![] };
            let prop = |k: &str| e.props.iter().find(|(pk, _)| pk == k).and_then(|(_, v)| v.as_f64()).map(|v| v as f32);
            let h = if l.height > 0.0 { l.height } else { 2.6 };
            let (base, top) = match e.kind.as_str() {
                "door" | "window" => {
                    let sill = prop("sill").unwrap_or(0.0);
                    (l.elevation + sill, l.elevation + sill + prop("height").unwrap_or(h))
                }
                "room" | "ceiling" | "roof" => (l.elevation + 0.01, l.elevation + 0.02),
                _ => (l.elevation, l.elevation + prop("height").unwrap_or(h)),
            };
            let ring = match &e.shape {
                ElShape::Segment { a, b, width } => band_corners(*a, *b, *width).to_vec(),
                ElShape::Polygon { pts } => pts.clone(),
                ElShape::Circle { c, r } => (0..16).map(|i| {
                    let a = i as f32 / 16.0 * std::f32::consts::TAU;
                    [c[0] + r * a.cos(), c[1] + r * a.sin()]
                }).collect(),
            };
            (ring, base, top)
        }
        Some(Selection::Sketch(i)) => {
            let Some(w) = st.sketch.get(i) else { return vec![] };
            let l = doc.bundle.levels.get(w.level);
            let base = l.map(|l| l.elevation).unwrap_or(0.0);
            let h = l.map(|l| if l.height > 0.0 { l.height } else { 2.6 }).unwrap_or(2.6);
            (band_corners(w.a, w.b, w.thickness).to_vec(), base, base + h)
        }
        None => return vec![],
    };
    let col = [0.12f32, 0.48, 1.0];
    let mut v = Vec::new();
    let mut seg = |p: [f32; 3], q: [f32; 3]| {
        v.extend_from_slice(&[p[0], p[1], p[2], col[0], col[1], col[2], q[0], q[1], q[2], col[0], col[1], col[2]]);
    };
    let n = ring.len();
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        // Modell (x, y, z=Höhe) → world (x, Höhe, y)
        seg([a[0], base, a[1]], [b[0], base, b[1]]);
        seg([a[0], top, a[1]], [b[0], top, b[1]]);
        if top - base > 0.05 {
            seg([a[0], base, a[1]], [a[0], top, a[1]]);
        }
    }
    v
}

pub fn style_label(s: RenderStyle) -> String {
    match s {
        RenderStyle::ShadedEdges => t("style.shaded_edges"),
        RenderStyle::White => t("style.white"),
        RenderStyle::Hidden => t("style.hidden"),
        _ => t("style.shaded"),
    }
}

pub fn show(ui: &mut egui::Ui, st: &mut State, rs: Option<&egui_wgpu::RenderState>) {
    if st.doc.is_none() {
        ui.centered_and_justified(|ui| ui.weak(t("load.hint")));
        return;
    }
    // Kopfzeile: Darstellung + Zurücksetzen
    ui.horizontal(|ui| {
        ui.add_space(6.0);
        ui.label(t("3d.style"));
        let before = st.view3d.style;
        egui::ComboBox::from_id_salt("style3d").selected_text(style_label(st.view3d.style)).show_ui(ui, |ui| {
            for s in [RenderStyle::ShadedEdges, RenderStyle::Shaded, RenderStyle::White, RenderStyle::Hidden] {
                ui.selectable_value(&mut st.view3d.style, s, style_label(s));
            }
        });
        if before != st.view3d.style {
            st.view3d.last_key = None;
        }
        if ui.button(t("3d.reset")).clicked() {
            st.view3d.refit();
        }
    });

    let (rect, resp) = ui.allocate_exact_size(ui.available_size(), Sense::click_and_drag());
    if rect.width() < 2.0 || rect.height() < 2.0 {
        return;
    }
    let painter = ui.painter_at(rect);
    let Some(rs) = rs else {
        painter.text(rect.center(), Align2::CENTER_CENTER, t("gpu.missing"), FontId::proportional(13.0), ui.visuals().error_fg_color);
        return;
    };
    let dark = ui.visuals().dark_mode;

    // ── Modell hochladen ────────────────────────────────────────────────────
    st.view3d.renderer.get_or_insert_with(|| render3d::gpu::Renderer::new(&rs.device, wgpu::TextureFormat::Rgba8UnormSrgb));
    let mut empty = false;
    if st.view3d.uploaded_dark != Some(dark) {
        st.view3d.model_dirty = true;
        st.view3d.uploaded_dark = Some(dark);
    }
    if st.view3d.model_dirty {
        let (walls, slabs, meshes) = collect_model(st);
        empty = walls.is_empty() && slabs.is_empty() && meshes.is_empty();
        let renderer = st.view3d.renderer.as_mut().expect("Renderer angelegt");
        renderer.upload_model(&rs.device, &walls, &slabs, &meshes);
        let b = world_bounds(&walls, &slabs, &meshes);
        if let Some((min, max)) = b {
            let ground = min[1];
            let ext = ((max[0] - min[0]).max(max[2] - min[2]) * 1.5).max(20.0);
            // Das Raster von render3d hat feste, helle Linienfarben — im Dunkelmodus zu grell.
            renderer.set_ground_grid(&rs.device, !dark, ground, ext, 1.0);
            if st.view3d.fit_needed {
                let v = &mut st.view3d;
                v.target_pt = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
                let r = ((max[0] - min[0]).powi(2) + (max[1] - min[1]).powi(2) + (max[2] - min[2]).powi(2)).sqrt() * 0.5;
                v.dist = (r.max(1.0) / (Camera::default().fov_y * 0.5).tan() * 1.25).max(4.0);
                v.yaw = -0.9;
                v.pitch = 0.5;
                v.fit_needed = false;
            }
        }
        st.view3d.model_dirty = false;
        st.view3d.last_key = None;
    } else if let Some(doc) = &st.doc {
        empty = doc.bundle.levels.iter().all(|l| l.model3d.is_empty()) && st.sketch.is_empty();
    }
    if st.view3d.highlight_dirty {
        let lines = selection_lines(st);
        if let Some(r) = st.view3d.renderer.as_mut() {
            r.set_highlight_lines(&rs.device, &lines);
        }
        st.view3d.highlight_dirty = false;
        st.view3d.last_key = None;
    }

    // ── Orbit ──────────────────────────────────────────────────────────────
    let v = &mut st.view3d;
    if resp.dragged_by(egui::PointerButton::Primary) {
        let d = resp.drag_delta();
        v.yaw += d.x * 0.008;
        v.pitch = (v.pitch + d.y * 0.008).clamp(-0.1, 1.55);
    }
    if resp.dragged_by(egui::PointerButton::Secondary) || resp.dragged_by(egui::PointerButton::Middle) {
        // Verschieben in der Bildebene (Ziel wandert mit).
        let d = resp.drag_delta();
        let k = v.dist * 0.0018;
        let (sy, cy) = v.yaw.sin_cos();
        // Rechts-Vektor der Kamera (horizontal), Hoch = world Y
        let right = [-sy, 0.0, cy];
        v.target_pt[0] -= right[0] * d.x * k;
        v.target_pt[2] -= right[2] * d.x * k;
        v.target_pt[1] += d.y * k;
    }
    if resp.hovered() {
        let (scroll, zoom) = ui.input(|i| (i.smooth_scroll_delta.y, i.zoom_delta()));
        let f = zoom * (scroll * 0.0025).exp();
        if (f - 1.0).abs() > 1e-4 {
            v.dist = (v.dist / f).clamp(0.5, 5000.0);
        }
    }
    let camera = Camera {
        eye: orbit_eye(v.target_pt, v.yaw, v.pitch, v.dist),
        target: v.target_pt,
        up: [0.0, 1.0, 0.0],
        projection: Projection::Perspective,
        near: (v.dist * 0.01).max(0.05),
        far: (v.dist * 20.0).max(500.0),
        ..Camera::default()
    };

    // ── Rendern ─────────────────────────────────────────────────────────────
    let ppp = ui.ctx().pixels_per_point();
    let dsize = device_size(rect, ppp);
    let fresh = Offscreen::ensure(&mut v.target, rs, dsize, wgpu::TextureFormat::Rgba8UnormSrgb, wgpu::TextureFormat::Rgba8UnormSrgb, "view3d.target");
    let key = [
        ((dsize[0] as u64) << 32) | dsize[1] as u64 | ((dark as u64) << 63),
        ((v.yaw.to_bits() as u64) << 32) | v.pitch.to_bits() as u64,
        ((v.dist.to_bits() as u64) << 32) | v.target_pt[0].to_bits() as u64,
        ((v.target_pt[1].to_bits() as u64) << 32) | v.target_pt[2].to_bits() as u64,
    ];
    let renderer = v.renderer.as_mut().expect("Renderer angelegt");
    if v.style_applied != Some(v.style) {
        renderer.set_render_style(v.style);
        v.style_applied = Some(v.style);
        v.last_key = None;
    }
    let target = v.target.as_ref().expect("Ziel angelegt");
    if fresh || v.last_key != Some(key) {
        renderer.clear_color = theme::sky(dark);
        renderer.render(&rs.device, &rs.queue, &target.render_view, &camera, (dsize[0], dsize[1]));
        v.last_key = Some(key);
    }
    painter.image(target.tex_id, rect, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);
    let hint_col = if dark { Color32::from_gray(150) } else { Color32::from_gray(100) };
    painter.text(rect.min + Vec2::new(12.0, 10.0), Align2::LEFT_TOP, t("3d.hint"), FontId::proportional(11.0), hint_col);
    if empty {
        painter.text(rect.center(), Align2::CENTER_CENTER, t("3d.empty"), FontId::proportional(13.0), hint_col);
    }
}
