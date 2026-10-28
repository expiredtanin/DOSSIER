#!/usr/bin/env python3
"""Gegencheck für den IFC-Import ([B3]): Dreiecke und Volumen je Bauteil aus ifcopenshell.geom.

Aufruf: python3 scripts/ifc-import-compare.py datei.ifc
Ausgabe (stdout, JSON): {"<GlobalId>": {"class": "IfcWall", "triangles": 12, "volume": 1.5}, …}
Volumen in m³ (Weltkoordinaten, Einheiten der Datei umgerechnet). Ausgelassen wie im Import:
IfcOpeningElement, IfcSpace, IfcAnnotation, IfcGrid, IfcVirtualElement, IfcSpatialZone und Bauteile ohne Körper.
Braucht `pip install ifcopenshell` (getestet mit 0.8/0.9).
"""

import json
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.shape

SKIP = {"IfcOpeningElement", "IfcOpeningStandardCase", "IfcSpace", "IfcAnnotation", "IfcGrid", "IfcVirtualElement", "IfcSpatialZone"}


def main(path: str) -> int:
    model = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    # Öffnungen nicht abziehen — der Mesh-Import [B3] tut es auch nicht.
    settings.set("disable-opening-subtractions", True)
    out = {}
    for product in model.by_type("IfcProduct"):
        if product.is_a() in SKIP or product.Representation is None:
            continue
        try:
            shape = ifcopenshell.geom.create_shape(settings, product)
        except Exception:  # noqa: BLE001 — ohne Körper: auslassen
            continue
        geom = shape.geometry
        out[product.GlobalId] = {
            "class": product.is_a(),
            "triangles": len(geom.faces) // 3,
            "volume": ifcopenshell.util.shape.get_volume(geom),
        }
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
