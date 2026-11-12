//! Leser über den flachen `f64`-Puffer und die Zeichenketten-Tabelle (Datensätze, Punkte, Netze, Schichten, Eigenschaften); gerufen von `build_ifc`.
//! Teil von `ifc_export` (aus `ifc_export.rs` aufgeteilt, [164]).

use super::*;

// ── Eingabe ─────────────────────────────────────────────────────────────────

pub(super) struct Reader<'a> {
    pub(super) buf: &'a [f64],
    pub(super) pos: usize,
    pub(super) strings: Vec<&'a str>,
}

impl<'a> Reader<'a> {
    pub(super) fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }
    pub(super) fn raw(&mut self) -> Result<f64, String> {
        let v = *self
            .buf
            .get(self.pos)
            .ok_or_else(|| format!("Puffer abgeschnitten bei {}", self.pos))?;
        self.pos += 1;
        Ok(v)
    }
    /// Endliche Zahl.
    pub(super) fn f(&mut self) -> Result<f64, String> {
        let v = self.raw()?;
        if !v.is_finite() {
            return Err(format!("Zahl ist NaN/∞ bei {}", self.pos - 1));
        }
        Ok(v)
    }
    /// Nicht-negative Ganzzahl (Index, Anzahl).
    pub(super) fn idx(&mut self) -> Result<usize, String> {
        let v = self.raw()?;
        if !v.is_finite() || v < 0.0 || v.fract() != 0.0 || v > u32::MAX as f64 {
            return Err(format!("ungültiger Index {v} bei {}", self.pos - 1));
        }
        Ok(v as usize)
    }
    pub(super) fn flag(&mut self) -> Result<bool, String> {
        Ok(self.idx()? != 0)
    }
    /// Index oder −1.
    fn opt_idx(&mut self) -> Result<Option<usize>, String> {
        let v = self.raw()?;
        if v == -1.0 {
            return Ok(None);
        }
        if !v.is_finite() || v < 0.0 || v.fract() != 0.0 || v > u32::MAX as f64 {
            return Err(format!("ungültiger Index {v} bei {}", self.pos - 1));
        }
        Ok(Some(v as usize))
    }
    pub(super) fn string(&mut self) -> Result<String, String> {
        let i = self.idx()?;
        self.strings
            .get(i)
            .map(|s| (*s).to_string())
            .ok_or_else(|| format!("Zeichenketten-Index {i} ausserhalb ({})", self.strings.len()))
    }
    pub(super) fn opt_string(&mut self) -> Result<Option<String>, String> {
        match self.opt_idx()? {
            None => Ok(None),
            Some(i) => self
                .strings
                .get(i)
                .map(|s| Some((*s).to_string()))
                .ok_or_else(|| format!("Zeichenketten-Index {i} ausserhalb ({})", self.strings.len())),
        }
    }
    pub(super) fn take(&mut self, n: usize) -> Result<&'a [f64], String> {
        let end = self.pos.checked_add(n).ok_or("Überlauf")?;
        let s = self
            .buf
            .get(self.pos..end)
            .ok_or_else(|| format!("Puffer abgeschnitten bei {}", self.pos))?;
        self.pos = end;
        if s.iter().any(|v| !v.is_finite()) {
            return Err(format!("Zahl ist NaN/∞ vor {}", self.pos));
        }
        Ok(s)
    }
    /// Struktur: Geschoss-Index (geprüft gegen `n_storeys`) oder −1 = Gebäude.
    pub(super) fn structure(&mut self, n_storeys: usize) -> Result<i64, String> {
        match self.opt_idx()? {
            None => Ok(-1),
            Some(i) if i < n_storeys => Ok(i as i64),
            Some(i) => Err(format!("Geschoss-Index {i} ausserhalb ({n_storeys})")),
        }
    }
    pub(super) fn pts(&mut self) -> Result<Vec<(f64, f64)>, String> {
        let n = self.idx()?;
        let s = self.take(n.checked_mul(2).ok_or("Überlauf")?)?;
        Ok(s.chunks_exact(2).map(|c| (c[0], c[1])).collect())
    }
    /// [191] Ring mit Bögen: n, (x, y, bulge) × n.
    pub(super) fn bpts(&mut self) -> Result<Vec<(f64, f64, f64)>, String> {
        let n = self.idx()?;
        let s = self.take(n.checked_mul(3).ok_or("Überlauf")?)?;
        Ok(s.chunks_exact(3).map(|c| (c[0], c[1], c[2])).collect())
    }
    /// Optionaler Wert: has (0/1), value.
    fn opt_f(&mut self) -> Result<Option<f64>, String> {
        let has = self.flag()?;
        let v = self.f()?;
        Ok(has.then_some(v))
    }
    /// FILL-Parameter einer Tür/eines Fensters (s. Kopf; Geometrie in `ifc_openings.rs`).
    pub(super) fn fill_params(&mut self, is_door: bool) -> Result<FillParams, String> {
        let (sx, sy, ex, ey) = (self.f()?, self.f()?, self.f()?, self.f()?);
        let (from, to, z_bottom, z_top) = (self.f()?, self.f()?, self.f()?, self.f()?);
        let (n_lo, n_hi) = (self.f()?, self.f()?);
        let (frame_depth, inset) = (self.opt_f()?, self.opt_f()?);
        let inset_outside = self.flag()?;
        let frame_width = self.opt_f()?;
        let wing_count = self.f()?;
        let panes = self.idx()?;
        if !(1..=3).contains(&panes) {
            return Err(format!("Scheibenzahl {panes} bei {}", self.pos - 1));
        }
        let n = self.idx()?;
        if n > MAX_SASHES {
            return Err(format!("zu viele Flügel ({n}) bei {}", self.pos - 1));
        }
        let mut sashes = Vec::with_capacity(n);
        for _ in 0..n {
            let post = self.flag()?;
            let post_width = self.opt_f()?;
            let fixed = self.flag()?;
            let width = self.opt_f()?;
            sashes.push(Sash { post, post_width, fixed, width });
        }
        let door_kind = match self.idx()? {
            0 => DoorKind::Swing,
            1 => DoorKind::Sliding,
            2 => DoorKind::WallOpening,
            3 => DoorKind::DoubleSwing,
            k => return Err(format!("unbekannte Türart {k} bei {}", self.pos - 1)),
        };
        let leaf_count = self.f()?;
        let (swing_sign, dir_sign) = (self.f()?, self.f()?);
        if swing_sign.abs() != 1.0 || dir_sign.abs() != 1.0 {
            return Err(format!("Aufschlag nicht ±1 bei {}", self.pos - 1));
        }
        let hinge_at_start = self.flag()?;
        let transom_height = self.f()?;
        let glazed = self.flag()?;
        let glazing_ratio = self.opt_f()?;
        Ok(FillParams {
            wall_start: (sx, sy),
            wall_end: (ex, ey),
            from,
            to,
            z_bottom,
            z_top,
            n_lo,
            n_hi,
            is_door,
            frame_depth,
            inset,
            inset_outside,
            frame_width,
            wing_count,
            panes,
            sashes,
            door_kind,
            leaf_count,
            swing_sign,
            dir_sign,
            hinge_at_start,
            transom_height,
            glazed,
            glazing_ratio,
        })
    }
    pub(super) fn mesh(&mut self) -> Result<Mesh, String> {
        let nv = self.idx()?;
        let positions = self.take(nv.checked_mul(3).ok_or("Überlauf")?)?.to_vec();
        let nt = self.idx()?;
        let n_idx = nt.checked_mul(3).ok_or("Überlauf")?;
        let raw = self.take(n_idx)?;
        let mut indices = Vec::with_capacity(n_idx);
        for &v in raw {
            if v < 0.0 || v.fract() != 0.0 || v >= nv as f64 {
                return Err(format!("Dreiecks-Index {v} ausserhalb ({nv} Punkte)"));
            }
            indices.push(v as usize);
        }
        let closed = self.flag()?;
        Ok(Mesh { positions, indices, closed })
    }
    /// Treppenlauf (s. Kopf, STAIR).
    pub(super) fn stair_flight(&mut self) -> Result<StairFlight, String> {
        let name = self.string()?;
        let risers = self.idx()?;
        let treads = self.idx()?;
        let riser_height = self.f()?;
        let tread_length = self.f()?;
        let predefined = self.string()?;
        let psets = self.psets()?;
        let shape = match self.idx()? {
            0 => {
                let n = self.idx()?;
                let mut solids = Vec::new();
                for _ in 0..n {
                    let pts = self.pts()?;
                    solids.push((pts, self.f()?, self.f()?));
                }
                FlightShape::Solids(solids)
            }
            1 => FlightShape::Mesh(self.mesh()?),
            k => return Err(format!("unbekannte Lauf-Form {k}")),
        };
        Ok(StairFlight { name, risers, treads, riser_height, tread_length, predefined, psets, shape })
    }
    /// Podest (s. Kopf, STAIR).
    pub(super) fn stair_landing(&mut self) -> Result<StairLanding, String> {
        let name = self.string()?;
        let pts = self.pts()?;
        let (z_rel, depth) = (self.f()?, self.f()?);
        let psets = self.psets()?;
        Ok(StairLanding { name, pts, z_rel, depth, psets })
    }
    /// Geländer (s. Kopf, STAIR).
    pub(super) fn stair_rail(&mut self) -> Result<StairRail, String> {
        let name = self.string()?;
        let predefined = self.string()?;
        let psets = self.psets()?;
        let mesh = self.mesh()?;
        Ok(StairRail { name, predefined, psets, mesh })
    }
    pub(super) fn type_ref(&mut self) -> Result<Option<TypeRef>, String> {
        if !self.flag()? {
            return Ok(None);
        }
        let kind = match self.idx()? {
            0 => TypeKind::Wall,
            1 => TypeKind::Slab,
            2 => TypeKind::Roof,
            k => return Err(format!("unbekannte Typart {k}")),
        };
        let id = self.string()?;
        let name = self.string()?;
        let predefined = self.string()?;
        let n = self.idx()?;
        let mut layers = Vec::new();
        for _ in 0..n {
            let component_id = self.string()?;
            let component_name = self.string()?;
            let thickness = self.raw()?; // NaN → 0 (wie TS)
            layers.push(Layer { component_id, component_name, thickness });
        }
        Ok(Some(TypeRef { kind, id, name, predefined, layers }))
    }
    pub(super) fn psets(&mut self) -> Result<Vec<Pset>, String> {
        let n = self.idx()?;
        let mut out = Vec::new();
        for _ in 0..n {
            let name = self.string()?;
            let np = self.idx()?;
            let mut props = Vec::new();
            for _ in 0..np {
                let pname = self.string()?;
                let value = match self.idx()? {
                    0 => PropVal::Ident(self.string()?),
                    1 => PropVal::Bool(self.flag()?),
                    2 => PropVal::Ratio(self.f()?),
                    6 => PropVal::Label(self.string()?),
                    7 => PropVal::Thermal(self.f()?),
                    3 => PropVal::Length(self.f()?),
                    4 => PropVal::Area(self.f()?),
                    5 => PropVal::Volume(self.f()?),
                    k => return Err(format!("unbekannte Eigenschaftsart {k}")),
                };
                props.push((pname, value));
            }
            out.push(Pset { name, props });
        }
        Ok(out)
    }
}
