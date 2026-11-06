//! Linienenden und -ecken ([146]): EINE Projekt-Einstellung (`Project.lineCap`/`lineJoin`) für alle
//! Ausgabewege — Bildschirm (render2d-Szene, GPU-Chunks), Plan-SVG, Druck-SVG/PDF, DXF. Über die
//! WASM-Grenze als kleine Zahl `cap | join << 2` (0 = flach + Gehrung, der Standard).

use crate::model::{LineCap, LineJoin, Project};

/// Gehrungsgrenze (Gehrungslänge / Strichbreite, wie SVG `stroke-miterlimit`); darüber gefast.
pub const MITER_LIMIT: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LineEnds {
    /// 0 flach (butt), 1 rund, 2 vorstehend (square).
    pub cap: u8,
    /// 0 Gehrung (miter), 1 rund, 2 gefast (bevel).
    pub join: u8,
}

impl LineEnds {
    pub fn of(p: &Project) -> Self {
        let cap = match p.line_cap {
            Some(LineCap::Round) => 1,
            Some(LineCap::Square) => 2,
            _ => 0,
        };
        let join = match p.line_join {
            Some(LineJoin::Round) => 1,
            Some(LineJoin::Bevel) => 2,
            _ => 0,
        };
        Self { cap, join }
    }
    /// Aus der Kodierung `cap | join << 2`; Unsinn (NaN, ausserhalb) → Standard.
    pub fn from_code(c: f64) -> Self {
        if !c.is_finite() || !(0.0..16.0).contains(&c) {
            return Self::default();
        }
        let c = c as u32;
        let cap = (c & 3) as u8;
        let join = ((c >> 2) & 3) as u8;
        Self { cap: if cap > 2 { 0 } else { cap }, join: if join > 2 { 0 } else { join } }
    }
    pub fn code(self) -> u32 {
        self.cap as u32 | (self.join as u32) << 2
    }
    pub fn svg_cap(self) -> &'static str {
        ["butt", "round", "square"][self.cap as usize]
    }
    pub fn svg_join(self) -> &'static str {
        ["miter", "round", "bevel"][self.join as usize]
    }
    /// SVG-Attribute für einen umschliessenden `<g>` (Kinder erben sie).
    pub fn svg_attrs(self) -> String {
        format!("stroke-linecap=\"{}\" stroke-linejoin=\"{}\" stroke-miterlimit=\"{}\"", self.svg_cap(), self.svg_join(), MITER_LIMIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kodierung_rundreise_und_unsinn() {
        for cap in 0..3 {
            for join in 0..3 {
                let e = LineEnds { cap, join };
                assert_eq!(LineEnds::from_code(e.code() as f64), e);
            }
        }
        assert_eq!(LineEnds::from_code(f64::NAN), LineEnds::default());
        assert_eq!(LineEnds::from_code(3.0), LineEnds::default());
        assert_eq!(LineEnds::from_code(-1.0), LineEnds::default());
        let mut p = Project::default();
        assert_eq!(LineEnds::of(&p), LineEnds { cap: 0, join: 0 });
        p.line_cap = Some(LineCap::Square);
        p.line_join = Some(LineJoin::Bevel);
        assert_eq!(LineEnds::of(&p).code(), 2 | 2 << 2);
        assert_eq!(LineEnds::of(&p).svg_attrs(), "stroke-linecap=\"square\" stroke-linejoin=\"bevel\" stroke-miterlimit=\"4\"");
    }
}
