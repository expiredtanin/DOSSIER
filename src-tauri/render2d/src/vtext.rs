// Vektor-Text: Glyphen-Umrisse einer Systemschrift werden EINMAL je Glyphe zu
// Dreiecken tesselliert (lyon) und danach instanziert gezeichnet — mit beliebiger
// Position, Groesse und DREHUNG (der Glyphen-Atlas-Text aus `glyphon` kann nicht
// drehen, Katastertexte sind aber oft gedreht).
//
// Bewusst einfach: Zeichenfolge → Glyph-IDs + Vorschub (hmtx), KEIN Kerning, kein
// komplexes Shaping (CAD-Beschriftungen: Zahlen, Strassen-/Flurnamen).

use std::collections::HashMap;
use std::sync::Arc;

use lyon_tessellation::geom::point;
use lyon_tessellation::path::Path;
use lyon_tessellation::{BuffersBuilder, FillOptions, FillRule, FillTessellator, FillVertex, VertexBuffers};

/// Indexbereich eines Glyphen-Meshes im gemeinsamen Index-Puffer.
#[derive(Clone, Copy, Debug)]
pub struct GlyphMesh {
    pub first_index: u32,
    pub index_count: u32,
}

pub struct VectorFont {
    data: Arc<Vec<u8>>,
    index: u32,
    units_per_em: f32,
    /// Gemeinsamer Vertex-/Index-Puffer aller bisher tessellierten Glyphen (em-Einheiten, Y nach oben).
    pub verts: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    meshes: HashMap<u16, GlyphMesh>,
    /// true, sobald `verts`/`indices` seit dem letzten Hochladen gewachsen sind.
    pub dirty: bool,
}

struct PathSink {
    b: lyon_tessellation::path::path::Builder,
    open: bool,
    s: f32,
}

impl ttf_parser::OutlineBuilder for PathSink {
    fn move_to(&mut self, x: f32, y: f32) {
        if self.open {
            self.b.end(true);
        }
        self.b.begin(point(x * self.s, y * self.s));
        self.open = true;
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.b.line_to(point(x * self.s, y * self.s));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.b.quadratic_bezier_to(point(x1 * self.s, y1 * self.s), point(x * self.s, y * self.s));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.b.cubic_bezier_to(
            point(x1 * self.s, y1 * self.s),
            point(x2 * self.s, y2 * self.s),
            point(x * self.s, y * self.s),
        );
    }
    fn close(&mut self) {
        if self.open {
            self.b.end(true);
            self.open = false;
        }
    }
}

impl VectorFont {
    /// Sucht eine Systemschrift (Inter, sonst Sans-Serif, sonst irgendeine).
    pub fn system() -> Option<Self> {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let q = fontdb::Query {
            families: &[
                fontdb::Family::Name("Inter"),
                fontdb::Family::Name("Helvetica Neue"),
                fontdb::Family::Name("Helvetica"),
                fontdb::Family::Name("Arial"),
                fontdb::Family::SansSerif,
            ],
            ..Default::default()
        };
        let id = db.query(&q).or_else(|| db.faces().next().map(|f| f.id))?;
        let (data, index) = db.with_face_data(id, |d, i| (d.to_vec(), i))?;
        Self::from_bytes(data, index)
    }

    pub fn from_bytes(data: Vec<u8>, index: u32) -> Option<Self> {
        let upem = {
            let face = ttf_parser::Face::parse(&data, index).ok()?;
            face.units_per_em() as f32
        };
        if upem <= 0.0 {
            return None;
        }
        Some(Self {
            data: Arc::new(data),
            index,
            units_per_em: upem,
            verts: Vec::new(),
            indices: Vec::new(),
            meshes: HashMap::new(),
            dirty: false,
        })
    }

