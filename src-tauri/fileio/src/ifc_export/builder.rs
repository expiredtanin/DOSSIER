//! Entitäten-Schreiber `Builder` mit allem Zustand (Entitätszähler, Geschosse, Typen, Psets, Beziehungen) und den Methoden, die einzelne IFC-Entitäten ausgeben; gerufen von `build_ifc`.
//! Teil von `ifc_export` (aus `ifc_export.rs` aufgeteilt, [164]).

use super::*;

/// Entitäten-Schreiber mit allem Zustand, den die TS-Fassung in Closures hielt.
pub(super) struct Builder {
    pub(super) lines: Vec<String>,
    pub(super) schema: Schema,
    pub(super) project_id: String,
    pub(super) owner_history: usize,
    pub(super) context: usize,
    pub(super) identity_axis: usize,
    pub(super) extrude_dir: usize,
    pub(super) building_entity: usize,
    pub(super) building_placement: usize,
    pub(super) storeys: Vec<Storey>,
    /// Eingliederung je Struktur (−1 = Gebäude), in Reihenfolge des ersten Auftretens.
    pub(super) containment: Vec<(i64, Vec<usize>)>,
    pub(super) psets: Vec<PsetAcc>,
    pub(super) pset_index: HashMap<String, usize>,
    pub(super) qtos: Vec<QtoAcc>,
    pub(super) materials: HashMap<String, usize>,
    pub(super) types: Vec<TypeAcc>,
    pub(super) type_index: HashMap<String, usize>,
    /// Wand-id → (Entität, Placement, Wandsystem) für die Öffnungen.
    pub(super) walls: HashMap<String, (usize, usize, Frame)>,
    /// Oberflächenstil je Teilrolle (Rahmen, Blatt, Glas), beim ersten Gebrauch angelegt (0 = noch nicht).
    pub(super) styles: [usize; 3],
    /// Untergeordneter Kontext „Axis“ (GRAPH_VIEW), beim ersten Gebrauch angelegt (0 = noch nicht).
    pub(super) axis_context: usize,

    pub(super) spaces: Vec<(i64, Vec<usize>)>,
    pub(super) column_materials: Vec<(String, String, Vec<usize>)>,
    /// Bauteil-Schlüssel (wie für die GlobalId, z. B. `wall/<id>`) → Entität; Ziel von Klassifikation/Zone/Attach.
    pub(super) elements: HashMap<String, usize>,
    /// IFC2x3: Türen/Fenster je (Tür?, Ausführung) → Bauteile; am Ende je ein IfcDoorStyle/IfcWindowStyle.
    pub(super) fill_styles: Vec<(bool, String, Vec<usize>)>,
}

impl Builder {
    /// Ausgabe im Schema IFC2x3?
    pub(super) fn v2(&self) -> bool {
        self.schema == Schema::Ifc2x3
    }

    /// Schreibt eine neue Entity-Zeile und liefert ihre Nummer.
    pub(super) fn add(&mut self, ty: &str, params: String) -> usize {
        let id = self.lines.len() + 1;
        self.lines.push(format!("#{id}={ty}({params});"));
        id
    }

    /// Dauerhafte GlobalId (als STEP-String) aus `<Art>/<id>[/<Zusatz>]`, im Namensraum des Projekts.
    pub(super) fn gid(&self, key: &str) -> String {
        ifc_string(&ifc_guid(&format!("{}/{key}", self.project_id)))
    }

    pub(super) fn placement_of(&self, structure: i64) -> usize {
        if structure < 0 {
            self.building_placement
        } else {
            self.storeys[structure as usize].placement
        }
    }

    pub(super) fn entity_of(&self, structure: i64) -> usize {
        if structure < 0 {
            self.building_entity
        } else {
            self.storeys[structure as usize].entity
        }
    }

    pub(super) fn key_of(&self, structure: i64) -> String {
        if structure < 0 {
            "building".to_string()
        } else {
            format!("storey/{}", self.storeys[structure as usize].id)
        }
    }

    pub(super) fn add_to_containment(&mut self, structure: i64, element: usize) {
        if let Some((_, v)) = self.containment.iter_mut().find(|(s, _)| *s == structure) {
            v.push(element);
        } else {
            self.containment.push((structure, vec![element]));
        }
    }

