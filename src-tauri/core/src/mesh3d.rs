//! Gemeinsame Mesh-Ausgabe der 3D-Ableitungen (`stairs3d`, `columns3d`): ein Dreiecksnetz je
//! Eingabeelement. `src` ist der Index des Elements in der Eingabe, damit `model3d` Farbe und Id
//! zuordnen kann.

pub struct Mesh {
    pub src: usize,
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
}
