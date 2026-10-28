#!/usr/bin/env python3
"""DXF-Gegencheck mit ezdxf ([C1]/[C2]): liest eine von Dossier exportierte DXF-Datei mit einer
unabhängigen Bibliothek, prüft sie mit dem ezdxf-Auditor und gibt eine JSON-Übersicht aus
(Version, Einheit, Ebenen, Entitäten je Typ, Koordinaten, Texte), die der Vitest-Test
`src/export/exportDxf.ezdxf.test.ts` mit dem Export vergleicht.

Aufruf: python3 scripts/validate-dxf.py datei.dxf   (braucht `pip install ezdxf`)
Exit 0 = lesbar und ohne Auditor-Fehler.
"""
import json
import sys

import ezdxf
from ezdxf import recover


def main(path: str) -> int:
    # recover.readfile liest nur ASCII; Binär-DXF ("AutoCAD Binary DXF") geht über readfile + Audit.
    with open(path, "rb") as fh:
        binary = fh.read(18) == b"AutoCAD Binary DXF"
    if binary:
        doc = ezdxf.readfile(path)
        auditor = doc.audit()
    else:
        doc, auditor = recover.readfile(path)
    msp = doc.modelspace()
    entities = []
    for e in msp:
        t = e.dxftype()
        item = {"type": t, "layer": e.dxf.layer}
        if t == "LINE":
            item["pts"] = [[e.dxf.start.x, e.dxf.start.y], [e.dxf.end.x, e.dxf.end.y]]
        elif t == "LWPOLYLINE":
            item["pts"] = [[p[0], p[1]] for p in e.get_points("xy")]
            item["closed"] = bool(e.closed)
        elif t in ("ARC", "CIRCLE"):
            item["center"] = [e.dxf.center.x, e.dxf.center.y]
            item["r"] = e.dxf.radius
            if t == "ARC":
                item["angles"] = [e.dxf.start_angle, e.dxf.end_angle]
        elif t == "HATCH":
            item["solid"] = bool(e.dxf.solid_fill)
            item["paths"] = len(e.paths)
            item["pattern_lines"] = len(e.pattern.lines) if e.pattern else 0
            item["rgb"] = list(e.rgb) if e.dxf.hasattr("true_color") else None
            g = e.gradient
            item["gradient"] = (
                {
                    "name": g.name,
                    "rotation": g.rotation,
                    "color1": list(g.color1),
                    "color2": list(g.color2),
                }
                if g is not None
                else None
            )
            first = e.paths[0] if len(e.paths) else None
            item["pts"] = [[v[0], v[1]] for v in first.vertices] if first is not None and hasattr(first, "vertices") else []
        elif t == "TEXT":
            item["text"] = e.dxf.text
            item["at"] = [e.dxf.insert.x, e.dxf.insert.y]
            item["height"] = e.dxf.height
            item["style"] = e.dxf.style
            item["halign"] = e.dxf.halign
            item["valign"] = e.dxf.valign
            item["rotation"] = e.dxf.rotation
            if e.dxf.hasattr("align_point"):
                item["align_point"] = [e.dxf.align_point.x, e.dxf.align_point.y]
        elif t == "INSERT":
            item["name"] = e.dxf.name
            item["at"] = [e.dxf.insert.x, e.dxf.insert.y]
            item["rotation"] = e.dxf.rotation
            item["scale"] = [e.dxf.xscale, e.dxf.yscale]
            item["attribs"] = {a.dxf.tag: a.dxf.text for a in e.attribs}
        elif t == "DIMENSION":
            item["dimtype"] = e.dimtype
            item["block"] = e.dxf.geometry
            item["dimstyle"] = e.dxf.dimstyle
            item["defpoint"] = [e.dxf.defpoint.x, e.dxf.defpoint.y]
            item["p1"] = [e.dxf.defpoint2.x, e.dxf.defpoint2.y]
            item["p2"] = [e.dxf.defpoint3.x, e.dxf.defpoint3.y]
            item["measurement"] = e.dxf.actual_measurement
        if e.dxf.hasattr("linetype"):
            item["linetype"] = e.dxf.linetype
        entities.append(item)
    layers = {
        l.dxf.name: {"lineweight": l.dxf.lineweight, "rgb": l.rgb and list(l.rgb)} for l in doc.layers
    }
    blocks = {}
    for b in doc.blocks:
        n = {}
        for be in b:
            n[be.dxftype()] = n.get(be.dxftype(), 0) + 1
        blocks[b.name] = {"entities": n, "anonymous": b.name.startswith("*D")}
    styles = {st.dxf.name: (st.dxf.font if st.dxf.hasattr("font") else None) for st in doc.styles}
    ttf = {}
    for st in doc.styles:
        try:
            ttf[st.dxf.name] = st.get_extended_font_data()[0]
        except Exception:
            pass
    linetypes = {lt.dxf.name: list(lt.pattern_tags.tags and [t.value for t in lt.pattern_tags.tags if t.code == 49]) for lt in doc.linetypes}
    dimstyles = {
        d.dxf.name: {k: d.dxf.get(k) for k in ("dimscale", "dimtxt", "dimtsz", "dimexo", "dimexe", "dimgap", "dimtad", "dimdec", "dimlfac", "dimtxsty")}
        for d in doc.dimstyles
    }
    layouts = {}
    for lay in doc.layouts:
        if lay.name == "Model":
            continue
        vps = [
            {
                "id": v.dxf.id,
                "center": [v.dxf.center.x, v.dxf.center.y],
                "size": [v.dxf.width, v.dxf.height],
                "view_center": [v.dxf.view_center_point.x, v.dxf.view_center_point.y],
                "view_height": v.dxf.view_height,
            }
            for v in lay.viewports()
        ]
        dl = lay.dxf_layout.dxf
        layouts[lay.name] = {
            "viewports": vps,
            "paper": [dl.paper_width, dl.paper_height] if dl.hasattr("paper_width") else None,
        }
    out = {
        "version": doc.dxfversion,
        "blocks": blocks,
        "styles": styles,
        "fonts": ttf,
        "linetypes": linetypes,
        "dimstyles": dimstyles,
        "layouts": layouts,
        "insunits": doc.header.get("$INSUNITS"),
        "errors": [str(err.message) for err in auditor.errors],
        "layers": layers,
        "entities": entities,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 1 if auditor.has_errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
