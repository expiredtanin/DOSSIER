// Tests des Mesh-Imports: Rundreise mit den eigenen Schreibern (`mesh_export.rs`), Sonderfälle je Format,
// kaputte Dateien ohne Panic.

use super::*;
use crate::mesh_export::{export_glb, export_gltf, export_obj, export_stl};

// ── Hilfen ──────────────────────────────────────────────────────────────────

/// Eine Gruppe für den Export: Modell-Koordinaten (x, y, z-hoch), Dreiecke gegen den Uhrzeigersinn von aussen.
struct G {
    name: &'static str,
    rgba: Option<[f64; 4]>,
    pos: Vec<[f64; 3]>,
    tris: Vec<[u32; 3]>,
}

/// Flacher Puffer wie die TS-Seite (Welt = (x, z, y), Wicklung vertauscht).
fn flat(groups: &[G]) -> (Vec<f64>, String) {
    let mut strings: Vec<String> = Vec::new();
    let s = |t: &str, strings: &mut Vec<String>| -> f64 {
        strings.push(t.to_string());
        (strings.len() - 1) as f64
    };
    let mut mats: Vec<[f64; 4]> = Vec::new();
    let mut nums = vec![1.0, 0.0];
    let mut body: Vec<f64> = Vec::new();
    for g in groups {
        let mi = match g.rgba {
            Some(c) => {
                let at = mats.iter().position(|m| *m == c).unwrap_or_else(|| {
                    mats.push(c);
                    mats.len() - 1
                });
                at as f64
            }
            None => -1.0,
        };
        let n = s(g.name, &mut strings);
        let k = s("wall", &mut strings);
        let id = s("x", &mut strings);
        body.extend([n, k, id, -1.0, 1.0, mi, g.pos.len() as f64]);
        for p in &g.pos {
            body.extend([p[0], p[2], p[1]]);
        }
        body.push(g.tris.len() as f64);
        for t in &g.tris {
            body.extend([f64::from(t[0]), f64::from(t[2]), f64::from(t[1])]);
        }
    }
    nums.push(mats.len() as f64);
    for (i, c) in mats.iter().enumerate() {
        let n = s(&format!("M{i}"), &mut strings);
        nums.extend([n, c[0], c[1], c[2], c[3], 0.0, 0.8]);
    }
    nums.push(0.0);
    nums.push(groups.len() as f64);
    nums.extend(body);
    (nums, strings.join("\0"))
}

/// Quader (Mass b × t × h) ab (x0, y0, z0), 12 Dreiecke gegen den Uhrzeigersinn von aussen.
fn cuboid(x0: f64, y0: f64, z0: f64, b: f64, t: f64, h: f64) -> (Vec<[f64; 3]>, Vec<[u32; 3]>) {
    let mut pos = Vec::new();
    for i in 0..8u32 {
        pos.push([x0 + b * f64::from(i & 1), y0 + t * f64::from((i >> 1) & 1), z0 + h * f64::from((i >> 2) & 1)]);
    }
    let quads: [[u32; 4]; 6] = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    let mut tris = Vec::new();
    for q in quads {
        tris.push([q[0], q[1], q[2]]);
        tris.push([q[0], q[2], q[3]]);
    }
    (pos, tris)
}

fn volume(o: &MeshObject) -> f64 {
    let mut v = 0.0;
    for t in o.indices.chunks_exact(3) {
        let p = |i: u32| &o.positions[i as usize * 3..i as usize * 3 + 3];
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
    }
    v
}

fn bbox(o: &MeshObject) -> ([f64; 3], [f64; 3]) {
    let (mut lo, mut hi) = ([f64::MAX; 3], [f64::MIN; 3]);
    for v in o.positions.chunks_exact(3) {
        for a in 0..3 {
            lo[a] = lo[a].min(v[a]);
            hi[a] = hi[a].max(v[a]);
        }
    }
    (lo, hi)
}

fn close(a: [f64; 3], b: [f64; 3], eps: f64) -> bool {
    (0..3).all(|i| (a[i] - b[i]).abs() < eps)
}

