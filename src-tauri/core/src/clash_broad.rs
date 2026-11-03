//! Kollisionsprüfung, Vorstufe ([128], vorher `candidatePairs` in `analysis/clash.ts`): welche Bauteil-Paare
//! kommen für die genaue Prüfung (truck, `solid_clash`) in Frage. Nur Hüllquader (AABB) — die Feinprüfung bleibt
//! in `trucksolid`. Wand↔Wand und Wand↔Decke greifen konstruktiv ineinander und werden gar nicht erst geprüft:
//! mindestens ein Teil des Paars muss ein „freier" Körper sein.
//!
//! Kodierung (flach, `Float64Array`): je Bauteil 8 Werte `[frei (0/1), Gruppe, minx, miny, minz, maxx, maxy, maxz]`.
//! Bauteile gleicher `Gruppe` (gleiche Ursprungs-id, z. B. mehrere Wandschichten) werden nicht gegeneinander
//! geprüft. Ergebnis: `[i0, j0, i1, j1, …]` mit `i < j`, in Reihenfolge (i aussen, j innen).

/// Toleranz der Überlappung (m): bündige Flächen und Rundung zählen nicht.
pub const EPS: f64 = 0.002;

const STRIDE: usize = 8;

fn overlaps(a: &[f64], b: &[f64]) -> bool {
    // a, b = [min3, max3]; Vergleiche wie in TS (NaN → false)
    (0..3).all(|k| a[k] < b[3 + k] - EPS && b[k] < a[3 + k] - EPS)
}

/// Zu prüfende Paare (Indizes) aus dem flachen Puffer; ein kaputter Puffer (Länge kein Vielfaches von 8) ergibt `[]`.
pub fn candidate_pairs(f: &[f64]) -> Vec<f64> {
    if f.len() % STRIDE != 0 {
        return Vec::new();
    }
    let items: Vec<&[f64]> = f.chunks_exact(STRIDE).collect();
    let mut out = Vec::new();
    for i in 0..items.len() {
        for j in (i + 1)..items.len() {
            let (a, b) = (items[i], items[j]);
            if a[0] == 0.0 && b[0] == 0.0 {
                continue;
            }
            if a[1] == b[1] {
                continue;
            }
            if overlaps(&a[2..8], &b[2..8]) {
                out.push(i as f64);
                out.push(j as f64);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(free: bool, group: f64, x0: f64, x1: f64) -> [f64; 8] {
        [if free { 1.0 } else { 0.0 }, group, x0, 0.0, 0.0, x1, 1.0, 1.0]
    }

    fn flat(items: &[[f64; 8]]) -> Vec<f64> {
        items.iter().flatten().copied().collect()
    }

    #[test]
    fn nur_paare_mit_freiem_koerper_und_ueberlappender_huelle() {
        let f = flat(&[item(false, 0.0, 0.0, 2.0), item(false, 1.0, 1.0, 3.0), item(true, 2.0, 1.5, 2.5), item(true, 3.0, 5.0, 6.0)]);
        assert_eq!(candidate_pairs(&f), vec![0.0, 2.0, 1.0, 2.0]);
    }

    #[test]
    fn gleiche_gruppe_und_beruehrung_zaehlen_nicht() {
        let f = flat(&[item(true, 7.0, 0.0, 2.0), item(false, 7.0, 0.0, 2.0)]);
        assert!(candidate_pairs(&f).is_empty());
        // Überlappung unter EPS gilt als Berührung
        let g = flat(&[item(true, 0.0, 0.0, 1.0), item(true, 1.0, 0.999, 2.0)]);
        assert!(candidate_pairs(&g).is_empty());
        let h = flat(&[item(true, 0.0, 0.0, 1.0), item(true, 1.0, 0.99, 2.0)]);
        assert_eq!(candidate_pairs(&h), vec![0.0, 1.0]);
    }

    #[test]
    fn kaputte_eingabe_und_nan() {
        assert!(candidate_pairs(&[1.0, 2.0, 3.0]).is_empty());
        assert!(candidate_pairs(&[]).is_empty());
        let mut a = item(true, 0.0, 0.0, 1.0);
        a[2] = f64::NAN;
        assert!(candidate_pairs(&flat(&[a, item(true, 1.0, 0.0, 1.0)])).is_empty());
    }
}
