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
        entities.append(item)
    layers = {
        l.dxf.name: {"lineweight": l.dxf.lineweight, "rgb": l.rgb and list(l.rgb)} for l in doc.layers
    }
    out = {
        "version": doc.dxfversion,
        "insunits": doc.header.get("$INSUNITS"),
        "errors": [str(err.message) for err in auditor.errors],
        "layers": layers,
        "entities": entities,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 1 if auditor.has_errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