    /// Zeichen → (Glyph-ID, X-Versatz der Glyphe in em) plus Gesamtbreite in em.
    pub fn shape(&self, text: &str) -> (Vec<(u16, f32)>, f32) {
        let Ok(face) = ttf_parser::Face::parse(&self.data, self.index) else {
            return (Vec::new(), 0.0);
        };
        let mut out = Vec::with_capacity(text.len());
        let mut x = 0.0f32;
        for ch in text.chars() {
            let gid = face.glyph_index(ch).unwrap_or(ttf_parser::GlyphId(0));
            let adv = face.glyph_hor_advance(gid).unwrap_or((self.units_per_em * 0.5) as u16) as f32 / self.units_per_em;
            if ch != ' ' && ch != '\u{a0}' {
                out.push((gid.0, x));
            }
            x += adv;
        }
        (out, x)
    }

    /// Bereits tesselliertes Mesh einer Glyphe (nur lesend).
    pub fn mesh_info(&self, gid: u16) -> Option<GlyphMesh> {
        self.meshes.get(&gid).copied().filter(|m| m.index_count > 0)
    }

    /// Mesh einer Glyphe (beim ersten Bedarf tesselliert). Leere Glyphen → `None`.
    pub fn mesh(&mut self, gid: u16) -> Option<GlyphMesh> {
        if let Some(m) = self.meshes.get(&gid) {
            return if m.index_count == 0 { None } else { Some(*m) };
        }
        let mesh = self.tessellate(gid);
        self.meshes.insert(gid, mesh);
        if mesh.index_count == 0 { None } else { Some(mesh) }
    }

    fn tessellate(&mut self, gid: u16) -> GlyphMesh {
        let empty = GlyphMesh { first_index: self.indices.len() as u32, index_count: 0 };
        let Ok(face) = ttf_parser::Face::parse(&self.data, self.index) else {
            return empty;
        };
        let mut sink = PathSink { b: Path::builder(), open: false, s: 1.0 / self.units_per_em };
        if face.outline_glyph(ttf_parser::GlyphId(gid), &mut sink).is_none() {
            return empty;
        }
        if sink.open {
            sink.b.end(true);
        }
        let path = sink.b.build();
        let mut buffers: VertexBuffers<[f32; 2], u32> = VertexBuffers::new();
        let mut tess = FillTessellator::new();
        // Toleranz in em: 0.0003 em ≈ 0.06 px bei 200 px Schrift.
        let opts = FillOptions::tolerance(0.0003).with_fill_rule(FillRule::NonZero);
        if tess
            .tessellate_path(&path, &opts, &mut BuffersBuilder::new(&mut buffers, |v: FillVertex| v.position().to_array()))
            .is_err()
            || buffers.indices.is_empty()
        {
            return empty;
        }
        let base = self.verts.len() as u32;
        let first_index = self.indices.len() as u32;
        self.verts.extend_from_slice(&buffers.vertices);
        self.indices.extend(buffers.indices.iter().map(|i| i + base));
        self.dirty = true;
        GlyphMesh { first_index, index_count: buffers.indices.len() as u32 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_and_tessellates_a_glyph_if_a_system_font_exists() {
        let Some(mut font) = VectorFont::system() else {
            eprintln!("keine Systemschrift – Test uebersprungen");
            return;
        };
        let (glyphs, width) = font.shape("AB 1");
        assert_eq!(glyphs.len(), 3, "Leerzeichen erzeugt keine Glyphe");
        assert!(width > 1.0 && width < 4.0, "Breite in em plausibel: {width}");
        let m = font.mesh(glyphs[0].0).expect("A hat einen Umriss");
        assert!(m.index_count >= 3 && m.index_count % 3 == 0);
        assert!(font.verts.iter().all(|v| v[0].abs() < 2.0 && v[1].abs() < 2.0), "em-normalisiert");
        // Zweiter Zugriff liefert dasselbe Mesh ohne neu zu tessellieren.
        let n = font.indices.len();
        assert_eq!(font.mesh(glyphs[0].0).unwrap().first_index, m.first_index);
        assert_eq!(font.indices.len(), n);
    }
}
