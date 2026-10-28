// BCF (BIM Collaboration Format, buildingSMART) 2.1 und 3.0: .bcfzip lesen und schreiben.
//
// Eigener Code nach der Spezifikation (github.com/buildingSMART/BCF-XML, Schemas markup.xsd, visinfo.xsd,
// project.xsd, version.xsd; dort CC BY-ND 4.0 — Beispieldateien liegen deshalb NICHT im Repo, der Test
// `buildingsmart_beispiele` liest sie nur, wenn `BCF_TESTCASES` auf ein lokales Klon-Verzeichnis zeigt).
// Fremde Crates: `zip` (MIT) und `quick-xml` (MIT), s. NOTICE.
//
// Datenmodell: Text (Themen, Kommentare, Viewpoints), Kamera und Komponenten-GUIDs. Die Grenze nach TS
// ist JSON (`bcf_read`/`bcf_write` unten, Feature "web"); Snapshots gehen als Base64-Text mit.
// Aufbau der Datei: `bcf.version` · `project.bcfp` (optional) · je Thema ein Ordner `<guid>/` mit
// `markup.bcf`, `*.bcfv` (Viewpoint) und `*.png`/`*.jpg` (Snapshot).
//
// Nicht abgebildet (beim Schreiben verworfen): BimSnippet, Dokument-Referenzen, verwandte Themen,
// Linien/Bitmaps und Farbgruppen der Viewpoints, `extensions.xml`/`documents.xml`.
//
// Kein Panic: Eingabe ist beliebig; alle Zugriffe laufen über `Result`, Grössen sind begrenzt.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};

/// Obergrenze je ZIP-Eintrag nach dem Entpacken (Schutz vor Zip-Bomben).
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Obergrenze der Themenzahl und der XML-Verschachtelung.
const MAX_TOPICS: usize = 100_000;
const MAX_DEPTH: usize = 64;

// ── Datenmodell ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BcfFile {
    /// "2.1" oder "3.0" (wie in der Datei; beim Schreiben wählt der Aufrufer).
    pub version: String,
    pub project_id: String,
    pub project_name: String,
    pub topics: Vec<Topic>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HeaderFile {
    pub ifc_project: String,
    pub ifc_spatial_structure_element: String,
    pub is_external: bool,
    pub filename: String,
    pub date: String,
    pub reference: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Topic {
    pub guid: String,
    pub topic_type: String,
    pub topic_status: String,
    pub title: String,
    pub priority: String,
    pub creation_date: String,
    pub creation_author: String,
    pub modified_date: String,
    pub modified_author: String,
    pub due_date: String,
    pub assigned_to: String,
    pub stage: String,
    pub description: String,
    pub labels: Vec<String>,
    pub header_files: Vec<HeaderFile>,
    pub comments: Vec<Comment>,
    pub viewpoints: Vec<Viewpoint>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Comment {
    pub guid: String,
    pub date: String,
    pub author: String,
    pub comment: String,
    /// Guid des zugehörigen Viewpoints (leer = keiner).
    pub viewpoint_guid: String,
    pub modified_date: String,
    pub modified_author: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Viewpoint {
    pub guid: String,
    /// Dateiname im Themenordner (`*.bcfv`); leer = beim Schreiben erzeugen.
    pub file: String,
    /// Dateiname des Snapshots (`*.png`/`*.jpg`); leer = beim Schreiben erzeugen.
    pub snapshot_file: String,
    /// Snapshot als Base64 (leer = keiner).
    pub snapshot: String,
    pub camera: Option<Camera>,
    pub selection: Vec<Component>,
    /// `DefaultVisibility`: true = alles sichtbar ausser `exceptions`, false = alles unsichtbar ausser `exceptions`.
    pub default_visibility: bool,
    pub exceptions: Vec<Component>,
    pub clipping_planes: Vec<ClippingPlane>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Camera {
    /// "perspective" oder "orthogonal".
    pub kind: String,
    pub position: [f64; 3],
    pub direction: [f64; 3],
    pub up: [f64; 3],
    /// Vertikaler Öffnungswinkel in Grad (perspektivisch).
    pub field_of_view: f64,
    /// Massstab Ansicht→Welt (orthogonal).
    pub view_to_world_scale: f64,
    pub aspect_ratio: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Component {
    /// 22-stellige IFC-GlobalId.
    pub ifc_guid: String,
    pub originating_system: String,
    pub authoring_tool_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClippingPlane {
    pub location: [f64; 3],
    pub direction: [f64; 3],
}

// ── Base64 (Snapshots) ──────────────────────────────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return None,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ── XML lesen: einfacher Baum ───────────────────────────────────────────────

#[derive(Debug, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }
    fn kids<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        self.children.iter().filter(move |c| c.name == name)
    }
    fn attr(&self, name: &str) -> &str {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()).unwrap_or("")
    }
    /// Text eines Kindelements (getrimmt), leer wenn es fehlt.
    fn text_of(&self, name: &str) -> String {
        self.child(name).map(|c| c.text.trim().to_string()).unwrap_or_default()
    }
}

fn local(name: &[u8]) -> String {
    let s = String::from_utf8_lossy(name);
    match s.rfind(':') {
        Some(i) => s[i + 1..].to_string(),
        None => s.into_owned(),
    }
}

/// XML → Baum (Namensräume/Präfixe werden verworfen). Fehler bei kaputtem XML oder zu tiefer Verschachtelung.
fn parse_xml(bytes: &[u8]) -> Result<Node, String> {
    // BOM überspringen.
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let mut reader = Reader::from_reader(bytes);
    let mut stack: Vec<Node> = vec![Node::default()];
    let mut root: Option<Node> = None;
    loop {
        let ev = reader.read_event().map_err(|e| format!("XML: {e}"))?;
        match ev {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let mut node = Node { name: local(e.name().as_ref()), ..Node::default() };
                for a in e.attributes().flatten() {
                    let v = a.unescape_value().map(|c| c.into_owned()).unwrap_or_default();
                    node.attrs.push((local(a.key.as_ref()), v));
                }
                stack.push(node);
                if stack.len() > MAX_DEPTH {
                    return Err("XML: zu tief verschachtelt".into());
                }
                // Empty-Elemente haben kein End-Ereignis: sofort schliessen (s. unten, Event::Empty-Zweig).
                if matches!(ev, Event::Empty(_)) {
                    close(&mut stack, &mut root)?;
                }
            }
            Event::End(_) => close(&mut stack, &mut root)?,
            Event::Text(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&t.decode().map_err(|e| format!("XML: {e}"))?);
                }
            }
            Event::CData(t) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&String::from_utf8_lossy(&t));
                }
            }
            Event::GeneralRef(r) => {
                let name = String::from_utf8_lossy(&r).into_owned();
                let ch = match r.resolve_char_ref() {
                    Ok(Some(c)) => Some(c.to_string()),
                    _ => quick_xml::escape::resolve_predefined_entity(&name).map(str::to_string),
                };
                if let (Some(s), Some(top)) = (ch, stack.last_mut()) {
                    top.text.push_str(&s);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("XML: Element nicht geschlossen".into());
    }
    root.ok_or_else(|| "XML: leeres Dokument".to_string())
}

