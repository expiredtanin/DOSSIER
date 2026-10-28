#!/usr/bin/env python3
"""Gegencheck für den IFC-Import ([B3]): Dreiecke und Volumen je Bauteil aus ifcopenshell.geom.

Aufruf: python3 scripts/ifc-import-compare.py datei.ifc [--no-openings]
Ausgabe (stdout, JSON): {"<GlobalId>": {"class": "IfcWall", "triangles": 12, "volume": 1.5}, …}
Volumen in m³ (Weltkoordinaten, Einheiten der Datei umgerechnet). Ausgelassen wie im Import:
IfcOpeningElement, IfcSpace, IfcAnnotation, IfcGrid, IfcVirtualElement, IfcSpatialZone und Bauteile ohne Körper.
Braucht `pip install ifcopenshell` (getestet mit 0.8/0.9).
"""

import json
import os
import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.shape

SKIP = {"IfcOpeningElement", "IfcOpeningStandardCase", "IfcSpace", "IfcAnnotation", "IfcGrid", "IfcVirtualElement", "IfcSpatialZone"}


def main(path: str) -> int:
    # ifcopenshell schreibt bei manchen Dateien Meldungen auf stdout (C++): stdout während des Lesens
    # auf stderr umlenken, damit nur das JSON auf stdout landet.
    sys.stdout.flush()
    real_stdout = os.dup(1)
    os.dup2(2, 1)
    try:
        out = shapes(path)
    finally:
        sys.stdout.flush()
        os.dup2(real_stdout, 1)
        os.close(real_stdout)
    json.dump(out, sys.stdout)
    return 0


def shapes(path: str) -> dict:
    model = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    # Öffnungen werden abgezogen (wie im Import); `--no-openings` schaltet das ab.
    settings.set("disable-opening-subtractions", "--no-openings" in sys.argv)
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
    return out


if __name__ == "__main__":
    files = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(files) != 1:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(files[0]))