    /// Eigenschaftssatz vormerken: gleicher Inhalt ⇒ EIN Pset für alle Bauteile (GUID aus dem Inhalt).
    ///
    /// Basismengen (`Qto_…`) sind dagegen je Bauteil eigen: `owner_key` (Schlüssel des Bauteils, wie für
    /// seine GlobalId) bestimmt die GUIDs von Menge und Beziehung.
    pub(super) fn add_pset(&mut self, pset: &Pset, element: usize, owner_key: &str) {
        if pset.props.is_empty() {
            return; // IfcPropertySet verlangt mindestens eine Eigenschaft
        }
        if pset.name.starts_with("Qto_") || pset.name.starts_with("CH_Qto_") || pset.name.starts_with("Dossier_Qto_") {
            let quantities: Vec<(&'static str, String, f64)> = pset
                .props
                .iter()
                .filter_map(|(n, v)| v.quantity().map(|(ty, x)| (ty, n.clone(), x)))
                .collect();
            if !quantities.is_empty() {
                self.qtos.push(QtoAcc { owner_key: owner_key.to_string(), name: pset.name.clone(), quantities, element });
            }
            return;
        }
        let props: Vec<(String, String)> = pset.props.iter().map(|(n, v)| (n.clone(), v.expr())).collect();
        // Schlüssel wie in der TS-Fassung: `<Name>/<JSON der [Name, Wert]-Paare>`.
        let json: Vec<String> = props
            .iter()
            .map(|(n, v)| format!("[{},{}]", json_str(n), json_str(v)))
            .collect();
        let key = format!("{}/[{}]", pset.name, json.join(","));
        if let Some(&i) = self.pset_index.get(&key) {
            self.psets[i].related.push(element);
        } else {
            self.pset_index.insert(key.clone(), self.psets.len());
            self.psets.push(PsetAcc { name: pset.name.clone(), key, props, related: vec![element] });
        }
    }

    /// Offener Linienzug als IfcPolyline.
    pub(super) fn emit_open_polyline(&mut self, pts: &[(f64, f64)]) -> usize {
        let ids: Vec<usize> = pts.iter().map(|p| self.add("IFCCARTESIANPOINT", list(&[fmt_real(p.0), fmt_real(p.1)]))).collect();
        self.add("IFCPOLYLINE", refs(&ids))
    }

    /// Geschlossener Linienzug (erster Punkt am Ende wiederholt) als IfcPolyline.
    pub(super) fn emit_closed_polyline(&mut self, ring: &[(f64, f64)]) -> usize {
        let mut pt_ids = Vec::with_capacity(ring.len() + 1);
        for p in ring.iter().chain(ring.first()) {
            let id = self.add("IFCCARTESIANPOINT", list(&[fmt_real(p.0), fmt_real(p.1)]));
            pt_ids.push(id);
        }
        self.add("IFCPOLYLINE", refs(&pt_ids))
    }

    /// Profil (geschlossenes Polygon) als IfcExtrudedAreaSolid, Unterkante `z_rel` in `+Z`.
    pub(super) fn emit_extrusion(&mut self, footprint: &[(f64, f64)], z_rel: f64, depth: f64) -> usize {
        self.emit_extrusion_voids(footprint, &[], z_rel, depth)
    }

    /// Wie {@link emit_extrusion}, mit inneren Ringen (Aussparungen) als IfcArbitraryProfileDefWithVoids.
    fn emit_extrusion_voids(&mut self, footprint: &[(f64, f64)], inner: &[Vec<(f64, f64)>], z_rel: f64, depth: f64) -> usize {
        let polyline = self.emit_closed_polyline(footprint);
        let profile = if inner.is_empty() {
            self.add("IFCARBITRARYCLOSEDPROFILEDEF", format!("{},$,#{polyline}", enum_("AREA")))
        } else {
            let holes: Vec<usize> = inner.iter().map(|ring| self.emit_closed_polyline(ring)).collect();
            self.add("IFCARBITRARYPROFILEDEFWITHVOIDS", format!("{},$,#{polyline},{}", enum_("AREA"), refs(&holes)))
        };
        let mut position = self.identity_axis;
        if z_rel != 0.0 {
            let pt = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(z_rel)]));
            position = self.add("IFCAXIS2PLACEMENT3D", format!("#{pt},$,$"));
        }
        self.add(
            "IFCEXTRUDEDAREASOLID",
            format!("#{profile},#{position},#{},{}", self.extrude_dir, fmt_real(depth.max(0.001))),
        )
    }

    /// Placement im Abstand `z_rel` über `relative_to`.
    pub(super) fn emit_placement(&mut self, z_rel: f64, relative_to: usize) -> usize {
        let origin = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(z_rel)]));
        let axis = self.add("IFCAXIS2PLACEMENT3D", format!("#{origin},$,$"));
        self.add("IFCLOCALPLACEMENT", format!("#{relative_to},#{axis}"))
    }

    /// Placement am Punkt (`frame.ox`, `frame.oy`, 0) mit gedrehter X-Achse relativ zu `relative_to`.
    pub(super) fn emit_placement_frame(&mut self, frame: &Frame, relative_to: usize) -> usize {
        let origin = self.add("IFCCARTESIANPOINT", list(&[fmt_real(frame.ox), fmt_real(frame.oy), fmt_real(0.0)]));
        let dir = self.add("IFCDIRECTION", list(&[fmt_real(frame.ux), fmt_real(frame.uy), fmt_real(0.0)]));
        // IFC4: Axis und RefDirection stehen nur zusammen (Axis = +Z).
        let axis = self.add("IFCAXIS2PLACEMENT3D", format!("#{origin},#{},#{dir}", self.extrude_dir));
        self.add("IFCLOCALPLACEMENT", format!("#{relative_to},#{axis}"))
    }

    /// Oberflächenstil der Teilrolle (einmal je Datei): IfcSurfaceStyle mit IfcSurfaceStyleRendering.
    fn part_style(&mut self, role: usize) -> usize {
        if self.styles[role] == 0 {
            let (name, rgb, transparency) = PART_STYLES[role];
            let colour = self.add("IFCCOLOURRGB", format!("$,{},{},{}", fmt_real(rgb[0]), fmt_real(rgb[1]), fmt_real(rgb[2])));
            let rendering = self.add(
                "IFCSURFACESTYLERENDERING",
                format!("#{colour},{},$,$,$,$,$,$,{}", fmt_real(transparency), enum_("NOTDEFINED")),
            );
            let style = self.add(
                "IFCSURFACESTYLE",
                format!("{},{},{}", ifc_string(name), enum_("BOTH"), refs(&[rendering])),
            );
            // IFC2x3: IfcStyledItem.Styles verlangt IfcPresentationStyleAssignment (in IFC4 direkt der Stil).
            self.styles[role] = if self.v2() { self.add("IFCPRESENTATIONSTYLEASSIGNMENT", refs(&[style])) } else { style };
        }
        self.styles[role]
    }

    /// Körper einer Tür/eines Fensters: je Teil eine Extrusion mit eigenem Stil, alle in EINER
    /// SweptSolid-Darstellung (getrennte Körper im selben Bauteil). Profile kommen im Füllungssystem.
    pub(super) fn emit_parts_shape(&mut self, parts: &[Part], frame: &Frame) -> usize {
        let mut solids = Vec::with_capacity(parts.len());
        for p in parts {
            let solid = self.emit_extrusion(&frame.local_pts(&p.pts), p.z_rel, p.depth);
            let style = self.part_style(p.role);
            self.add("IFCSTYLEDITEM", format!("#{solid},{},$", refs(&[style])));
            solids.push(solid);
        }
        self.emit_swept_shape(&solids)
    }

    /// Untergeordneter Darstellungskontext „Axis“ (GRAPH_VIEW), einmal je Datei.
    fn axis_context(&mut self) -> usize {
        if self.axis_context == 0 {
            self.axis_context = self.add(
                "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
                format!("{},{},*,*,*,*,#{},$,{},$", ifc_string("Axis"), ifc_string("Model"), self.context, enum_("GRAPH_VIEW")),
            );
        }
        self.axis_context
    }

    /// Wand-Darstellung: „Axis“ (IfcPolyline 0 … `len` in lokal X) und „Body“ (SweptSolid aus `solids`).
    pub(super) fn emit_wall_shape(&mut self, solids: &[usize], len: f64) -> usize {
        let p0 = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0)]));
        let p1 = self.add("IFCCARTESIANPOINT", list(&[fmt_real(len), fmt_real(0.0)]));
        let curve = self.add("IFCPOLYLINE", refs(&[p0, p1]));
        let axis_ctx = self.axis_context();
        let axis = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{axis_ctx},{},{},{}", ifc_string("Axis"), ifc_string("Curve2D"), refs(&[curve])),
        );
        let body = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string("SweptSolid"), refs(solids)),
        );
        self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[axis, body])))
    }

    /// SweptSolid-Körper aus Extrusionen.
    pub(super) fn emit_swept_shape(&mut self, solids: &[usize]) -> usize {
        let rep = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string("SweptSolid"), refs(solids)),
        );
        self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[rep])))
    }

    /// Profil+Extrusion+Shape+Placement für einen geschlossenen Footprint; liefert (Placement, Shape).
    pub(super) fn emit_box_product(&mut self, footprint: &[(f64, f64)], z_bottom_rel: f64, depth: f64, relative_to: usize) -> (usize, usize) {
        self.emit_box_product_voids(footprint, &[], z_bottom_rel, depth, relative_to)
    }

    /// Wie {@link emit_box_product}, mit Aussparungen im Profil.
    pub(super) fn emit_box_product_voids(&mut self, footprint: &[(f64, f64)], inner: &[Vec<(f64, f64)>], z_bottom_rel: f64, depth: f64, relative_to: usize) -> (usize, usize) {
        let solid = self.emit_extrusion_voids(footprint, inner, 0.0, depth);
        let shape = self.emit_swept_shape(&[solid]);
        let placement = self.emit_placement(z_bottom_rel, relative_to);
        (placement, shape)
    }

    /// Dreiecks-Mesh als IfcTriangulatedFaceSet (IFC2x3: IfcFacetedBrep bzw. IfcShellBasedSurfaceModel) +
    /// Shape + Placement (Punkte tragen die Geometrie absolut im Rahmen der Trägerstruktur).
    pub(super) fn emit_triangulated_product(&mut self, mesh: &Mesh, relative_to: usize) -> (usize, usize) {
        let (item, rep_type) = if self.v2() { self.emit_face_brep(mesh) } else { (self.emit_face_set(mesh), "Tessellation") };
        let rep = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string(rep_type), refs(&[item])),
        );
        let shape = self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[rep])));
        let placement = self.emit_placement(0.0, relative_to);
        (placement, shape)
    }

    /// Bogenwand ([T2]): Netz-Körper wie [`Self::emit_triangulated_product`] plus Achse als
    /// IfcTrimmedCurve (IfcCircle, Parameter = Winkel im Bogenmass).
    pub(super) fn emit_arc_wall_product(&mut self, mesh: &Mesh, axis: (f64, f64, f64, f64, f64), relative_to: usize) -> (usize, usize) {
        let (item, rep_type) = if self.v2() { self.emit_face_brep(mesh) } else { (self.emit_face_set(mesh), "Tessellation") };
        let body = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string(rep_type), refs(&[item])),
        );
        let axis = self.emit_arc_axis(axis);
        let shape = self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[axis, body])));
        let placement = self.emit_placement(0.0, relative_to);
        (placement, shape)
    }

    /// Bogenwand als Profil-Extrusion ([T2], WALL_ARC_SOLID): „Axis" (Kreisbogen) und „Body" (SweptSolid).
    pub(super) fn emit_arc_wall_solid_product(&mut self, solids: &[usize], axis: (f64, f64, f64, f64, f64), relative_to: usize) -> (usize, usize) {
        let body = self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{},{},{},{}", self.context, ifc_string("Body"), ifc_string("SweptSolid"), refs(solids)),
        );
        let axis = self.emit_arc_axis(axis);
        let shape = self.add("IFCPRODUCTDEFINITIONSHAPE", format!("$,$,{}", refs(&[axis, body])));
        let placement = self.emit_placement(0.0, relative_to);
        (placement, shape)
    }

    /// Profil aus Ecken mit Bulge (zur nächsten Ecke; DXF-Sinn) als IfcCompositeCurve → IfcExtrudedAreaSolid.
    pub(super) fn emit_bulge_extrusion(&mut self, ring: &[(f64, f64, f64)], z_rel: f64, depth: f64) -> usize {
        let n = ring.len();
        let mut segs = Vec::with_capacity(n);
        for i in 0..n {
            let (x0, y0, b) = ring[i];
            let (x1, y1, _) = ring[(i + 1) % n];
            let p0 = self.add("IFCCARTESIANPOINT", list(&[fmt_real(x0), fmt_real(y0)]));
            let p1 = self.add("IFCCARTESIANPOINT", list(&[fmt_real(x1), fmt_real(y1)]));
            let (dx, dy) = (x1 - x0, y1 - y0);
            let l = (dx * dx + dy * dy).sqrt();
            let curve = if b.abs() < 1e-9 || !(l > 1e-12) {
                self.add("IFCPOLYLINE", refs(&[p0, p1]))
            } else {
                // Mitte links der Sehne im Abstand (L/2)·(1 − b²)/(2b); Radius (L/2)·(1 + b²)/(2|b|).
                let k = (1.0 - b * b) / (2.0 * b) / 2.0;
                let (cx, cy) = ((x0 + x1) / 2.0 - dy * k, (y0 + y1) / 2.0 + dx * k);
                let r = l / 2.0 * (1.0 + b * b) / (2.0 * b.abs());
                let c = self.add("IFCCARTESIANPOINT", list(&[fmt_real(cx), fmt_real(cy)]));
                let pl = self.add("IFCAXIS2PLACEMENT2D", format!("#{c},$"));
                let circle = self.add("IFCCIRCLE", format!("#{pl},{}", fmt_real(r)));
                self.add("IFCTRIMMEDCURVE", format!("#{circle},(#{p0}),(#{p1}),{},{}", if b > 0.0 { ".T." } else { ".F." }, enum_("CARTESIAN")))
            };
            segs.push(self.add("IFCCOMPOSITECURVESEGMENT", format!("{},.T.,#{curve}", enum_("CONTINUOUS"))));
        }
        let cc = self.add("IFCCOMPOSITECURVE", format!("{},.F.", refs(&segs)));
        let profile = self.add("IFCARBITRARYCLOSEDPROFILEDEF", format!("{},$,#{cc}", enum_("AREA")));
        let mut position = self.identity_axis;
        if z_rel != 0.0 {
            let pt = self.add("IFCCARTESIANPOINT", list(&[fmt_real(0.0), fmt_real(0.0), fmt_real(z_rel)]));
            position = self.add("IFCAXIS2PLACEMENT3D", format!("#{pt},$,$"));
        }
        self.add("IFCEXTRUDEDAREASOLID", format!("#{profile},#{position},#{},{}", self.extrude_dir, fmt_real(depth.max(0.001))))
    }

    /// Achse einer Bogenwand: IfcTrimmedCurve auf IfcCircle (Parameter = Winkel im Bogenmass).
    fn emit_arc_axis(&mut self, (cx, cy, r, a0, sweep): (f64, f64, f64, f64, f64)) -> usize {
        let c = self.add("IFCCARTESIANPOINT", list(&[fmt_real(cx), fmt_real(cy)]));
        let pl = self.add("IFCAXIS2PLACEMENT2D", format!("#{c},$"));
        let circle = self.add("IFCCIRCLE", format!("#{pl},{}", fmt_real(r)));
        let tau = std::f64::consts::TAU;
        let norm = |a: f64| ((a % tau) + tau) % tau;
        let (t1, t2) = (norm(a0), norm(a0 + sweep));
        let trimmed = self.add(
            "IFCTRIMMEDCURVE",
            format!(
                "#{circle},(IFCPARAMETERVALUE({})),(IFCPARAMETERVALUE({})),{},{}",
                fmt_real(t1),
                fmt_real(t2),
                if sweep > 0.0 { ".T." } else { ".F." },
                enum_("PARAMETER")
            ),
        );
        let axis_ctx = self.axis_context();
        self.add(
            "IFCSHAPEREPRESENTATION",
            format!("#{axis_ctx},{},{},{}", ifc_string("Axis"), ifc_string("Curve2D"), refs(&[trimmed])),
        )
    }

    pub(super) fn emit_face_set(&mut self, mesh: &Mesh) -> usize {
        let coords: Vec<String> = mesh
            .positions
            .chunks_exact(3)
            .map(|c| format!("({},{},{})", fmt_real(c[0]), fmt_real(c[1]), fmt_real(c[2])))
            .collect();
        let point_list = self.add("IFCCARTESIANPOINTLIST3D", format!("({})", coords.join(",")));
        let tris: Vec<String> = mesh
            .indices
            .chunks_exact(3)
            .map(|c| format!("({},{},{})", c[0] + 1, c[1] + 1, c[2] + 1))
            .collect();
        // Closed=.T. nur, wenn TS das Mesh als dichtes, aussen orientiertes Volumen geprüft hat.
        let closed = if mesh.closed { ".T." } else { "$" };
        self.add("IFCTRIANGULATEDFACESET", format!("#{point_list},$,{closed},({}),$", tris.join(",")))
    }

    /// IFC2x3: ein IfcCartesianPoint je Ecke, je Dreieck IfcPolyLoop → IfcFaceOuterBound → IfcFace. Dichtes,
    /// aussen orientiertes Netz = IfcFacetedBrep über IfcClosedShell, sonst IfcShellBasedSurfaceModel über
    /// IfcOpenShell. Dreiecke mit doppelter Ecke (ohne Fläche) entfallen. Liefert (Körper, Darstellungsart).
    pub(super) fn emit_face_brep(&mut self, mesh: &Mesh) -> (usize, &'static str) {
        let points: Vec<usize> = mesh
            .positions
            .chunks_exact(3)
            .map(|c| self.add("IFCCARTESIANPOINT", list(&[fmt_real(c[0]), fmt_real(c[1]), fmt_real(c[2])])))
            .collect();
        let mut faces = Vec::with_capacity(mesh.indices.len() / 3);
        for c in mesh.indices.chunks_exact(3) {
            if c[0] == c[1] || c[1] == c[2] || c[0] == c[2] {
                continue;
            }
            let poly_loop = self.add("IFCPOLYLOOP", refs(&[points[c[0]], points[c[1]], points[c[2]]]));
            let bound = self.add("IFCFACEOUTERBOUND", format!("#{poly_loop},.T."));
            faces.push(self.add("IFCFACE", refs(&[bound])));
        }
        if mesh.closed {
            let shell = self.add("IFCCLOSEDSHELL", refs(&faces));
            (self.add("IFCFACETEDBREP", format!("#{shell}")), "Brep")
        } else {
            let shell = self.add("IFCOPENSHELL", refs(&faces));
            (self.add("IFCSHELLBASEDSURFACEMODEL", refs(&[shell])), "SurfaceModel")
        }
    }

    /// Menge (IfcQuantityLength/Area/Volume): IFC4 hat zusätzlich `Formula`.
    pub(super) fn emit_quantity(&mut self, ty: &str, name: &str, value: f64) -> usize {
        let formula = if self.v2() { "" } else { ",$" };
        self.add(ty, format!("{},$,$,{}{formula}", ifc_string(name), fmt_real(value)))
    }

    /// IfcBuildingElement-Subtyp mit dem üblichen 9-Attribut-Flatten. Das letzte Attribut ist in IFC4 die
    /// PredefinedType, in IFC2x3 je Klasse ShapeType/PredefinedType/CompositionType; IfcWall und IfcColumn
    /// haben es dort nicht.
    pub(super) fn emit_building_element(&mut self, ty: &str, guid: String, name: &str, placement: usize, shape: usize, predefined: Option<String>) -> usize {
        let last = if self.v2() && matches!(ty, "IFCWALL" | "IFCWALLSTANDARDCASE" | "IFCCOLUMN") {
            String::new()
        } else {
            format!(",{}", predefined.as_deref().unwrap_or("$"))
        };
        self.add(
            ty,
            format!("{guid},#{},{},$,$,#{placement},#{shape},${last}", self.owner_history, ifc_string(name)),
        )
    }

    /// Material je Bauteil (einmal, beim ersten Gebrauch).
    pub(super) fn material_of(&mut self, component_id: &str, component_name: &str) -> usize {
        if let Some(&id) = self.materials.get(component_id) {
            return id;
        }
        let id = self.add("IFCMATERIAL", if self.v2() { ifc_string(component_name) } else { format!("{},$,$", ifc_string(component_name)) });
        self.materials.insert(component_id.to_string(), id);
        id
    }

    /// Typ (IfcWallType/SlabType/RoofType mit IfcMaterialLayerSet), einmal je Typ; liefert den Index.
    fn type_for(&mut self, t: &TypeRef) -> usize {
        let key = format!("type/{}/{}", t.kind.ifc(), t.id);
        if let Some(&i) = self.type_index.get(&key) {
            return i;
        }
        let mut layer_ids = Vec::new();
        for l in &t.layers {
            let m = self.material_of(&l.component_id, &l.component_name);
            let thickness = if l.thickness.is_finite() { l.thickness.max(0.0) } else { 0.0 };
            let layer = if self.v2() { format!("#{m},{},$", fmt_real(thickness)) } else { format!("#{m},{},$,$,$,$,$", fmt_real(thickness)) };
            layer_ids.push(self.add("IFCMATERIALLAYER", layer));
        }
        // IFC2x3 kennt keinen IfcRoofType: das Dach bekommt nur die Schichten (direkt am Bauteil, s. `build_ifc`).
        let no_type = self.v2() && t.kind == TypeKind::Roof;
        let guid = self.gid(&key);
        let type_id = if no_type {
            0
        } else {
            self.add(
                t.kind.ifc(),
                format!("{guid},#{},{},$,$,$,$,$,$,{}", self.owner_history, ifc_string(&t.name), enum_(&t.predefined)),
            )
        };
        let mut layer_set = 0;
        if !layer_ids.is_empty() {
            let set = if self.v2() {
                self.add("IFCMATERIALLAYERSET", format!("{},{}", refs(&layer_ids), ifc_string(&t.name)))
            } else {
                self.add("IFCMATERIALLAYERSET", format!("{},{},$", refs(&layer_ids), ifc_string(&t.name)))
            };
            if !no_type {
                let rel_guid = self.gid(&format!("{key}/material"));
                self.add(
                    "IFCRELASSOCIATESMATERIAL",
                    format!("{rel_guid},#{},$,$,{},#{set}", self.owner_history, refs(&[type_id])),
                );
            }
            layer_set = set;
        }
        self.type_index.insert(key.clone(), self.types.len());
        self.types.push(TypeAcc { key, type_id, layer_set, occurrences: Vec::new() });
        self.types.len() - 1
    }

    /// IfcMaterialLayerSet eines schon angelegten Typs (`finish_typed` legt ihn an).
    pub(super) fn layer_set_of(&self, t: &TypeRef) -> Option<usize> {
        let key = format!("type/{}/{}", t.kind.ifc(), t.id);
        let set = self.types[*self.type_index.get(&key)?].layer_set;
        (set != 0).then_some(set)
    }

    /// Gemeinsamer Abschluss der Bauteile mit Typ und Psets: Typ (falls vorhanden) anlegen, Entität
    /// schreiben, Typ-Exemplar, Eingliederung und Psets vormerken.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn finish_typed(
        &mut self,
        ifc: &str,
        guid_key: String,
        name: &str,
        ty: &Option<TypeRef>,
        psets: &[Pset],
        structure: i64,
        placement: usize,
        shape: usize,
        predefined: Option<String>,
        type_first: bool,
    ) -> usize {
        // Wand und Decke legen den Typ vor dem Bauteil an, das Dach danach (Reihenfolge der TS-Fassung).
        let mut type_idx = if type_first { ty.as_ref().map(|t| self.type_for(t)) } else { None };
        let guid = self.gid(&guid_key);
        let entity = self.emit_building_element(ifc, guid, name, placement, shape, predefined);
        if !type_first {
            type_idx = ty.as_ref().map(|t| self.type_for(t));
        }
        if let Some(i) = type_idx {
            self.types[i].occurrences.push(entity);
        }
        self.add_to_containment(structure, entity);
        for p in psets {
            self.add_pset(p, entity, &guid_key);
        }
        self.elements.insert(guid_key, entity);
        entity
    }
}
