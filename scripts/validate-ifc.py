#!/usr/bin/env python3
"""IFC-Datei prüfen ([B1]/[18]): Schema + Express-Regeln (ifcopenshell.validate) und Geometrie je Bauteil.

Aufruf: python3 scripts/validate-ifc.py datei.ifc [weitere.ifc …]
Exit 0 = alles gültig; sonst werden die Befunde ausgegeben und Exit 1.
Braucht `pip install ifcopenshell` (getestet mit 0.8/0.9).
"""

import sys

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate


def check(path: str) -> int:
    logger = ifcopenshell.validate.json_logger()
    model = ifcopenshell.open(path)
    ifcopenshell.validate.validate(model, logger, express_rules=True)
    problems = [f"{s.get('level', '?')}: {s.get('message', s)}" for s in logger.statements]

    settings = ifcopenshell.geom.settings()
    shapes = 0
    for product in model.by_type("IfcProduct"):
        if product.Representation is None:
            continue
        try:
            ifcopenshell.geom.create_shape(settings, product)
            shapes += 1
        except Exception as exc:  # noqa: BLE001 — jeder Geometriefehler ist ein Befund
            problems.append(f"Geometrie {product.is_a()} #{product.id()} {product.Name!r}: {exc}")

    print(f"{path}: {len(model.by_type('IfcProduct'))} Produkte, {shapes} Körper, {len(problems)} Befunde")
    for p in problems[:200]:
        print("  " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(max(check(p) for p in sys.argv[1:]))
