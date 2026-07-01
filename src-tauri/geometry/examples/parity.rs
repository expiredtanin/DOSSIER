// Paritaets-Harness: liest ein JoinInput-JSON von stdin, rechnet compute_joins
// und schreibt das WallCuts-JSON nach stdout. Dient dem TS<->Rust-Vergleich
// (siehe src/compute/parity.test.ts) — identische Eingabe, identische Ausgabe.

use std::io::Read;

fn main() {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .expect("stdin lesen");
    let input: geometry::JoinInput = serde_json::from_str(&buf).expect("JoinInput parsen");
    let cuts = geometry::compute_joins(input);
    let out = serde_json::to_string(&cuts).expect("WallCuts serialisieren");
    println!("{out}");
}
