#!/usr/bin/env python3
"""[215] Testszene für den Cycles-Standalone: kleines Haus (Quader + Satteldach) auf Wiese, Kamera, Nishita-Himmel
mit Sonne, Principled BSDF. Schreibt eine Cycles-XML-Szene:

    python3 scripts/cycles/spike-scene.py haus.xml
    cycles --background --samples 64 --width 1280 --height 720 --output haus.exr haus.xml

Gelernt beim Bau (Vorlage für den späteren XML-Schreiber im Kern, doc/CYCLES.md):
- `<transform matrix=…>`: 16 Zahlen SPALTENWEISE (Spalten rechts, oben, Blickrichtung, Position); die Kamera blickt
  entlang +Z (Blender spiegelt beim Export Z), Bild-oben = +Y.
- Der Himmel braucht ein Hintergrundlicht (`<light light_type="background" use_mis="true" map_resolution="1024"/>`
  mit shader="default_background"), sonst wird die Sonnenscheibe nicht gezielt abgetastet (Rauschen, Lichtpunkte).
- Himmel/Sonne sind physikalisch (sehr hell): Belichtung über `<film exposure=…>`, Ausgabe als EXR und dann
  Tonwert-Abbildung/sRGB ausserhalb (PNG aus dem Standalone ist lineares Licht, 8 Bit).
- Entrauschen: `<integrator use_denoise="true"/>` (OIDN), kein Kommandozeilen-Schalter.
"""
import math
import sys

W, H = 1280, 720


def mesh(points, faces):
    pts = " ".join(f"{x} {y} {z}" for x, y, z in points)
    nv = " ".join(str(len(f)) for f in faces)
    vs = " ".join(" ".join(map(str, f)) for f in faces)
    return f'<mesh P="{pts}" nverts="{nv}" verts="{vs}" />'


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def norm(a):
    n = math.sqrt(sum(c * c for c in a))
    return [c / n for c in a]


def look(pos, target, up=(0, 0, 1)):
    f = norm([t - p for t, p in zip(target, pos)])
    r = norm(cross(f, up))
    u = cross(r, f)
    m = [*r, 0, *u, 0, *f, 0, *pos, 1]  # spaltenweise, Blick = +Z
    return " ".join(f"{v:.6f}" for v in m)


x0, x1, y0, y1, h, rh = -5, 5, -4, 4, 3, 5.2
box = [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0), (x0, y0, h), (x1, y0, h), (x1, y1, h), (x0, y1, h)]
walls = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
ov = 0.5
roof_p = [(x0 - ov, y0 - ov, h - 0.3), (x1 + ov, y0 - ov, h - 0.3), (x1 + ov, 0, rh), (x0 - ov, 0, rh),
          (x0 - ov, y1 + ov, h - 0.3), (x1 + ov, y1 + ov, h - 0.3)]
roof = [(0, 1, 2, 3), (3, 2, 5, 4)]
gable_p = [(x0, y0, h), (x0, y1, h), (x0, 0, rh), (x1, y1, h), (x1, y0, h), (x1, 0, rh)]
gable = [(0, 1, 2), (3, 4, 5)]
g = 60
ground = [(-g, -g, 0), (g, -g, 0), (g, g, 0), (-g, g, 0)]

out = sys.argv[1] if len(sys.argv) > 1 else "haus.xml"
fov = math.radians(45)  # vertikal
sun_el, sun_rot = math.radians(38), math.radians(150)


def pbr(name, rgb, rough):
    return (f'<shader name="{name}"><principled_bsdf name="p" base_color="{rgb}" roughness="{rough}" metallic="0" />'
            f'<connect from="p bsdf" to="output surface" /></shader>')


xml = f'''<cycles>
<film exposure="0.03" />
<integrator max_bounce="6" max_diffuse_bounce="3" max_glossy_bounce="3" max_transmission_bounce="6" use_denoise="true" />
<camera width="{W}" height="{H}" />
<transform matrix="{look((14, -17, 5.5), (0, 0, 2.2))}"><camera type="perspective" fov="{fov}" nearclip="0.1" farclip="1000" /></transform>
<background>
  <sky_texture name="sky" sky_type="multiple_scattering" sun_disc="true" sun_size="0.009512" sun_intensity="1.0" sun_elevation="{sun_el}" sun_rotation="{sun_rot}" air_density="1.0" aerosol_density="1.0" ozone_density="1.0" altitude="100" />
  <background name="bg" strength="1.0" />
  <connect from="sky color" to="bg color" />
  <connect from="bg background" to="output surface" />
</background>
{pbr("putz", "0.82 0.78 0.70", 0.85)}
{pbr("ziegel", "0.45 0.12 0.07", 0.7)}
{pbr("gras", "0.12 0.25 0.05", 0.9)}
<state shader="default_background"><light light_type="background" use_mis="true" map_resolution="1024" /></state>
<state shader="putz" interpolation="flat">{mesh(box, walls)}{mesh(gable_p, gable)}</state>
<state shader="ziegel" interpolation="flat">{mesh(roof_p, roof)}</state>
<state shader="gras" interpolation="flat">{mesh(ground, [(0, 1, 2, 3)])}</state>
</cycles>
'''
with open(out, "w") as f:
    f.write(xml)
print("geschrieben:", out)