fn close(stack: &mut Vec<Node>, root: &mut Option<Node>) -> Result<(), String> {
    if stack.len() < 2 {
        return Err("XML: schliessendes Element ohne Anfang".into());
    }
    let node = stack.pop().unwrap_or_default();
    if stack.len() >= 2 {
        if let Some(parent) = stack.last_mut() {
            parent.children.push(node);
        }
    } else if root.is_some() {
        return Err("XML: mehrere Wurzelelemente".into());
    } else {
        *root = Some(node);
    }
    Ok(())
}

// ── Lesen ───────────────────────────────────────────────────────────────────

fn num(s: &str) -> f64 {
    match s.trim().parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => 0.0,
    }
}

fn point(n: Option<&Node>) -> [f64; 3] {
    match n {
        Some(n) => [num(&n.text_of("X")), num(&n.text_of("Y")), num(&n.text_of("Z"))],
        None => [0.0; 3],
    }
}

fn parse_components(list: Option<&Node>) -> Vec<Component> {
    let Some(list) = list else { return Vec::new() };
    list.kids("Component")
        .map(|c| Component {
            ifc_guid: c.attr("IfcGuid").to_string(),
            originating_system: c.text_of("OriginatingSystem"),
            authoring_tool_id: c.text_of("AuthoringToolId"),
        })
        .filter(|c| !c.ifc_guid.is_empty())
        .collect()
}

fn parse_viewpoint(xml: &[u8], vp: &mut Viewpoint) -> Result<(), String> {
    let root = parse_xml(xml)?;
    if root.name != "VisualizationInfo" {
        return Err(format!("Viewpoint: Wurzel \"{}\" statt VisualizationInfo", root.name));
    }
    if vp.guid.is_empty() {
        vp.guid = root.attr("Guid").to_string();
    }
    vp.default_visibility = true;
    if let Some(comps) = root.child("Components") {
        vp.selection = parse_components(comps.child("Selection"));
        if let Some(vis) = comps.child("Visibility") {
            vp.default_visibility = !vis.attr("DefaultVisibility").eq_ignore_ascii_case("false");
            vp.exceptions = parse_components(vis.child("Exceptions"));
        }
    }
    let cam = |n: &Node, kind: &str| Camera {
        kind: kind.to_string(),
        position: point(n.child("CameraViewPoint")),
        direction: point(n.child("CameraDirection")),
        up: point(n.child("CameraUpVector")),
        field_of_view: num(&n.text_of("FieldOfView")),
        view_to_world_scale: num(&n.text_of("ViewToWorldScale")),
        aspect_ratio: num(&n.text_of("AspectRatio")),
    };
    vp.camera = root
        .child("PerspectiveCamera")
        .map(|n| cam(n, "perspective"))
        .or_else(|| root.child("OrthogonalCamera").map(|n| cam(n, "orthogonal")));
    if let Some(planes) = root.child("ClippingPlanes") {
        vp.clipping_planes = planes
            .kids("ClippingPlane")
            .map(|p| ClippingPlane { location: point(p.child("Location")), direction: point(p.child("Direction")) })
            .collect();
    }
    Ok(())
}

