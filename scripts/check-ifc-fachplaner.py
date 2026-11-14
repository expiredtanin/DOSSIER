#!/usr/bin/env python3
"""IFC für Fachplaner prüfen ([259]): was Archicad/Revit/Solibri/BIMcollab von einem Architekturmodell erwarten.

Ergänzt `scripts/validate-ifc.py` (Schema, Express-Regeln, Geometrie) um inhaltliche Prüfungen:
  • räumliche Struktur: genau ein IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey (Name, Elevation);
    jedes Bauteil genau einmal räumlich eingeordnet (Teile über IfcRelAggregates, Öffnungen über IfcRelVoidsElement,
    Kontext am IfcSite, sonst an einem Geschoss);
  • Georeferenz (mit `--geo`): IfcMapConversion auf IfcProjectedCRS EPSG:2056, Geometrie lokal (nicht in
    LV95-Millionen: Revit/Archicad warnen ab wenigen Kilometern Abstand zum Ursprung);
  • Öffnungen: jedes IfcOpeningElement schneidet genau ein Bauteil; jede Tür/jedes Fenster füllt genau eine Öffnung und
    liegt im Geschoss ihres Wirts;
  • Räume: Name (Nummer), LongName, Pset_SpaceCommon, Qto_SpaceBaseQuantities (NetFloorArea, GrossFloorArea, Height),
    SIA-416-Kategorie; Fläche ±1 % gegen die Geometrie (ifcopenshell);
  • Wände: IfcMaterialLayerSetUsage mit Materialnamen, Schichtsumme = Wanddicke; NetVolume ±1 % gegen die Geometrie;
    Decken: PredefinedType, NetVolume ±1 %;
  • Geschoss-Mengen: GrossFloorArea ≥ NetFloorArea;
  • Ebenen: jedes Bauteil (Wand, Decke, Dach, Stütze, Treppe samt Teilen, Tür/Fenster, Raum) hat Darstellungen auf GENAU EINER
    IfcPresentationLayerAssignment; Ebenennamen `Code_Bezeichnung` (wie im DXF);
  • Räume: Height = Geometrie ±1 cm, `stats.spaceHeights` (Nummer → Height, FinishCeilingHeight, ClearHeightMin/Mean) für den
    Vergleich mit dem Raumbuch im Test;
  • keine Objekte der 2D-Objektbibliothek als 3D-Körper (IfcFurniture/IfcSanitaryTerminal …).

Aufruf: python3 scripts/check-ifc-fachplaner.py datei.ifc [--geo] [--context] [--json] [--known=GlobalId,…]
  --geo      die Datei MUSS georeferenziert sein
  --context  Kontext (Gelände/Nachbarn) wird erwartet; ohne: es darf keiner drin sein
  --json     Kennwerte als JSON auf stdout (für Tests)
  --known    bekannte Mengen-Abweichungen dieser Bauteile (GlobalId) als `stats.known` statt als Befund
             (offene Punkte in TODO.md, z. B. ifcopenshell-Boolean an Netz-Wänden unter dem Dach)
Exit 0 = keine Befunde.
"""

import json
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.placement as up
import ifcopenshell.util.shape as us

TOL = 0.01  # ±1 %
LOCAL_LIMIT = 5000.0  # m: weiter vom Ursprung = „nicht lokal"
LIBRARY_CLASSES = ["IfcFurniture", "IfcFurnishingElement", "IfcSanitaryTerminal", "IfcSystemFurnitureElement"]


def rel_err(a, b):
    return abs(a - b) / max(abs(b), 1e-9)