fn two_boxes() -> Vec<G> {
    let (p1, t1) = cuboid(2.0, 3.0, 0.0, 4.0, 5.0, 3.0);
    let (p2, t2) = cuboid(-10.0, 1.0, 0.5, 1.0, 1.0, 1.0);
    vec![
        G { name: "Wand_W1", rgba: Some([0.8, 0.2, 0.1, 1.0]), pos: p1, tris: t1 },
        G { name: "Stuetze_S1", rgba: None, pos: p2, tris: t2 },
    ]
}

fn check_boxes(m: &MeshImport, color: bool) {
    assert_eq!(m.objects.len(), 2);
    assert_eq!(m.triangles, 24);
    let a = m.objects.iter().find(|o| o.name.contains("W1")).expect("Wand");
    let (lo, hi) = bbox(a);
    assert!(close(lo, [2.0, 3.0, 0.0], 1e-5), "{lo:?}");
    assert!(close(hi, [6.0, 8.0, 3.0], 1e-5), "{hi:?}");
    assert!((volume(a) - 60.0).abs() < 1e-3, "Volumen {}", volume(a));
    let b = m.objects.iter().find(|o| o.name.contains("S1")).expect("Stütze");
    assert!((volume(b) - 1.0).abs() < 1e-3);
    if color {
        let c = a.color.expect("Farbe");
        assert!((c[0] - 0.8).abs() < 0.01 && (c[1] - 0.2).abs() < 0.01 && (c[2] - 0.1).abs() < 0.01, "{c:?}");
    }
}

fn opts() -> Options {
    Options::default()
}

// ── Rundreise ───────────────────────────────────────────────────────────────

#[test]
fn rundreise_glb() {
    let (f, s) = flat(&two_boxes());
    let bytes = export_glb(&f, &s).expect("glb");
    let m = import_mesh(&bytes, "x.glb", &opts()).expect("import");
    assert_eq!(m.format, Format::Gltf);
    assert_eq!(m.up_used, Up::Y);
    check_boxes(&m, true);
}

#[test]
fn rundreise_gltf_data_uri() {
    let (f, s) = flat(&two_boxes());
    let text = export_gltf(&f, &s).expect("gltf");
    let m = import_mesh(text.as_bytes(), "x.gltf", &opts()).expect("import");
    check_boxes(&m, true);
}

#[test]
fn rundreise_obj_y_up_aus_kopf() {
    let (f, s) = flat(&two_boxes());
    let obj = export_obj(&f, &s).expect("obj");
    let m = import_mesh(obj.as_bytes(), "x.obj", &opts()).expect("import");
    assert_eq!(m.format, Format::Obj);
    assert_eq!(m.up_used, Up::Y);
    assert!(m.up_auto && m.up_certain);
    check_boxes(&m, false);
}