fn parse_header_files(header: &Node) -> Vec<HeaderFile> {
    // 2.1: Header > File; 3.0: Header > Files > File.
    let mut out = Vec::new();
    let mut collect = |parent: &Node| {
        for f in parent.kids("File") {
            out.push(HeaderFile {
                ifc_project: f.attr("IfcProject").to_string(),
                ifc_spatial_structure_element: f.attr("IfcSpatialStructureElement").to_string(),
                is_external: !f.attr("IsExternal").eq_ignore_ascii_case("false"),
                filename: f.text_of("Filename"),
                date: f.text_of("Date"),
                reference: f.text_of("Reference"),
            });
        }
    };
    collect(header);
    if let Some(files) = header.child("Files") {
        collect(files);
    }
    out
}

fn parse_comment(c: &Node) -> Comment {
    Comment {
        guid: c.attr("Guid").to_string(),
        date: c.text_of("Date"),
        author: c.text_of("Author"),
        comment: c.text_of("Comment"),
        viewpoint_guid: c.child("Viewpoint").map(|v| v.attr("Guid").to_string()).unwrap_or_default(),
        modified_date: c.text_of("ModifiedDate"),
        modified_author: c.text_of("ModifiedAuthor"),
    }
}

/// Gibt den Eintrag `name` relativ zum Themenordner zurück (Pfade mit `..` und absolute werden verworfen).
fn read_entry(files: &HashMap<String, Vec<u8>>, dir: &str, name: &str) -> Option<Vec<u8>> {
    let name = name.trim().replace('\\', "/");
    if name.is_empty() || name.starts_with('/') || name.split('/').any(|p| p == "..") {
        return None;
    }
    files.get(&format!("{dir}{name}")).cloned().or_else(|| files.get(&name).cloned())
}

fn parse_topic(markup: &[u8], dir: &str, files: &HashMap<String, Vec<u8>>) -> Result<Topic, String> {
    let root = parse_xml(markup)?;
    if root.name != "Markup" {
        return Err(format!("markup.bcf: Wurzel \"{}\" statt Markup", root.name));
    }
    let tn = root.child("Topic").ok_or("markup.bcf: Topic fehlt")?;
    let mut t = Topic {
        guid: tn.attr("Guid").to_string(),
        topic_type: tn.attr("TopicType").to_string(),
        topic_status: tn.attr("TopicStatus").to_string(),
        title: tn.text_of("Title"),
        priority: tn.text_of("Priority"),
        creation_date: tn.text_of("CreationDate"),
        creation_author: tn.text_of("CreationAuthor"),
        modified_date: tn.text_of("ModifiedDate"),
        modified_author: tn.text_of("ModifiedAuthor"),
        due_date: tn.text_of("DueDate"),
        assigned_to: tn.text_of("AssignedTo"),
        stage: tn.text_of("Stage"),
        description: tn.text_of("Description"),
        ..Topic::default()
    };
    if t.guid.is_empty() {
        return Err("markup.bcf: Topic ohne Guid".into());
    }
    if let Some(h) = root.child("Header") {
        t.header_files = parse_header_files(h);
    }
    // Labels: 2.1 mehrfach <Labels>text</Labels>; 3.0 <Labels><Label>…</Label></Labels>.
    for l in tn.kids("Labels") {
        let inner: Vec<&Node> = l.kids("Label").collect();
        if inner.is_empty() {
            let s = l.text.trim();
            if !s.is_empty() {
                t.labels.push(s.to_string());
            }
        }
        for n in inner {
            let s = n.text.trim();
            if !s.is_empty() {
                t.labels.push(s.to_string());
            }
        }
    }
    // Kommentare: 2.1 direkt unter Markup, 3.0 unter Topic > Comments.
    for c in root.kids("Comment") {
        t.comments.push(parse_comment(c));
    }
    for cs in tn.kids("Comments") {
        for c in cs.kids("Comment") {
            t.comments.push(parse_comment(c));
        }
    }
    // Viewpoints: 2.1 Markup > Viewpoints (je Eintrag), 3.0 Topic > Viewpoints > ViewPoint.
    let mut entries: Vec<&Node> = Vec::new();
    for v in root.kids("Viewpoints") {
        entries.push(v);
    }
    for vs in tn.kids("Viewpoints") {
        let inner: Vec<&Node> = vs.kids("ViewPoint").collect();
        if inner.is_empty() { entries.push(vs) } else { entries.extend(inner) }
    }
    for e in entries {
        let mut vp = Viewpoint {
            guid: e.attr("Guid").to_string(),
            file: e.text_of("Viewpoint"),
            snapshot_file: e.text_of("Snapshot"),
            default_visibility: true,
            ..Viewpoint::default()
        };
        if vp.file.is_empty() && !vp.snapshot_file.is_empty() {
            // Nur Snapshot, kein Viewpoint-Dokument: Eintrag behalten.
        } else if vp.file.is_empty() {
            continue;
        }
        if !vp.file.is_empty() {
            if let Some(xml) = read_entry(files, dir, &vp.file) {
                // Kaputte Viewpoint-Datei: Thema bleibt lesbar, der Viewpoint ohne Kamera.
                let _ = parse_viewpoint(&xml, &mut vp);
            }
        }
        if !vp.snapshot_file.is_empty() {
            if let Some(png) = read_entry(files, dir, &vp.snapshot_file) {
                vp.snapshot = b64_encode(&png);
            }
        }
        t.viewpoints.push(vp);
    }
    Ok(t)
}

