"""Testhaus [270]: Haupthaus 10 x 8 m (2 Geschosse à 3 m), Erker im Osten (2 x 3 m, 1 Geschoss + Dach), Garage im Westen
(6 x 5 m, 2.6 m hoch), Turm im Nordwesten (zur Unterscheidung Nord/Süd). Schnitte A (waagrecht) und B (senkrecht),
Ansichten Nord/Ost/Süd/West, deren Mitte genau auf den Enden der Schnitte liegt (Befund [266]/8)."""
import json, sys

walls = []
def box(name, x0, y0, x1, y1, h, floor="eg", t=0.3):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for i in range(4):
        a, b = pts[i], pts[(i + 1) % 4]
        walls.append({"id": f"{name}{i}", "type": "wall", "floorId": floor, "categoryCode": "20", "wallTypeId": "t",
                      "start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}, "height": h})

box("h", 0, 0, 10, 8, 3.0)
box("o", 0, 0, 10, 8, 3.0, floor="og")
box("e", 10, 2.5, 12.5, 5.5, 3.0)            # Erker Ost
box("g", -6, 0, 0, 5, 2.6)                   # Garage West
box("n", 0, 8, 3, 11, 3.0)                   # Turm Nordwest, über zwei Geschosse
box("nn", 0, 8, 3, 11, 3.0, floor="og")

lv = [
    {"id": "eg", "name": "Erdgeschoss", "kind": "floor", "visible": True, "locked": False, "floorHeight": 3.0, "baseElevation": 0.0},
    {"id": "og", "name": "Obergeschoss", "kind": "floor", "visible": True, "locked": False, "floorHeight": 3.0, "baseElevation": 3.0},
    {"id": "sa", "name": "Schnitt A-A", "kind": "section", "visible": True, "locked": False, "linePoints": [{"x": -9, "y": 4}, {"x": 15, "y": 4}], "directionSign": 1},
    {"id": "sb", "name": "Schnitt B-B", "kind": "section", "visible": True, "locked": False, "linePoints": [{"x": 5, "y": -3}, {"x": 5, "y": 14}], "directionSign": -1},
    {"id": "vs", "name": "Ansicht Süd", "kind": "elevation", "visible": True, "locked": False, "linePoints": [{"x": -7, "y": -3}, {"x": 17, "y": -3}], "directionSign": 1},
    {"id": "vn", "name": "Ansicht Nord", "kind": "elevation", "visible": True, "locked": False, "linePoints": [{"x": 17, "y": 14}, {"x": -7, "y": 14}], "directionSign": 1},
    {"id": "vo", "name": "Ansicht Ost", "kind": "elevation", "visible": True, "locked": False, "linePoints": [{"x": 15, "y": -8}, {"x": 15, "y": 16}], "directionSign": 1},
    {"id": "vw", "name": "Ansicht West", "kind": "elevation", "visible": True, "locked": False, "linePoints": [{"x": -9, "y": 16}, {"x": -9, "y": -8}], "directionSign": 1},
]
p = {
    "id": "testhaus270", "name": "Testhaus 270", "lineStyles": [], "hatches": [],
    "components": [{"id": "c", "name": "Mauerwerk", "hatchId": ""}],
    "wallTypes": [{"id": "t", "name": "Wand 30", "layers": [{"componentId": "c", "thickness": 0.3}]}],
    "drawingLevels": lv,
    "layers": [{"code": "20", "name": "Wände", "color": "#000", "lw": 0.5, "visible": True, "locked": False}],
    "walls": walls, "drawings2d": [],
}
json.dump(p, open(sys.argv[1], "w"), indent=1)