def check(path, want_geo, want_context, known=()):
    m = ifcopenshell.open(path)
    problems = []
    stats = {"known": []}

    def volume_problem(e, text):
        (stats["known"] if e.GlobalId in known else problems).append(text)
    s = ifcopenshell.geom.settings()

    # ── Räumliche Struktur ──
    projects, sites, buildings = m.by_type("IfcProject"), m.by_type("IfcSite"), m.by_type("IfcBuilding")
    if (len(projects), len(sites), len(buildings)) != (1, 1, 1):
        problems.append(f"Struktur: {len(projects)} Projekt(e), {len(sites)} Site(s), {len(buildings)} Gebäude (erwartet je 1)")
        return problems, stats
    site, building = sites[0], buildings[0]
    if not any(r.RelatingObject == projects[0] for r in site.Decomposes):
        problems.append("IfcSite hängt nicht am IfcProject")
    if not any(r.RelatingObject == site for r in building.Decomposes):
        problems.append("IfcBuilding hängt nicht am IfcSite")
    storeys = m.by_type("IfcBuildingStorey")
    stats["storeys"] = [(st.Name, st.Elevation) for st in storeys]
    for st in storeys:
        if not st.Name:
            problems.append(f"Geschoss #{st.id()} ohne Namen")
        if st.Elevation is None:
            problems.append(f"Geschoss {st.Name} ohne Elevation")
        if not any(r.RelatingObject == building for r in st.Decomposes):
            problems.append(f"Geschoss {st.Name} hängt nicht am Gebäude")

    def container(e):
        rels = list(e.ContainedInStructure or [])
        return rels[0].RelatingStructure if len(rels) == 1 else None

    # ── Jedes Element genau einmal eingeordnet ──
    counts = {}
    for e in m.by_type("IfcElement"):
        counts[e.is_a()] = counts.get(e.is_a(), 0) + 1
        contained = len(e.ContainedInStructure or [])
        parts = len(e.Decomposes or [])
        if e.is_a("IfcFeatureElementSubtraction"):
            if contained or len(e.VoidsElements or []) != 1:
                problems.append(f"{e.is_a()} #{e.id()}: {len(e.VoidsElements or [])} Wirte, {contained}× eingeordnet (erwartet 1 Wirt, 0)")
            continue
        if contained + parts != 1:
            problems.append(f"{e.is_a()} {e.Name!r}: {contained}× eingeordnet, {parts}× Teil (erwartet genau eins)")
            continue
        if contained:
            c = container(e)
            ctx = e.is_a("IfcGeographicElement") or (e.ObjectType or "").startswith("Kontext")
            if ctx and not c.is_a("IfcSite"):
                problems.append(f"Kontext {e.Name!r} nicht am IfcSite, sondern {c.is_a()}")
            if not ctx and not c.is_a("IfcBuildingStorey") and not e.is_a("IfcGeographicElement"):
                problems.append(f"{e.is_a()} {e.Name!r} liegt in {c.is_a()} statt einem Geschoss")
    stats["counts"] = counts

    # ── Kontext ──
    context = [e for e in m.by_type("IfcElement") if (container(e) is not None and container(e).is_a("IfcSite"))]
    stats["context"] = len(context)
    if want_context and not context:
        problems.append("Kontext erwartet, aber keiner am IfcSite")
    if not want_context and context:
        problems.append(f"{len(context)} Kontext-Objekte, obwohl abgeschaltet")

    # ── Objektbibliothek nicht als 3D ──
    for cls in LIBRARY_CLASSES:
        try:
            n = len(m.by_type(cls))
        except RuntimeError:
            n = 0
        if n:
            problems.append(f"{n} × {cls} (2D-Objektbibliothek darf nicht als 3D-Körper exportiert werden)")

    # ── Georeferenz ──
    convs = m.by_type("IfcMapConversion") if m.schema != "IFC2X3" else []
    if want_geo:
        if not convs:
            problems.append("Georeferenz erwartet, aber kein IfcMapConversion")
        else:
            c = convs[0]
            crs = c.TargetCRS
            if crs.Name != "EPSG:2056":
                problems.append(f"Zielsystem {crs.Name!r} statt EPSG:2056")
            if not (2_480_000 < c.Eastings < 2_840_000 and 1_070_000 < c.Northings < 1_300_000):
                problems.append(f"IfcMapConversion ausserhalb LV95: E {c.Eastings}, N {c.Northings}")
            stats["map"] = [c.Eastings, c.Northings, c.OrthogonalHeight]
            if site.RefElevation is not None and abs(site.RefElevation - c.OrthogonalHeight) > 1e-6:
                problems.append(f"IfcSite.RefElevation {site.RefElevation} ≠ OrthogonalHeight {c.OrthogonalHeight}")
    far = 0.0
    for e in m.by_type("IfcProduct"):
        if e.ObjectPlacement is None:
            continue
        mat = up.get_local_placement(e.ObjectPlacement)
        far = max(far, abs(mat[0][3]), abs(mat[1][3]))
    for p in m.by_type("IfcCartesianPoint"):
        far = max(far, *(abs(x) for x in p.Coordinates[:2]))
    for pl in m.by_type("IfcCartesianPointList3D"):
        for c in pl.CoordList:
            far = max(far, abs(c[0]), abs(c[1]))
    stats["far"] = far
    if far > LOCAL_LIMIT:
        problems.append(f"Geometrie {far:.0f} m vom Ursprung (nicht lokal; Revit/Archicad warnen)")

    # ── Öffnungen ──
    unfilled = 0
    for o in m.by_type("IfcOpeningElement"):
        if not o.HasFillings:
            unfilled += 1
    stats["openings"] = len(m.by_type("IfcOpeningElement"))
    stats["unfilled"] = unfilled
    for f in m.by_type("IfcDoor") + m.by_type("IfcWindow"):
        if len(f.FillsVoids or []) != 1:
            problems.append(f"{f.is_a()} {f.Name!r} füllt {len(f.FillsVoids or [])} Öffnungen")
            continue
        host = f.FillsVoids[0].RelatingOpeningElement.VoidsElements[0].RelatingBuildingElement
        hc, fc = container(host), container(f)
        if hc is not None and fc is not None and hc != fc:
            problems.append(f"{f.is_a()} {f.Name!r} in {fc.Name}, Wirt in {hc.Name}")

    # ── Räume ──
    spaces = m.by_type("IfcSpace")
    stats["spaces"] = len(spaces)
    for sp in spaces:
        ps = ue.get_psets(sp)
        label = f"Raum {sp.Name!r}"
        if not sp.Name or not sp.LongName:
            problems.append(f"{label}: Name/LongName fehlt ({sp.Name!r}/{sp.LongName!r})")
        if not any(r.RelatingObject.is_a("IfcBuildingStorey") for r in sp.Decomposes):
            problems.append(f"{label}: nicht im Geschoss aggregiert")
        if "Pset_SpaceCommon" not in ps:
            problems.append(f"{label}: Pset_SpaceCommon fehlt")
        q = ps.get("Qto_SpaceBaseQuantities", {})
        for k in ("NetFloorArea", "GrossFloorArea", "Height"):
            if k not in q:
                problems.append(f"{label}: Qto_SpaceBaseQuantities.{k} fehlt")
        if not any("SIA416" in v for k, v in ps.items() if k != "Qto_SpaceBaseQuantities"):
            problems.append(f"{label}: SIA-416-Kategorie fehlt")
        if sp.Representation is None:
            problems.append(f"{label}: ohne Geometrie")
            continue
        sh = ifcopenshell.geom.create_shape(s, sp)
        area = us.get_footprint_area(sh.geometry)
        if "NetFloorArea" in q and rel_err(q["NetFloorArea"], area) > TOL:
            problems.append(f"{label}: NetFloorArea {q['NetFloorArea']:.3f} ≠ Geometrie {area:.3f}")
        h = us.get_z(sh.geometry)
        if "Height" in q and abs(q["Height"] - h) > 0.01:
            problems.append(f"{label}: Height {q['Height']:.3f} ≠ Geometrie {h:.3f}")
        book = ps.get("Dossier_Qto_RoomBook", {})
        stats.setdefault("spaceHeights", {})[sp.Name] = {
            "Height": q.get("Height"),
            "FinishCeilingHeight": q.get("FinishCeilingHeight"),
            "ClearHeightMin": book.get("ClearHeightMin"),
            "ClearHeightMean": book.get("ClearHeightMean"),
            "geometry": h,
        }
        if "FinishCeilingHeight" not in q:
            problems.append(f"{label}: Qto_SpaceBaseQuantities.FinishCeilingHeight fehlt")

    # ── Wände: Schichten und Volumen ──
    walls = m.by_type("IfcWall")
    with_usage = 0
    for w in walls:
        label = f"Wand {w.Name!r} #{w.id()}"
        mat = ue.get_material(w, should_skip_usage=False)
        if mat is not None and mat.is_a("IfcMaterialLayerSetUsage"):
            with_usage += 1
            layers = mat.ForLayerSet.MaterialLayers
            if any(not (ly.Material and ly.Material.Name) for ly in layers):
                problems.append(f"{label}: Schicht ohne Materialnamen")
            q = ue.get_psets(w).get("Qto_WallBaseQuantities", {})
            total = sum(ly.LayerThickness for ly in layers)
            if "Width" in q and abs(q["Width"] - total) > 1e-4:
                problems.append(f"{label}: Schichtsumme {total:.4f} ≠ Width {q['Width']:.4f}")
        elif mat is None:
            problems.append(f"{label}: ohne Material")
        q = ue.get_psets(w).get("Qto_WallBaseQuantities", {})
        if "NetVolume" in q:
            v = us.get_volume(ifcopenshell.geom.create_shape(s, w).geometry)
            if rel_err(q["NetVolume"], v) > TOL:
                volume_problem(w, f"{label}: NetVolume {q['NetVolume']:.4f} ≠ Geometrie {v:.4f}")
    stats["walls"] = len(walls)
    stats["wallsWithUsage"] = with_usage

    # ── Decken ──
    for sl in m.by_type("IfcSlab"):
        label = f"Decke {sl.Name!r} #{sl.id()}"
        if sl.PredefinedType not in ("FLOOR", "ROOF", "BASESLAB", "LANDING"):
            problems.append(f"{label}: PredefinedType {sl.PredefinedType}")
        q = ue.get_psets(sl).get("Qto_SlabBaseQuantities", {})
        if "NetVolume" in q and sl.Representation is not None:
            v = us.get_volume(ifcopenshell.geom.create_shape(s, sl).geometry)
            if rel_err(q["NetVolume"], v) > TOL:
                volume_problem(sl, f"{label}: NetVolume {q['NetVolume']:.4f} ≠ Geometrie {v:.4f}")

    # ── Geschoss-Mengen ──
    for st in storeys:
        q = ue.get_psets(st).get("Qto_BuildingStoreyBaseQuantities", {})
        if q and q.get("GrossFloorArea", 0) + 1e-6 < q.get("NetFloorArea", 0):
            problems.append(f"Geschoss {st.Name}: GrossFloorArea < NetFloorArea")
        # SIA 416: GF = NGF + KF; mit Wänden im Geschoss ist die Konstruktionsfläche > 0.
        has_walls = any(e.is_a("IfcWall") for r in st.ContainsElements for e in r.RelatedElements)
        if q and has_walls and q.get("GrossFloorArea", 0) <= q.get("NetFloorArea", 0) + 1e-6:
            problems.append(f"Geschoss {st.Name}: GrossFloorArea = NetFloorArea trotz Wänden (Konstruktionsfläche fehlt)")
        stats.setdefault("storeyQto", {})[st.Name] = {k: v for k, v in q.items() if k != "id"}

    # ── Ebenen (IfcPresentationLayerAssignment) ──
    layer_of = {}  # Darstellung -> Ebenen
    for la in m.by_type("IfcPresentationLayerAssignment"):
        for item in la.AssignedItems:
            layer_of.setdefault(item.id(), []).append(la.Name)
    stats["layers"] = sorted({la.Name for la in m.by_type("IfcPresentationLayerAssignment")})

    def parts(e):
        yield e
        for r in getattr(e, "IsDecomposedBy", None) or []:
            for c in r.RelatedObjects:
                yield from parts(c)

    stats["layered"] = 0
    for cls in ("IfcWall", "IfcSlab", "IfcRoof", "IfcColumn", "IfcStair", "IfcDoor", "IfcWindow", "IfcSpace"):
        for e in m.by_type(cls):
            if cls == "IfcGeographicElement":
                continue
            names = set()
            n_reps = 0
            for part in parts(e):
                if part.Representation is None:
                    continue
                for rep in part.Representation.Representations:
                    n_reps += 1
                    ls = layer_of.get(rep.id(), [])
                    if len(ls) != 1:
                        problems.append(f"{cls} {e.Name!r} #{e.id()}: Darstellung {rep.RepresentationIdentifier} auf {len(ls)} Ebenen")
                    names.update(ls)
            if len(names) > 1:
                problems.append(f"{cls} {e.Name!r} #{e.id()}: Darstellungen auf mehreren Ebenen {sorted(names)}")
            if n_reps and names:
                stats["layered"] += 1
    if stats["layered"] == 0 and m.by_type("IfcWall"):
        problems.append("keine Ebenen (IfcPresentationLayerAssignment) im Modell")
    for la in m.by_type("IfcPresentationLayerAssignment"):
        if not la.Name or "_" not in la.Name and not la.Name.isalnum():
            problems.append(f"Ebene {la.Name!r}: unerwarteter Name")

    # ── Pset_*Common ──
    for cls, pset in (("IfcWall", "Pset_WallCommon"), ("IfcSlab", "Pset_SlabCommon"), ("IfcDoor", "Pset_DoorCommon"), ("IfcWindow", "Pset_WindowCommon")):
        missing = [e for e in m.by_type(cls) if pset not in ue.get_psets(e) and not (cls == "IfcSlab" and e.PredefinedType == "LANDING")]
        if missing:
            problems.append(f"{len(missing)} × {cls} ohne {pset}")
    return problems, stats


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(2)
    flags = set(a.split("=")[0] for a in sys.argv[1:] if a.startswith("--"))
    known = [g for a in sys.argv[1:] if a.startswith("--known=") for g in a.split("=", 1)[1].split(",") if g]
    worst = 0
    for path in args:
        problems, stats = check(path, "--geo" in flags, "--context" in flags, known)
        if "--json" in flags:
            print(json.dumps({"path": path, "problems": problems, "stats": stats}))
        else:
            print(f"{path}: {len(problems)} Befunde")
            for p in problems[:200]:
                print("  " + p)
            for p in stats["known"]:
                print("  (bekannt) " + p)
        worst = max(worst, 1 if problems else 0)
    sys.exit(worst)