/// .bcfzip lesen. Fehler bei Unsinn (kein ZIP, weder `bcf.version` noch ein `markup.bcf`, kaputtes Markup).
pub fn read_bcf(bytes: &[u8]) -> Result<BcfFile, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Keine BCF-Datei (ZIP): {e}"))?;
    let mut files: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        let mut buf = Vec::new();
        entry.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut buf).map_err(|e| format!("ZIP-Eintrag {name}: {e}"))?;
        if buf.len() as u64 > MAX_ENTRY_BYTES {
            return Err(format!("ZIP-Eintrag {name} ist zu gross"));
        }
        files.insert(name, buf);
    }
    let mut out = BcfFile::default();
    if let Some(v) = files.get("bcf.version") {
        if let Ok(root) = parse_xml(v) {
            out.version = root.attr("VersionId").to_string();
        }
    }
    let mut markups: Vec<&String> = files
        .keys()
        .filter(|k| k.ends_with("/markup.bcf") && k.matches('/').count() == 1)
        .collect();
    markups.sort();
    if out.version.is_empty() && markups.is_empty() {
        return Err("Keine BCF-Datei: weder bcf.version noch markup.bcf gefunden".into());
    }
    if markups.len() > MAX_TOPICS {
        return Err("Zu viele Themen".into());
    }
    if let Some(p) = files.get("project.bcfp") {
        if let Ok(root) = parse_xml(p) {
            if let Some(pr) = root.child("Project") {
                out.project_id = pr.attr("ProjectId").to_string();
                out.project_name = pr.text_of("Name");
            }
        }
    }
    for key in markups {
        let dir = &key[..key.len() - "markup.bcf".len()];
        let topic = parse_topic(&files[key], dir, &files).map_err(|e| format!("{key}: {e}"))?;
        out.topics.push(topic);
    }
    if out.version.is_empty() {
        out.version = "2.1".into();
    }
    Ok(out)
}

// ── Schreiben ───────────────────────────────────────────────────────────────

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            // In XML 1.0 unzulässige Steuerzeichen weglassen.
            c if (c as u32) < 0x20 && c != '\n' && c != '\r' && c != '\t' => {}
            c => o.push(c),
        }
    }
    o
}

/// Schreibt `<name>text</name>`, nur wenn `text` nicht leer ist.
fn leaf(out: &mut String, ind: usize, name: &str, text: &str) {
    if !text.is_empty() {
        out.push_str(&format!("{:ind$}<{name}>{}</{name}>\n", "", esc(text), ind = ind));
    }
}

fn f(v: f64) -> String {
    if v.is_finite() { format!("{v}") } else { "0".into() }
}

fn xyz(out: &mut String, ind: usize, name: &str, p: &[f64; 3]) {
    out.push_str(&format!("{:ind$}<{name}>\n", "", ind = ind));
    for (n, v) in ["X", "Y", "Z"].iter().zip(p) {
        out.push_str(&format!("{:ind$}<{n}>{}</{n}>\n", "", f(*v), ind = ind + 2));
    }
    out.push_str(&format!("{:ind$}</{name}>\n", "", ind = ind));
}

fn components(out: &mut String, ind: usize, list: &[Component]) {
    for c in list {
        if c.ifc_guid.is_empty() {
            continue;
        }
        out.push_str(&format!("{:ind$}<Component IfcGuid=\"{}\">\n", "", esc(&c.ifc_guid), ind = ind));
        leaf(out, ind + 2, "OriginatingSystem", &c.originating_system);
        leaf(out, ind + 2, "AuthoringToolId", &c.authoring_tool_id);
        out.push_str(&format!("{:ind$}</Component>\n", "", ind = ind));
    }
}