#[test]
fn rundreise_stl_achse_aus_ausdehnung() {
    let (f, s) = flat(&two_boxes());
    let stl = export_stl(&f, &s).expect("stl");
    // Beide Körper zusammen: 16 × 8 in der Grundfläche, 3 hoch → Höhe ist die kleinste Ausdehnung.
    let m = import_mesh(stl.as_bytes(), "x.stl", &opts()).expect("import");
    assert_eq!(m.format, Format::Stl);
    assert_eq!(m.up_used, Up::Y);
    assert!(m.up_certain);
    assert_eq!(m.triangles, 24);
    assert!((m.objects.iter().map(volume).sum::<f64>() - 61.0).abs() < 1e-3);
    let z = import_mesh(stl.as_bytes(), "x.stl", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(z.up_used, Up::Z);
    assert!(!z.up_auto);
}

#[test]
fn einheit_skaliert_ausser_gltf() {
    let (f, s) = flat(&two_boxes());
    let obj = export_obj(&f, &s).expect("obj");
    let m = import_mesh(obj.as_bytes(), "x.obj", &Options { unit_scale: 0.001, ..opts() }).expect("import");
    let v: f64 = m.objects.iter().map(volume).sum();
    assert!((v - 61.0e-9).abs() < 1e-12, "{v}");
    let glb = export_glb(&f, &s).expect("glb");
    let g = import_mesh(&glb, "x.glb", &Options { unit_scale: 0.001, ..opts() }).expect("import");
    assert_eq!(g.unit_scale, 1.0);
}

// ── OBJ ─────────────────────────────────────────────────────────────────────

#[test]
fn obj_quads_ngons_negative_indizes() {
    let obj = "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n\
               v 2 0 0\nv 3 0 0\nv 3 1 0\nv 2.5 0.4 0\nv 2 1 0\nf -5 -4 -3 -2 -1\n";
    let m = import_mesh(obj.as_bytes(), "q.obj", &Options { up: Up::Z, ..opts() }).expect("import");
    // Quad → 2, konkaves Fünfeck → 3 Dreiecke.
    assert_eq!(m.triangles, 5);
    let o = &m.objects[0];
    let mut area = 0.0;
    for t in o.indices.chunks_exact(3) {
        let p = |i: u32| &o.positions[i as usize * 3..i as usize * 3 + 3];
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        assert!(cz > 0.0, "Wicklung bleibt gegen den Uhrzeigersinn");
        area += cz / 2.0;
    }
    // Quadrat 1 + Fünfeck (Quadrat 1 minus Keil: Grundlinie 1 × Tiefe 0,6 / 2).
    assert!((area - (1.0 + (1.0 - 0.5 * 1.0 * 0.6))).abs() < 1e-9, "{area}");
}

#[test]
fn obj_gruppen_materialien_mtl() {
    let obj = "mtllib m.mtl\no Haus\ng Dach\nusemtl rot\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n\
               g Wand\nusemtl blau\nf 1 2 3\nusemtl rot\nf 3 2 1\n";
    let mtl = "newmtl rot\nKd 1 0 0\nnewmtl blau\nKd 0 0 1\nd 0.5\n";
    let o = Options { up: Up::Z, files: vec![("M.MTL".into(), mtl.as_bytes().to_vec())], ..opts() };
    let m = import_mesh(obj.as_bytes(), "h.obj", &o).expect("import");
    assert_eq!(m.objects.len(), 3);
    let dach = m.objects.iter().find(|x| x.name == "Dach").expect("Dach");
    assert_eq!(dach.group, "Haus");
    assert_eq!(dach.color, Some([1.0, 0.0, 0.0, 1.0]));
    let blau = m.objects.iter().find(|x| x.name == "Wand (blau)").expect("blau");
    assert_eq!(blau.color, Some([0.0, 0.0, 1.0, 0.5]));
    assert!(m.objects.iter().any(|x| x.name == "Wand (rot)"));
    // Ohne MTL: Hinweis, keine Farbe.
    let m2 = import_mesh(obj.as_bytes(), "h.obj", &Options { up: Up::Z, ..opts() }).expect("import");
    assert!(m2.objects.iter().all(|x| x.color.is_none()));
    assert!(m2.warnings.iter().any(|w| w.contains("m.mtl")));
}

#[test]
fn obj_ungueltiges_wird_gezaehlt() {
    let obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv nan 0 0\nf 1 2 3\nf 1 2 99\nf 1 2\nf 1 2 4\nf 1 1 2\nf 0 1 2\n";
    let m = import_mesh(obj.as_bytes(), "b.obj", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.triangles, 1);
    assert!(m.bad_faces >= 4, "{}", m.bad_faces);
    assert_eq!(m.degenerate, 1);
}

#[test]
fn obj_ohne_flaechen_fehler() {
    assert!(import_mesh(b"v 0 0 0\nv 1 0 0\n", "x.obj", &opts()).is_err());
}

// ── STL ─────────────────────────────────────────────────────────────────────

fn binary_stl(header: &[u8], facets: &[([[f32; 3]; 3], u16)]) -> Vec<u8> {
    let mut b = vec![0u8; 80];
    b[..header.len()].copy_from_slice(header);
    b.extend((facets.len() as u32).to_le_bytes());
    for (t, attr) in facets {
        b.extend([0u8; 12]);
        for v in t {
            for c in v {
                b.extend(c.to_le_bytes());
            }
        }
        b.extend(attr.to_le_bytes());
    }
    b
}

#[test]
fn stl_binaer_verschweisst_und_farben_viscam() {
    let red = 0x8000u16 | (31 << 10); // VisCAM: Rot in Bits 10–14
    let t1 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let t2 = [[1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
    let bytes = binary_stl(b"binary", &[(t1, red), (t2, 0)]);
    let m = import_mesh(&bytes, "a.stl", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.triangles, 2);
    assert_eq!(m.objects.len(), 2);
    let farbig = m.objects.iter().find(|o| o.color.is_some()).expect("rot");
    assert_eq!(farbig.color, Some([1.0, 0.0, 0.0, 1.0]));
    assert_eq!(farbig.positions.len(), 9);
}

#[test]
fn stl_binaer_magics_vorgabefarbe() {
    let t1 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let bytes = binary_stl(b"COLOR=\x00\xff\x00\xff", &[(t1, 0)]);
    let m = import_mesh(&bytes, "a.stl", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.objects[0].color, Some([0.0, 1.0, 0.0, 1.0]));
}

#[test]
fn stl_ascii_mehrere_solids() {
    let s = "solid A\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid A\n\
             solid B\nfacet normal 0 0 1\nouter loop\nvertex 0 0 1\nvertex 1 0 1\nvertex 0 1 1\nendloop\nendfacet\nendsolid B\n";
    let m = import_mesh(s.as_bytes(), "x.stl", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.objects.len(), 2);
    assert_eq!(m.objects[0].name, "A");
    assert_eq!(m.objects[1].name, "B");
}

#[test]
fn stl_binaer_mit_solid_im_kopf_wird_binaer_gelesen() {
    let t1 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
    let bytes = binary_stl(b"solid exportiert von X", &[(t1, 0)]);
    let m = import_mesh(&bytes, "a.stl", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.triangles, 1);
}

// ── PLY ─────────────────────────────────────────────────────────────────────

#[test]
fn ply_ascii_mit_quad_und_flaechenfarbe() {
    let ply = "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n\
               element face 1\nproperty list uchar int vertex_indices\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n\
               0 0 0\n1 0 0\n1 1 0\n0 1 0\n4 0 1 2 3 0 255 0\n";
    let m = import_mesh(ply.as_bytes(), "x.ply", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.format, Format::Ply);
    assert_eq!(m.triangles, 2);
    assert_eq!(m.objects[0].color, Some([0.0, 1.0, 0.0, 1.0]));
}

#[test]
fn ply_binaer_big_endian() {
    let mut b = b"ply\nformat binary_big_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n\
                  element face 1\nproperty list uchar uint vertex_index\nend_header\n"
        .to_vec();
    for v in [[0.0f32, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]] {
        for c in v {
            b.extend(c.to_be_bytes());
        }
    }
    b.push(3);
    for i in [0u32, 1, 2] {
        b.extend(i.to_be_bytes());
    }
    let m = import_mesh(&b, "x.ply", &Options { up: Up::Z, ..opts() }).expect("import");
    assert_eq!(m.triangles, 1);
    assert_eq!(bbox(&m.objects[0]).1, [2.0, 2.0, 0.0]);
}

#[test]
fn ply_punktwolke_gibt_hinweis() {
    let ply = "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 1 1\n";
    let e = import_mesh(ply.as_bytes(), "x.ply", &opts()).unwrap_err();
    assert!(e.starts_with(NO_FACES), "{e}");
}

// ── glTF von Hand ───────────────────────────────────────────────────────────

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for k in 0..4 {
            if k <= c.len() {
                s.push(T[((n >> (18 - 6 * k)) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// Einheitsquadrat in der XZ-Ebene (Y-up), 4 Eckpunkte (48 Byte) + 4 Indizes u16 (8 Byte) als Streifen 0,1,2,3.
/// Dreieck (v0,v1,v2): (v1−v0)×(v2−v0) = (0,0,1)×(1,0,0) = (0,1,0) → Normale +Y.
fn quad_buffer() -> Vec<u8> {
    let mut b = Vec::new();
    for v in [[0.0f32, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [1.0, 0.0, 1.0]] {
        for c in v {
            b.extend(c.to_le_bytes());
        }
    }
    for i in [0u16, 1, 2, 3] {
        b.extend(i.to_le_bytes());
    }
    b
}

fn gltf_quad(mode: u32, nodes: &str, extra: &str, uri: &str) -> String {
    format!(
        "{{\"asset\":{{\"version\":\"2.0\"}},\"scene\":0,\"scenes\":[{{\"nodes\":[0]}}],\"nodes\":{nodes},\
         \"meshes\":[{{\"name\":\"Quad\",\"primitives\":[{{\"attributes\":{{\"POSITION\":0}},\"indices\":1,\"mode\":{mode},\"material\":0}}]}}],\
         \"materials\":[{{\"name\":\"Rot\",\"pbrMetallicRoughness\":{{\"baseColorFactor\":[1,0,0,1]}}}}],\
         \"accessors\":[{{\"bufferView\":0,\"componentType\":5126,\"count\":4,\"type\":\"VEC3\"}},\
         {{\"bufferView\":1,\"componentType\":5123,\"count\":4,\"type\":\"SCALAR\"}}],\
         \"bufferViews\":[{{\"buffer\":0,\"byteOffset\":0,\"byteLength\":48}},{{\"buffer\":0,\"byteOffset\":48,\"byteLength\":8}}],\
         \"buffers\":[{{{uri}\"byteLength\":56}}]{extra}}}",
    )
}

fn data_uri() -> String {
    format!("\"uri\":\"data:application/octet-stream;base64,{}\",", b64(&quad_buffer()))
}

/// Alle Dreiecks-Normalen zeigen nach +Z (Modell: nach oben).
fn all_up(o: &MeshObject) -> bool {
    o.indices.chunks_exact(3).all(|t| {
        let p = |i: u32| &o.positions[i as usize * 3..i as usize * 3 + 3];
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0.0
    })
}

#[test]
fn gltf_knoten_hierarchie_trs() {
    // Eltern: Verschiebung (10, 0, 0); Kind: Skalierung 2 und 90° um Y.
    let s = std::f64::consts::FRAC_1_SQRT_2;
    let nodes = format!(
        "[{{\"name\":\"Eltern\",\"translation\":[10,0,0],\"children\":[1]}},\
         {{\"name\":\"Kind\",\"mesh\":0,\"scale\":[2,2,2],\"rotation\":[0,{s},0,{s}]}}]"
    );
    let j = gltf_quad(4, &nodes, "", &data_uri());
    // Modus 4 mit 4 Indizes: ein Dreieck (0,1,2), der Rest fällt weg.
    let m = import_mesh(j.as_bytes(), "q.gltf", &opts()).expect("import");
    assert_eq!(m.objects.len(), 1);
    let o = &m.objects[0];
    assert_eq!(o.name, "Kind");
    assert_eq!(o.group, "Eltern");
    assert_eq!(o.color, Some([1.0, 0.0, 0.0, 1.0]));
    // Eckpunkt 1 (0,0,1)·2 → (0,0,2); 90° um Y: (x,y,z) → (z,y,−x) = (2,0,0); + (10,0,0) → glTF (12,0,0)
    // → Modell (X, −Z, Y) = (12, 0, 0).
    let found = o.positions.chunks_exact(3).any(|v| close([v[0], v[1], v[2]], [12.0, 0.0, 0.0], 1e-6));
    assert!(found, "{:?}", o.positions);
    assert!(all_up(o), "Normale nach oben");
}

#[test]
fn gltf_matrix_streifen_und_faecher() {
    let nodes = "[{\"name\":\"N\",\"mesh\":0,\"matrix\":[1,0,0,0, 0,1,0,0, 0,0,1,0, 5,6,7,1]}]";
    let strip = import_mesh(gltf_quad(5, nodes, "", &data_uri()).as_bytes(), "q.gltf", &opts()).expect("strip");
    assert_eq!(strip.triangles, 2);
    // Verschiebung (5,6,7) glTF → Modell (5, −7, 6); Quadrat 1 × 1 in glTF-Z → Modell −Y.
    let (lo, hi) = bbox(&strip.objects[0]);
    assert!(close(lo, [5.0, -8.0, 6.0], 1e-9), "{lo:?}");
    assert!(close(hi, [6.0, -7.0, 6.0], 1e-9), "{hi:?}");
    assert!(all_up(&strip.objects[0]));
    let fan = import_mesh(gltf_quad(6, nodes, "", &data_uri()).as_bytes(), "q.gltf", &opts()).expect("fan");
    assert_eq!(fan.triangles, 2);
}

#[test]
fn gltf_spiegelung_dreht_wicklung() {
    let nodes = "[{\"mesh\":0,\"scale\":[-1,1,1]}]";
    let m = import_mesh(gltf_quad(5, nodes, "", &data_uri()).as_bytes(), "q.gltf", &opts()).expect("import");
    assert!(all_up(&m.objects[0]));
}

#[test]
fn gltf_externe_bin() {
    let j = gltf_quad(5, "[{\"mesh\":0}]", "", "\"uri\":\"q%20x.bin\",");
    let e = import_mesh(j.as_bytes(), "q.gltf", &opts()).unwrap_err();
    assert!(e.contains("q x.bin"), "{e}");
    let o = Options { files: vec![("Q X.bin".into(), quad_buffer())], ..opts() };
    let m = import_mesh(j.as_bytes(), "q.gltf", &o).expect("import");
    assert_eq!(m.triangles, 2);
}

#[test]
fn gltf_ohne_indizes() {
    let j = gltf_quad(5, "[{\"mesh\":0}]", "", &data_uri()).replace(",\"indices\":1", "");
    let m = import_mesh(j.as_bytes(), "q.gltf", &opts()).expect("import");
    assert_eq!(m.triangles, 2);
}

#[test]
fn glb_aus_gltf_bauen_und_kuerzen() {
    let j = gltf_quad(5, "[{\"mesh\":0}]", "", "");
    let mut json = j.into_bytes();
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let bin = quad_buffer();
    let mut glb = b"glTF".to_vec();
    glb.extend(2u32.to_le_bytes());
    glb.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    glb.extend((json.len() as u32).to_le_bytes());
    glb.extend(0x4E4F534Au32.to_le_bytes());
    glb.extend(&json);
    glb.extend((bin.len() as u32).to_le_bytes());
    glb.extend(0x004E4942u32.to_le_bytes());
    glb.extend(&bin);
    let m = import_mesh(&glb, "q.glb", &opts()).expect("import");
    assert_eq!(m.triangles, 2);
    // Jede Kürzung ergibt einen Fehler oder ein Ergebnis, nie einen Panic.
    for n in 0..glb.len() {
        let _ = import_mesh(&glb[..n], "q.glb", &opts());
    }
}

#[test]
fn gltf_draco_abgelehnt() {
    let j = gltf_quad(4, "[{\"mesh\":0}]", ",\"extensionsRequired\":[\"KHR_draco_mesh_compression\"]", &data_uri());
    let e = import_mesh(j.as_bytes(), "q.gltf", &opts()).unwrap_err();
    assert!(e.contains("KHR_draco"), "{e}");
}

// ── Budget, kaputte Dateien, Kodierung ──────────────────────────────────────

#[test]
fn dreiecksbudget() {
    let (p, t) = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
    let (f, s) = flat(&[G { name: "K", rgba: None, pos: p, tris: t }]);
    let obj = export_obj(&f, &s).expect("obj");
    let m = import_mesh(obj.as_bytes(), "x.obj", &Options { max_triangles: 5, ..opts() }).expect("import");
    assert!(m.truncated);
    assert_eq!(m.triangles, 5);
}

#[test]
fn kaputte_dateien_ohne_panic() {
    let samples: Vec<(&str, Vec<u8>)> = vec![
        ("a.obj", b"f 1 2 3\nv 1\nv a b c\nf x/y/z 1 2\n".to_vec()),
        ("a.stl", b"solid\nfacet\nvertex 1 2\nendfacet\n".to_vec()),
        ("a.stl", vec![0u8; 84]),
        ("a.stl", {
            let mut v = vec![0u8; 84];
            v[80] = 255;
            v
        }),
        ("a.ply", b"ply\nformat ascii 1.0\nelement vertex 99999999999\nproperty float x\nend_header\n".to_vec()),
        (
            "a.ply",
            b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_index\nend_header\n\x00\x00".to_vec(),
        ),
        ("a.gltf", b"{\"asset\":{\"version\":\"2.0\"},\"nodes\":[{\"children\":[0]}],\"scenes\":[{\"nodes\":[0]}]}".to_vec()),
        ("a.gltf", b"{\"asset\":{\"version\":\"2.0\"},\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":7}}]}]}".to_vec()),
        ("a.gltf", b"{{{{{{{".to_vec()),
        ("a.gltf", "[".repeat(5000).into_bytes()),
        ("a.glb", b"glTF\x02\x00\x00\x00\xff\xff\xff\xff\xff\xff\xff\xff".to_vec()),
        ("a.bin", vec![1, 2, 3, 4]),
        ("a.obj", Vec::new()),
    ];
    for (n, b) in samples {
        let _ = import_mesh(&b, n, &opts());
    }
    let (p, t) = cuboid(0.0, 0.0, 0.0, 1.0, 1.0, 1.0);
    let (f, s) = flat(&[G { name: "K", rgba: Some([0.5; 4]), pos: p, tris: t }]);
    let obj = export_obj(&f, &s).expect("obj");
    for n in 0..obj.len() {
        let _ = import_mesh(&obj.as_bytes()[..n], "x.obj", &opts());
    }
    let stl = binary_stl(b"x", &[([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], 0)]);
    for n in 0..stl.len() {
        let _ = import_mesh(&stl[..n], "x.stl", &opts());
    }
    let mut ply = b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_index\nend_header\n".to_vec();
    for c in [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0] {
        ply.extend(c.to_le_bytes());
    }
    ply.push(3);
    for i in [0i32, 1, 2] {
        ply.extend(i.to_le_bytes());
    }
    assert_eq!(import_mesh(&ply, "x.ply", &opts()).expect("ply").triangles, 1);
    for n in 0..ply.len() {
        let _ = import_mesh(&ply[..n], "x.ply", &opts());
    }
}

#[test]
fn flache_kodierung() {
    let (f, s) = flat(&two_boxes());
    let m = import_mesh(&export_glb(&f, &s).expect("glb"), "x.glb", &opts()).expect("import");
    let (flat, strings) = encode(&m);
    assert_eq!(flat[0], FLAT_VERSION);
    assert_eq!(flat[1], 2.0);
    assert_eq!(flat[2], 1.0); // Y oben
    assert_eq!(flat[6], 24.0);
    assert_eq!(flat[11], 2.0);
    let name0 = strings[flat[12] as usize].clone();
    assert!(name0.starts_with("Wand_") || name0.starts_with("Stuetze_"));
    let expect: usize = 12 + m.objects.iter().map(|o| 9 + o.positions.len() + o.indices.len()).sum::<usize>();
    assert_eq!(flat.len(), expect);
}

#[test]
fn formaterkennung() {
    assert_eq!(detect_format(b"glTF....", "x.bin"), Some(Format::Gltf));
    assert_eq!(detect_format(b"ply\nformat", "x"), Some(Format::Ply));
    assert_eq!(detect_format(b"v 0 0 0\nf 1 1 1", "datei"), Some(Format::Obj));
    assert_eq!(detect_format(b"solid a\nfacet normal 0 0 1", "datei"), Some(Format::Stl));
    assert_eq!(detect_format(b"\x00\x01\x02", "x.dat"), None);
}