fn viewpoint_xml(vp: &Viewpoint) -> String {
    let mut o = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    o.push_str(&format!("<VisualizationInfo Guid=\"{}\">\n", esc(&vp.guid)));
    o.push_str("  <Components>\n");
    if vp.selection.is_empty() {
        o.push_str("    <Selection/>\n");
    } else {
        o.push_str("    <Selection>\n");
        components(&mut o, 6, &vp.selection);
        o.push_str("    </Selection>\n");
    }
    o.push_str(&format!("    <Visibility DefaultVisibility=\"{}\">\n", vp.default_visibility));
    if vp.exceptions.is_empty() {
        o.push_str("      <Exceptions/>\n");
    } else {
        o.push_str("      <Exceptions>\n");
        components(&mut o, 8, &vp.exceptions);
        o.push_str("      </Exceptions>\n");
    }
    o.push_str("    </Visibility>\n  </Components>\n");
    if let Some(c) = &vp.camera {
        let ortho = c.kind == "orthogonal";
        let tag = if ortho { "OrthogonalCamera" } else { "PerspectiveCamera" };
        o.push_str(&format!("  <{tag}>\n"));
        xyz(&mut o, 4, "CameraViewPoint", &c.position);
        xyz(&mut o, 4, "CameraDirection", &c.direction);
        xyz(&mut o, 4, "CameraUpVector", &c.up);
        if ortho {
            o.push_str(&format!("    <ViewToWorldScale>{}</ViewToWorldScale>\n", f(c.view_to_world_scale)));
        } else {
            o.push_str(&format!("    <FieldOfView>{}</FieldOfView>\n", f(if c.field_of_view > 0.0 { c.field_of_view } else { 60.0 })));
        }
        if c.aspect_ratio > 0.0 && !ortho {
            o.push_str(&format!("    <AspectRatio>{}</AspectRatio>\n", f(c.aspect_ratio)));
        }
        o.push_str(&format!("  </{tag}>\n"));
    }
    if !vp.clipping_planes.is_empty() {
        o.push_str("  <ClippingPlanes>\n");
        for p in &vp.clipping_planes {
            o.push_str("    <ClippingPlane>\n");
            xyz(&mut o, 6, "Location", &p.location);
            xyz(&mut o, 6, "Direction", &p.direction);
            o.push_str("    </ClippingPlane>\n");
        }
        o.push_str("  </ClippingPlanes>\n");
    }
    o.push_str("</VisualizationInfo>\n");
    o
}

/// Eine sichere Datei-Namenskomponente (keine Pfadtrenner).
fn safe_name(s: &str) -> bool {
    !s.is_empty() && !s.contains(['/', '\\']) && s != ".." && s != "."
}

fn markup_xml(t: &Topic, v3: bool, vp_files: &[(String, String)]) -> String {
    let mut o = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Markup>\n");
    if !t.header_files.is_empty() {
        o.push_str("  <Header>\n");
        let ind = if v3 { 6 } else { 4 };
        if v3 {
            o.push_str("    <Files>\n");
        }
        for h in &t.header_files {
            let mut attrs = String::new();
            if !h.ifc_project.is_empty() {
                attrs.push_str(&format!(" IfcProject=\"{}\"", esc(&h.ifc_project)));
            }
            if !h.ifc_spatial_structure_element.is_empty() {
                attrs.push_str(&format!(" IfcSpatialStructureElement=\"{}\"", esc(&h.ifc_spatial_structure_element)));
            }
            attrs.push_str(&format!(" IsExternal=\"{}\"", h.is_external));
            o.push_str(&format!("{:ind$}<File{attrs}>\n", "", ind = ind));
            leaf(&mut o, ind + 2, "Filename", &h.filename);
            leaf(&mut o, ind + 2, "Date", &h.date);
            leaf(&mut o, ind + 2, "Reference", &h.reference);
            o.push_str(&format!("{:ind$}</File>\n", "", ind = ind));
        }
        if v3 {
            o.push_str("    </Files>\n");
        }
        o.push_str("  </Header>\n");
    }
    let ty = if t.topic_type.is_empty() { "Issue" } else { &t.topic_type };
    let st = if t.topic_status.is_empty() { "Open" } else { &t.topic_status };
    o.push_str(&format!("  <Topic Guid=\"{}\" TopicType=\"{}\" TopicStatus=\"{}\">\n", esc(&t.guid), esc(ty), esc(st)));
    leaf(&mut o, 4, "Title", if t.title.is_empty() { "-" } else { &t.title });
    leaf(&mut o, 4, "Priority", &t.priority);
    // Labels: 2.1 mehrfach <Labels>, 3.0 <Labels><Label/></Labels>.
    if v3 {
        if !t.labels.is_empty() {
            o.push_str("    <Labels>\n");
            for l in &t.labels {
                leaf(&mut o, 6, "Label", l);
            }
            o.push_str("    </Labels>\n");
        }
    } else {
        for l in &t.labels {
            leaf(&mut o, 4, "Labels", l);
        }
    }
    leaf(&mut o, 4, "CreationDate", if t.creation_date.is_empty() { "1970-01-01T00:00:00Z" } else { &t.creation_date });
    leaf(&mut o, 4, "CreationAuthor", if t.creation_author.is_empty() { "-" } else { &t.creation_author });
    leaf(&mut o, 4, "ModifiedDate", &t.modified_date);
    leaf(&mut o, 4, "ModifiedAuthor", &t.modified_author);
    leaf(&mut o, 4, "DueDate", &t.due_date);
    leaf(&mut o, 4, "AssignedTo", &t.assigned_to);
    leaf(&mut o, 4, "Stage", &t.stage);
    leaf(&mut o, 4, "Description", &t.description);

    let comment = |o: &mut String, ind: usize, c: &Comment| {
        o.push_str(&format!("{:ind$}<Comment Guid=\"{}\">\n", "", esc(&c.guid), ind = ind));
        if !v3 {
            leaf(o, ind + 2, "VerbalStatus", "");
        }
        leaf(o, ind + 2, "Date", if c.date.is_empty() { "1970-01-01T00:00:00Z" } else { &c.date });
        leaf(o, ind + 2, "Author", if c.author.is_empty() { "-" } else { &c.author });
        leaf(o, ind + 2, "Comment", &c.comment);
        if !c.viewpoint_guid.is_empty() {
            o.push_str(&format!("{:ind$}<Viewpoint Guid=\"{}\"/>\n", "", esc(&c.viewpoint_guid), ind = ind + 2));
        }
        leaf(o, ind + 2, "ModifiedDate", &c.modified_date);
        leaf(o, ind + 2, "ModifiedAuthor", &c.modified_author);
        o.push_str(&format!("{:ind$}</Comment>\n", "", ind = ind));
    };
    let vpoint = |o: &mut String, ind: usize, vp: &Viewpoint, file: &str, snap: &str| {
        let tag = if v3 { "ViewPoint" } else { "Viewpoints" };
        o.push_str(&format!("{:ind$}<{tag} Guid=\"{}\">\n", "", esc(&vp.guid), ind = ind));
        leaf(o, ind + 2, "Viewpoint", file);
        leaf(o, ind + 2, "Snapshot", snap);
        o.push_str(&format!("{:ind$}</{tag}>\n", "", ind = ind));
    };
    if v3 {
        if !t.comments.is_empty() {
            o.push_str("    <Comments>\n");
            for c in &t.comments {
                comment(&mut o, 6, c);
            }
            o.push_str("    </Comments>\n");
        }
        if !t.viewpoints.is_empty() {
            o.push_str("    <Viewpoints>\n");
            for (vp, (file, snap)) in t.viewpoints.iter().zip(vp_files) {
                vpoint(&mut o, 6, vp, file, snap);
            }
            o.push_str("    </Viewpoints>\n");
        }
        o.push_str("  </Topic>\n");
    } else {
        o.push_str("  </Topic>\n");
        for c in &t.comments {
            comment(&mut o, 2, c);
        }
        for (vp, (file, snap)) in t.viewpoints.iter().zip(vp_files) {
            vpoint(&mut o, 2, vp, file, snap);
        }
    }
    o.push_str("</Markup>\n");
    o
}

/// BCF als .bcfzip schreiben; `version` "2.1" oder "3.0".
pub fn write_bcf(file: &BcfFile, version: &str) -> Result<Vec<u8>, String> {
    let v3 = match version {
        "2.1" => false,
        "3.0" => true,
        v => return Err(format!("BCF-Version {v} wird nicht unterstützt (2.1 oder 3.0)")),
    };
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut put = |name: &str, data: &[u8]| -> Result<(), String> {
        zip.start_file(name, opts).map_err(|e| format!("ZIP: {e}"))?;
        zip.write_all(data).map_err(|e| format!("ZIP: {e}"))
    };

    put(
        "bcf.version",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Version VersionId=\"{version}\">\n  <DetailedVersion>{version}</DetailedVersion>\n</Version>\n"
        )
        .as_bytes(),
    )?;
    if !file.project_id.is_empty() {
        let proj = format!(
            "  <Project ProjectId=\"{}\">\n    <Name>{}</Name>\n  </Project>\n",
            esc(&file.project_id),
            esc(&file.project_name)
        );
        let root = if v3 { "ProjectInfo" } else { "ProjectExtension" };
        put("project.bcfp", format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<{root}>\n{proj}</{root}>\n").as_bytes())?;
    }
    let mut seen = std::collections::HashSet::new();
    for t in &file.topics {
        if !safe_name(&t.guid) || !seen.insert(t.guid.clone()) {
            return Err(format!("Thema mit ungültiger oder doppelter Guid \"{}\"", t.guid));
        }
        let dir = format!("{}/", t.guid);
        let mut names: Vec<(String, String)> = Vec::new();
        for (i, vp) in t.viewpoints.iter().enumerate() {
            let base = if safe_name(&vp.guid) { vp.guid.clone() } else { format!("vp{i}") };
            let bytes = b64_decode(&vp.snapshot).unwrap_or_default();
            let vfile = if safe_name(&vp.file) { vp.file.clone() } else { format!("viewpoint-{base}.bcfv") };
            let sfile = if bytes.is_empty() {
                String::new()
            } else if safe_name(&vp.snapshot_file) {
                vp.snapshot_file.clone()
            } else {
                format!("snapshot-{base}.png")
            };
            put(&format!("{dir}{vfile}"), viewpoint_xml(vp).as_bytes())?;
            if !sfile.is_empty() {
                put(&format!("{dir}{sfile}"), &bytes)?;
            }
            names.push((vfile, sfile));
        }
        put(&format!("{dir}markup.bcf"), markup_xml(t, v3, &names).as_bytes())?;
    }
    zip.finish().map(|c| c.into_inner()).map_err(|e| format!("ZIP: {e}"))
}

// ── JSON-Grenze (WASM) ──────────────────────────────────────────────────────

#[cfg(feature = "web")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// .bcfzip → JSON (`BcfFile`); JS-Fehler mit Meldung bei Unsinn.
    #[wasm_bindgen]
    pub fn bcf_read(bytes: &[u8]) -> Result<String, JsValue> {
        let f = super::read_bcf(bytes).map_err(|e| JsValue::from_str(&e))?;
        serde_json::to_string(&f).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// JSON (`BcfFile`) → .bcfzip der Version "2.1" oder "3.0"; JS-Fehler bei Unsinn.
    #[wasm_bindgen]
    pub fn bcf_write(json: &str, version: &str) -> Result<Vec<u8>, JsValue> {
        let f: super::BcfFile = serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("BCF-JSON: {e}")))?;
        super::write_bcf(&f, version).map_err(|e| JsValue::from_str(&e))
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> BcfFile {
        let png = vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4, 5];
        BcfFile {
            version: "3.0".into(),
            project_id: "p-1".into(),
            project_name: "Haus <A> & Co".into(),
            topics: vec![Topic {
                guid: "11111111-2222-3333-4444-555555555555".into(),
                topic_type: "Clash".into(),
                topic_status: "Active".into(),
                title: "Wand \"W1\" kollidiert".into(),
                priority: "High".into(),
                creation_date: "2026-10-28T10:00:00Z".into(),
                creation_author: "karim@example.ch".into(),
                modified_date: "2026-10-28T11:00:00Z".into(),
                modified_author: "anna@example.ch".into(),
                due_date: "2026-11-01T00:00:00Z".into(),
                assigned_to: "anna@example.ch".into(),
                stage: "Entwurf".into(),
                description: "Zeile 1\nZeile 2 mit ü und <tag>".into(),
                labels: vec!["Statik".into(), "Brandschutz".into()],
                header_files: vec![HeaderFile {
                    ifc_project: "0n_zVrPdE0cg_UxWSd1GmA".into(),
                    filename: "haus.ifc".into(),
                    is_external: false,
                    ..HeaderFile::default()
                }],
                comments: vec![Comment {
                    guid: "c1".into(),
                    date: "2026-10-28T10:05:00Z".into(),
                    author: "anna@example.ch".into(),
                    comment: "Bitte prüfen & bestätigen".into(),
                    viewpoint_guid: "vp-1".into(),
                    ..Comment::default()
                }],
                viewpoints: vec![Viewpoint {
                    guid: "vp-1".into(),
                    file: String::new(),
                    snapshot_file: String::new(),
                    snapshot: b64_encode(&png),
                    camera: Some(Camera {
                        kind: "perspective".into(),
                        position: [1.5, -2.0, 3.25],
                        direction: [0.0, 1.0, 0.0],
                        up: [0.0, 0.0, 1.0],
                        field_of_view: 55.0,
                        aspect_ratio: 1.6,
                        ..Camera::default()
                    }),
                    selection: vec![Component { ifc_guid: "0n_zVrPdE0cg_UxWSd1GmA".into(), originating_system: "Dossier".into(), ..Component::default() }],
                    default_visibility: false,
                    exceptions: vec![Component { ifc_guid: "3rG4QSmdUCaBHFz1QMCvjw".into(), ..Component::default() }],
                    clipping_planes: vec![ClippingPlane { location: [0.0, 0.0, 1.2], direction: [0.0, 0.0, -1.0] }],
                }],
            }],
        }
    }

    /// Erwartet nach dem Schreiben: Dateinamen sind erzeugt worden.
    fn normalize(mut f: BcfFile) -> BcfFile {
        for t in &mut f.topics {
            for v in &mut t.viewpoints {
                v.file.clear();
                v.snapshot_file.clear();
            }
        }
        f
    }

    #[test]
    fn rundreise_beide_versionen() {
        for ver in ["2.1", "3.0"] {
            let src = sample();
            let bytes = write_bcf(&src, ver).unwrap();
            let back = read_bcf(&bytes).unwrap();
            assert_eq!(back.version, ver);
            assert_eq!(back.project_id, "p-1");
            assert_eq!(back.project_name, "Haus <A> & Co");
            let (a, b) = (&src.topics[0], &back.topics[0]);
            assert_eq!(normalize(BcfFile { topics: vec![b.clone()], ..BcfFile::default() }).topics[0].viewpoints[0], a.viewpoints[0], "Viewpoint {ver}");
            let mut b2 = b.clone();
            for v in &mut b2.viewpoints {
                v.file.clear();
                v.snapshot_file.clear();
            }
            assert_eq!(&b2, a, "Thema {ver}");
        }
    }

    #[test]
    fn snapshot_bytes_bleiben_erhalten() {
        let bytes = write_bcf(&sample(), "2.1").unwrap();
        let back = read_bcf(&bytes).unwrap();
        assert_eq!(b64_decode(&back.topics[0].viewpoints[0].snapshot).unwrap(), vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4, 5]);
    }

    #[test]
    fn orthogonale_kamera() {
        let mut f = sample();
        f.topics[0].viewpoints[0].camera =
            Some(Camera { kind: "orthogonal".into(), view_to_world_scale: 12.5, direction: [0.0, 0.0, -1.0], up: [0.0, 1.0, 0.0], ..Camera::default() });
        for ver in ["2.1", "3.0"] {
            let back = read_bcf(&write_bcf(&f, ver).unwrap()).unwrap();
            let c = back.topics[0].viewpoints[0].camera.clone().unwrap();
            assert_eq!(c.kind, "orthogonal");
            assert_eq!(c.view_to_world_scale, 12.5);
        }
    }

    #[test]
    fn unsinn_ergibt_fehler() {
        assert!(read_bcf(b"").is_err());
        assert!(read_bcf(b"kein zip").is_err());
        assert!(read_bcf(&[0x50, 0x4b, 0x03, 0x04, 0, 0, 0]).is_err());
        // ZIP ohne BCF-Inhalt.
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        z.start_file("x.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"hi").unwrap();
        let bytes = z.finish().unwrap().into_inner();
        assert!(read_bcf(&bytes).is_err());
        // Kaputtes Markup.
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        z.start_file("a/markup.bcf", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"<Markup><Topic Guid='a'></Markup>").unwrap();
        let bytes = z.finish().unwrap().into_inner();
        assert!(read_bcf(&bytes).is_err());
        // Zufällige Bytes dürfen nie paniken.
        let mut s = 12345u32;
        for n in 0..200 {
            let junk: Vec<u8> = (0..n * 7).map(|_| { s = s.wrapping_mul(1664525).wrapping_add(1013904223); (s >> 24) as u8 }).collect();
            let _ = read_bcf(&junk);
        }
    }

    #[test]
    fn schreiben_prueft_eingabe() {
        assert!(write_bcf(&sample(), "9.9").is_err());
        let mut f = sample();
        f.topics[0].guid = "../x".into();
        assert!(write_bcf(&f, "2.1").is_err());
        let mut g = sample();
        g.topics.push(g.topics[0].clone());
        assert!(write_bcf(&g, "2.1").is_err());
        // Kaputtes Base64 und Steuerzeichen paniken nicht.
        let mut h = sample();
        h.topics[0].viewpoints[0].snapshot = "!!!".into();
        h.topics[0].description = "a\u{1}b".into();
        let back = read_bcf(&write_bcf(&h, "3.0").unwrap()).unwrap();
        assert_eq!(back.topics[0].description, "ab");
    }

    #[test]
    fn tief_verschachteltes_xml_wird_abgelehnt() {
        let xml = format!("{}{}", "<a>".repeat(200), "</a>".repeat(200));
        assert!(parse_xml(xml.as_bytes()).is_err());
    }

    #[test]
    fn base64_rundreise() {
        for n in 0..20u8 {
            let d: Vec<u8> = (0..n).collect();
            assert_eq!(b64_decode(&b64_encode(&d)).unwrap(), d);
        }
        assert_eq!(b64_encode(b"Man"), "TWFu");
        assert!(b64_decode("a$b").is_none());
    }

    /// buildingSMART-Beispiele (CC BY-ND 4.0, nicht im Repo): `BCF_TESTCASES=<Klon>/"Test Cases"`.
    #[test]
    fn buildingsmart_beispiele() {
        let Ok(dir) = std::env::var("BCF_TESTCASES") else { return };
        let (mut n, mut cams, mut sels) = (0, 0, 0);
        let mut stack = vec![std::path::PathBuf::from(dir)];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    if p.file_name().is_some_and(|f| f == "unzipped") { continue }
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "bcf" || x == "bcfzip") {
                    let bytes = std::fs::read(&p).unwrap();
                    let f = read_bcf(&bytes).unwrap_or_else(|err| panic!("{}: {err}", p.display()));
                    assert!(!f.topics.is_empty(), "{}: keine Themen", p.display());
                    for t in &f.topics {
                        assert!(!t.guid.is_empty() && !t.title.is_empty(), "{}", p.display());
                    }
                    for v in f.topics.iter().flat_map(|t| &t.viewpoints) {
                        cams += usize::from(v.camera.is_some());
                        sels += usize::from(!v.selection.is_empty());
                    }
                    // Rundreise in beide Versionen bleibt lesbar.
                    for ver in ["2.1", "3.0"] {
                        let back = read_bcf(&write_bcf(&f, ver).unwrap()).unwrap();
                        assert_eq!(back.topics.len(), f.topics.len());
                        assert_eq!(back.topics[0].title, f.topics[0].title);
                        assert_eq!(back.topics[0].viewpoints.len(), f.topics[0].viewpoints.len());
                    }
                    n += 1;
                }
            }
        }
        eprintln!("{n} buildingSMART-Dateien gelesen, {cams} Kameras, {sels} Viewpoints mit Auswahl");
        assert!(n > 0 && cams > 0 && sels > 0);
    }
}
