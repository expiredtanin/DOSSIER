# Dossier -> Blender/Cycles ([211]): rendert das exportierte 3D-Modell fotorealistisch.
#
# Aufruf (Blender laeuft als eigener Prozess, nichts davon wird in Dossier eingebunden):
#     blender -b --python render_dossier.py -- <szene.json>
#
# Die Szenenbeschreibung (`szene.json`, geschrieben von `src/export/blenderRender.ts`) liegt neben dem
# Modell (`model.glb`) und dem Texturordner. Alle Pfade darin sind relativ zur JSON-Datei.
#
#   {
#     "version": 1, "model": "model.glb", "output": "render.png",
#     "resolution": {"width": 1920, "height": 1080}, "samples": 128, "denoise": true, "device": "auto",
#     "camera": {"kind": "perspective", "position": [x,y,z], "direction": [..], "up": [..], "fovDeg": 50, "orthoHeight": 10}
#              oder {"preset": "iso" | "perspective" | "front" | "back" | "left" | "right" | "side" | "top"},
#     "sun": {"azimuth": 135, "elevation": 40},          # Grad, Azimut von Norden im Uhrzeigersinn
#     "materials": [{"name": "Beton", "glass": false, "textures": {"color": "textures/0_color.jpg", ...}, "sizeM": 1.0}]
#   }
#
# Koordinaten: Modell-Koordinaten (x = Ost, y = Nord, z = Hoehe, Meter). Der glTF-Import von Blender dreht die
# Y-oben-Achsen des GLB (x, z, -y) genau auf diese zurueck, Kamera und Sonne brauchen keine Umrechnung.
#
# Materialien (`materials[]`): `name` = glTF-Materialname, `role` (terrain | roof | context | opening | building),
# `component` (Baustoff, wenn er vom Namen abweicht: "Dach: Tonziegel"), `color` sRGB, `glass`, `textures`, `sizeM`.
# Mehrere Eintraege gleichen Namens (gleicher Name, andere Farbe) ordnet das Skript ueber die Farbe zu.
#
# Bildwirkung (physikalisch plausibel, wie ein Cycles-Standardbild und nicht "nach Augenmass"):
#   * Himmel: Nishita (ab Blender 5.0 "Mehrfachstreuung"), Sonnenstaerke 1.0, Sonnenscheibe 0.545 Grad (Winkeldurchmesser der
#     Sonne), Luft/Staub/Ozon auf 1.0 (Standard). Sonnenstand aus Ort und Zeit der Szene (`sun`).
#   * Belichtung: Nishita rechnet absolut (weisse besonnte Flaeche ~ 45 bei 60 Grad Sonnenhoehe), die Kamera belichtet wie eine
#     Automatik (`auto_exposure`, ~ -5 EV mittags) und die Farbumsetzung ist AgX (Filmic, wo AgX fehlt): Lichter laufen weich aus,
#     Weiss frisst nicht aus. `sun.intensity` und `exposure` (EV) in scene.json uebersteuern (Voreinstellung 1.0 und automatisch).
#   * Albedo: kein Baustoff reflektiert 100 Prozent. Flaechenfarben und Texturen werden auf 0.80 (linear, = sRGB 0.91, frischer
#     weisser Putz) begrenzt, sonst frisst Weiss unter der Sonne aus.
#   * Gelaende: Wiese (Bildkarten der Bibliothek oder ohne diese ein Wiesengruen), Boden darunter erdig-gruen.
#   * Dach: Baustoff der aeussersten Dachschicht (Textur; ohne Textur Ziegel, Blech, Kies, Schiefer, Schindeln nach dem Namen).
#   * Kontext (Nachbargebaeude, importierte Koerper): neutral hellgrau (sRGB 0.78), matt.
#   * Glas: Transmission 1, Rauheit 0, IOR 1.5, leichte Toenung; fuer Schattenstrahlen durchsichtig, damit Sonne ins Innere kommt.
#   * Umgebungsverdeckung leicht (Cycles-Weltoption `ao_factor`), dazu die globale Beleuchtung mit 8 Abprallern.
#
# Ausgabe: Blender schreibt auf stdout "Sample x/y" (Cycles), dazu meldet das Skript Marken, die Dossier liest:
#     DOSSIER_STAGE <name>        Phase (import, materials, render, denoise)
#     DOSSIER_DONE <pfad.png>     fertig
#     DOSSIER_ERROR <text>        Abbruch mit Grund (Exit-Code 1)

import json
import math
import os
import re
import sys

import bpy
from mathutils import Matrix, Vector


def stage(name):
    print("DOSSIER_STAGE " + name, flush=True)


def script_args():
    """Argumente hinter dem `--` der Blender-Kommandozeile."""
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


# ---------------------------------------------------------------- Szene aufbauen

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_model(path):
    stage("import")
    if not os.path.exists(path):
        raise RuntimeError("Modell nicht gefunden: " + path)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("Das Modell enthaelt keine Koerper")
    return meshes


def is_context(obj):
    """Gelaende und importierte Kontext-Modelle (Nachbarn): zaehlen nicht zur Bildausschnitt-Berechnung."""
    return obj.name.startswith(("Gelaende", "Kontext"))


def bounds(objects):
    """Achsparallele Box (min, max) aller Objekte in Weltkoordinaten."""
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    for o in objects:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi


def socket(node, *names):
    """Eingang des Principled BSDF unter dem ersten vorhandenen Namen (Blender 3.x / 4.x heissen sie verschieden)."""
    for n in names:
        if n in node.inputs:
            return node.inputs[n]
    return None


def set_input(node, names, value):
    s = socket(node, *names)
    if s is not None:
        s.default_value = value


def strip_suffix(name):
    """`Beton.001` (Blender haengt bei doppelten Namen einen Zaehler an) -> `Beton`."""
    return re.sub(r"\.\d{3}$", "", name)


def ensure_nodes(datablock):
    """Knotenbaum sicherstellen (ab Blender 5 immer vorhanden, `use_nodes` ist dort veraltet)."""
    if datablock.node_tree is None:
        datablock.use_nodes = True
    return datablock.node_tree


def principled(mat):
    ensure_nodes(mat)
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


ALBEDO_MAX = 0.80  # linear; frischer weisser Putz ~0.8, nichts in der Natur reflektiert 100 Prozent


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(rgb):
    """sRGB-Tripel (0..1) -> linear."""
    return tuple(srgb_to_linear(float(c)) for c in rgb[:3])


def clamp_albedo(rgb_linear):
    return tuple(min(float(c), ALBEDO_MAX) for c in rgb_linear[:3])


def is_unset(color):
    """Weiss = vom Modell nicht gesetzt (Baustoff-Farbe #ffffff, der Look kommt aus der Bildkarte)."""
    return all(float(c) >= 0.97 for c in color[:3])


def make_glass(mat, spec):
    """Verglasung: Transmission statt Alpha-Blending, damit Cycles Brechung und Spiegelung rechnet.

    Physikalisch: klarer Glaskoerper, IOR 1.5, Rauheit 0, hauchduenn getoent. Fuer Schattenstrahlen ist die Scheibe
    durchsichtig (Mix mit Transparent ueber Light Path > Is Shadow Ray), sonst bliebe das Innere hinter Fenstern
    dunkel; das ist die uebliche Architektur-Naeherung fuer duenne Verglasung."""
    bsdf = principled(mat)
    if bsdf is None:
        return
    base = socket(bsdf, "Base Color")
    if base is not None:
        c = list(base.default_value)
        # Leichte Toenung, nie schwarz (Transmission faerbt mit der Basisfarbe).
        base.default_value = (0.90 + 0.10 * c[0], 0.94 + 0.06 * c[1], 0.95 + 0.05 * c[2], 1.0)
    set_input(bsdf, ("Alpha",), 1.0)
    set_input(bsdf, ("Transmission Weight", "Transmission"), float(spec.get("transmission", 1.0)))
    set_input(bsdf, ("Roughness",), 0.0)
    set_input(bsdf, ("IOR",), float(spec.get("ior", 1.5)))
    set_input(bsdf, ("Metallic",), 0.0)
    if hasattr(mat, "blend_method"):
        mat.blend_method = "OPAQUE"
    if hasattr(mat, "surface_render_method"):
        mat.surface_render_method = "DITHERED"
    nt = mat.node_tree
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if out is None:
        return
    lp = nt.nodes.new("ShaderNodeLightPath")
    clear = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lp.outputs["Is Shadow Ray"], mix.inputs["Fac"])
    nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
    nt.links.new(clear.outputs["BSDF"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])


def add_textures(mat, spec, base_dir):
    """Bildtexturen aus dem Material-System (ambientCG): Kachelung ueber Objektkoordinaten mit Box-Projektion.

    Das GLB traegt keine UV-Koordinaten. Die Box-Projektion (Bild je Achse, weiche Uebergaenge) legt die Textur
    in Metern fest (`sizeM` = Kantenlaenge einer Kachel) und kommt ohne UVs aus. Gibt zurueck, ob eine Farbkarte
    angebunden wurde."""
    bsdf = principled(mat)
    textures = spec.get("textures") or {}
    if bsdf is None or not textures:
        return False
    nt = mat.node_tree
    size = float(spec.get("sizeM") or 1.0)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    s = 1.0 / max(size, 1e-3)
    mapping.inputs["Scale"].default_value = (s, s, s)
    nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])

    def image_node(rel, colorspace):
        path = os.path.join(base_dir, rel)
        if not os.path.exists(path):
            return None
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = colorspace
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = img
        node.projection = "BOX"
        node.projection_blend = 0.25
        nt.links.new(mapping.outputs["Vector"], node.inputs["Vector"])
        return node

    has_color = False
    n = image_node(textures["color"], "sRGB") if "color" in textures else None
    if n is not None:
        has_color = True
        # Albedo begrenzen (ALBEDO_MAX): Textur * Faktor, damit helle Karten (Putz) nicht ausfressen.
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs[0].default_value = 1.0
        # Eingaenge nach Platz (Blender 3.4 bis 5): 6 = A (Farbe), 7 = B (Farbe), Ausgang 2 = Ergebnis (Farbe).
        mul.inputs[7].default_value = (ALBEDO_MAX, ALBEDO_MAX, ALBEDO_MAX, 1.0)
        nt.links.new(n.outputs["Color"], mul.inputs[6])
        nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    n = image_node(textures["roughness"], "Non-Color") if "roughness" in textures else None
    if n is not None:
        nt.links.new(n.outputs["Color"], bsdf.inputs["Roughness"])
    n = image_node(textures["metalness"], "Non-Color") if "metalness" in textures else None
    if n is not None:
        nt.links.new(n.outputs["Color"], bsdf.inputs["Metallic"])
    n = image_node(textures["normal"], "Non-Color") if "normal" in textures else None
    if n is not None:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 0.8
        nt.links.new(n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return has_color


# Ersatzlooks ohne Bildkarte: (Schluesselwoerter im Baustoffnamen) -> (Farbe sRGB, Rauheit, Metall).
ROOF_LOOKS = (
    (("ziegel", "biber", "dachstein"), (0.56, 0.25, 0.16), 0.7, 0.0),
    (("schindel",), (0.40, 0.28, 0.18), 0.85, 0.0),
    (("blech", "zink", "titan", "kupfer", "alu", "stehfalz"), (0.55, 0.57, 0.58), 0.35, 1.0),
    (("kies",), (0.46, 0.44, 0.41), 0.95, 0.0),
    (("schiefer", "faserzement", "eternit"), (0.22, 0.23, 0.25), 0.8, 0.0),
    (("begr", "substrat", "gras"), (0.30, 0.42, 0.18), 0.95, 0.0),
    (("bitumen", "abdicht", "folie"), (0.10, 0.10, 0.10), 0.7, 0.0),
)
ROOF_DEFAULT = ((0.34, 0.30, 0.28), 0.75, 0.0)
BUILDING_LOOKS = (
    (("backstein", "ziegel"), (0.60, 0.31, 0.22), 0.8, 0.0),
    (("beton",), (0.52, 0.52, 0.50), 0.85, 0.0),
    (("holz", "parkett", "lattung", "schalung", "bsp", "brettsperr"), (0.56, 0.40, 0.24), 0.65, 0.0),
    (("stahl", "metall", "alu"), (0.55, 0.57, 0.58), 0.4, 1.0),
    (("naturstein", "marmor", "granit"), (0.62, 0.60, 0.57), 0.5, 0.0),
    (("keramik", "fliese", "platte"), (0.75, 0.74, 0.72), 0.3, 0.0),
)
GRASS_SRGB = (0.33, 0.45, 0.18)
CONTEXT_SRGB = (0.78, 0.78, 0.77)


def pick_look(table, text):
    for words, color, rough, metal in table:
        if any(w in text for w in words):
            return color, rough, metal
    return None


def flat_look(mat, spec):
    """Material ohne Bildkarte: Farbe/Rauheit/Metall nach Verwendung (`role`), Baustoffname und gesetzter Farbe."""
    bsdf = principled(mat)
    if bsdf is None:
        return
    role = spec.get("role")
    text = (spec.get("component") or spec.get("name") or "").lower()
    color = tuple(spec.get("color") or (1.0, 1.0, 1.0))
    rough = float(spec.get("roughness", 0.9))
    metal = float(spec.get("metallic", 0.0))
    srgb = None
    if role == "terrain":
        srgb, rough, metal = GRASS_SRGB, 0.95, 0.0
    elif role == "context":
        srgb, rough, metal = CONTEXT_SRGB, 0.9, 0.0
    elif role == "roof":
        hit = pick_look(ROOF_LOOKS, text)
        if hit:
            srgb, rough, metal = hit
        elif is_unset(color):
            srgb, rough, metal = ROOF_DEFAULT
        # sonst gesetzte Farbe behalten
    elif is_unset(color):
        hit = pick_look(BUILDING_LOOKS, text)
        if hit:
            srgb, rough, metal = hit
    if srgb is not None:
        color = srgb
    set_input(bsdf, ("Base Color",), (*clamp_albedo(lin(color)), 1.0))
    set_input(bsdf, ("Roughness",), rough)
    set_input(bsdf, ("Metallic",), metal)


def base_color_of(mat):
    bsdf = principled(mat)
    s = socket(bsdf, "Base Color") if bsdf is not None else None
    return tuple(s.default_value)[:3] if s is not None else None


def pick_spec(mat, candidates):
    """Mehrere Eintraege gleichen Namens (z. B. zwei "Oeffnungsteil" in verschiedener Farbe): der mit der naechsten Farbe."""
    if len(candidates) == 1:
        return candidates[0]
    have = base_color_of(mat)
    if have is None:
        return candidates[0]
    def dist(spec):
        want = lin(spec.get("color") or (1.0, 1.0, 1.0))
        return sum(abs(a - b) for a, b in zip(have, want))
    return min(candidates, key=dist)


def apply_materials(specs, base_dir):
    stage("materials")
    by_name = {}
    for s in specs:
        by_name.setdefault(s["name"], []).append(s)
    for mat in bpy.data.materials:
        candidates = by_name.get(mat.name) or by_name.get(strip_suffix(mat.name))
        if not candidates:
            continue
        spec = pick_spec(mat, candidates)
        ensure_nodes(mat)
        if spec.get("glass"):
            make_glass(mat, spec)
        elif not add_textures(mat, spec, base_dir):
            flat_look(mat, spec)


# ---------------------------------------------------------------- Kamera

PRESET_DIRECTIONS = {
    # Blickrichtung (vom Auge zum Modell) in Modell-Koordinaten: x Ost, y Nord, z oben.
    "iso": (1.0, 1.0, -0.8),            # von Suedwesten oben
    "perspective": (1.0, 1.0, -0.55),
    "front": (0.0, 1.0, 0.0),           # Blick nach Norden (Suedansicht)
    "back": (0.0, -1.0, 0.0),
    "side": (-1.0, 0.0, 0.0),           # Blick nach Westen (Ostansicht)
    "right": (-1.0, 0.0, 0.0),
    "left": (1.0, 0.0, 0.0),
    "top": (0.0, 0.0, -1.0),
}
PRESET_ORTHO = {"iso", "front", "back", "side", "right", "left", "top"}


def camera_basis(direction, up):
    """Drehung, deren -Z die Blickrichtung und deren Y die Hochrichtung ist."""
    z = (-direction).normalized()
    x = up.cross(z)
    if x.length < 1e-6:
        x = Vector((1.0, 0.0, 0.0)).cross(z)
    x.normalize()
    y = z.cross(x)
    return Matrix(((x.x, y.x, z.x), (x.y, y.y, z.y), (x.z, y.z, z.z)))


def make_camera(spec, objects, width, height):
    stage("camera")
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("Dossier")
    cam = bpy.data.objects.new("Dossier", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    aspect = width / float(height)
    cam_data.sensor_fit = "VERTICAL"
    cam_data.sensor_height = 24.0
    cam_data.clip_start = 0.05
    cam_data.clip_end = 5000.0

    if "preset" in spec:
        preset = spec["preset"]
        # Gebaeude einpassen; gibt es nur Kontext (z. B. reines Gelaende), dann dieses.
        lo, hi = bounds([o for o in objects if not is_context(o)] or objects)
        center = (lo + hi) / 2.0
        radius = max((hi - lo).length / 2.0, 1.0)
        direction = Vector(PRESET_DIRECTIONS.get(preset, PRESET_DIRECTIONS["iso"])).normalized()
        up = Vector((0.0, 1.0, 0.0)) if preset == "top" else Vector((0.0, 0.0, 1.0))
        ortho = preset in PRESET_ORTHO
        if ortho:
            cam_data.type = "ORTHO"
            cam_data.ortho_scale = 2.2 * radius * max(1.0, 1.0 / aspect)
            position = center - direction * (radius * 3.0)
        else:
            fov = math.radians(50.0)
            cam_data.type = "PERSP"
            cam_data.lens = 12.0 / math.tan(fov / 2.0)
            half = min(fov / 2.0, math.atan(math.tan(fov / 2.0) * aspect))
            position = center - direction * (radius * 1.15 / math.sin(half))
    else:
        position = Vector(spec["position"])
        direction = Vector(spec["direction"]).normalized()
        up = Vector(spec.get("up") or (0.0, 0.0, 1.0))
        if spec.get("kind") == "orthogonal":
            cam_data.type = "ORTHO"
            cam_data.ortho_scale = float(spec.get("orthoHeight") or 10.0)
        else:
            fov = math.radians(float(spec.get("fovDeg") or 50.0))
            cam_data.type = "PERSP"
            cam_data.lens = 12.0 / math.tan(fov / 2.0)
    cam.matrix_world = Matrix.Translation(position) @ camera_basis(direction, up).to_4x4()
    return cam


# ---------------------------------------------------------------- Himmel, Sonne, Boden

def make_sky(sun):
    """Nishita-Himmel mit der Sonne an Azimut/Hoehe des Projekts. Cycles beleuchtet die Szene ueber die Sonnenscheibe."""
    stage("sky")
    scene = bpy.context.scene
    world = bpy.data.worlds.new("Dossier")
    scene.world = world
    nt = ensure_nodes(world)
    nt.nodes.clear()
    sky = nt.nodes.new("ShaderNodeTexSky")
    # Nishita (bis Blender 4.5) heisst ab 5.0 "Mehrfachstreuung" (MULTIPLE_SCATTERING), gleiche Parameter.
    for kind in ("NISHITA", "MULTIPLE_SCATTERING"):
        try:
            sky.sky_type = kind
            break
        except TypeError:
            continue
    # Unter dem Horizont gibt es keine Sonne; knapp darueber rendern (Daemmerung) statt schwarz.
    elevation = max(float(sun.get("elevation", 40.0)), 1.0)
    sky.sun_elevation = math.radians(elevation)
    # Cycles: Rotation 0 = Sonne im Norden (+Y), wachsend im Uhrzeigersinn = Kompass-Azimut.
    sky.sun_rotation = math.radians(float(sun.get("azimuth", 180.0)) % 360.0)
    sky.sun_disc = True
    sky.sun_size = math.radians(0.545)
    sky.sun_intensity = float(sun.get("intensity", 1.0))
    # Luft/Staub (Blender 3.x/4.x: air_density, dust_density; 5.x: aerosol_density) — nur setzen, was es gibt.
    for name in ("air_density", "dust_density", "aerosol_density", "ozone_density"):
        if hasattr(sky, name):
            setattr(sky, name, 1.0)
    # Leichte Umgebungsverdeckung (Cycles-Weltoption, in Blender 5 nur noch ao_factor/distance): dunkelt Ecken und Fugen
    # sanft ab, ohne die globale Beleuchtung zu ersetzen.
    ls = getattr(world, "light_settings", None)
    if ls is not None and hasattr(ls, "ao_factor"):
        ls.ao_factor = 0.4
        ls.distance = 1.5
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_ground(objects):
    """Grosse Bodenplatte knapp unter dem tiefsten Punkt des Modells: der Himmel unter dem Horizont ist dunkel,
    ohne Boden stuende das Haus im schwarzen Nichts. Ein vorhandenes Gelaende liegt darueber und bleibt sichtbar."""
    lo, hi = bounds(objects)
    size = max((hi - lo).length, 10.0) * 60.0
    mesh = bpy.data.meshes.new("Boden")
    h = size / 2.0
    cx, cy = (lo.x + hi.x) / 2.0, (lo.y + hi.y) / 2.0
    z = lo.z - 0.02
    mesh.from_pydata([(cx - h, cy - h, z), (cx + h, cy - h, z), (cx + h, cy + h, z), (cx - h, cy + h, z)], [], [(0, 1, 2, 3)])
    obj = bpy.data.objects.new("Boden", mesh)
    bpy.context.scene.collection.objects.link(obj)
    mat = bpy.data.materials.new("Boden")
    bsdf = principled(mat)
    # Erdig-gruen, matter als die Wiese des Gelaendes (Albedo von Gras/Erde ~0.1 bis 0.2 linear).
    set_input(bsdf, ("Base Color",), (*lin((0.40, 0.46, 0.28)), 1.0))
    set_input(bsdf, ("Roughness",), 0.95)
    obj.data.materials.append(mat)


# ---------------------------------------------------------------- Cycles

def setup_device(scene, wanted):
    """GPU (Metal, OptiX/CUDA, HIP, oneAPI), wenn vorhanden und gewuenscht, sonst CPU."""
    scene.cycles.device = "CPU"
    if wanted == "cpu":
        return "CPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
            except Exception:
                continue
            gpus = [d for d in prefs.devices if d.type != "CPU"]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type != "CPU" or kind == "METAL"
                scene.cycles.device = "GPU"
                return kind
        prefs.compute_device_type = "NONE"
    except Exception as e:  # kein Cycles-Zusatz o. ae.: CPU genuegt
        print("DOSSIER_NOTE GPU nicht verfuegbar: %s" % e, flush=True)
    return "CPU"


# Gemessene Strahldichte einer weissen (Albedo 1), waagrechten, besonnten Flaeche im Nishita-Himmel bei Sonnenstaerke 1.0
# (Cycles, Blender 5.3, Mittel ueber Sonne + Himmel, Luminanz) nach Sonnenhoehe in Grad. Die Werte sind weit ueber 1.0: Nishita
# rechnet absolut (Mittagssonne ~ 100 000 lx), die Kamera muss das wie in der Fotografie belichten.
SUNLIT_WHITE = ((1, 0.65), (3, 1.5), (6, 3.3), (10, 6.4), (15, 10.9), (20, 14.9), (30, 23.7), (45, 34.9), (60, 43.5), (70, 47.5), (90, 50.8))
# Gewuenschte Szenenhelligkeit einer weissen besonnten Flaeche (Albedo 1). Weisser Putz (0.8) liegt dann bei ~1.2, noch unter dem
# Weisspunkt der AgX-Kurve (Lichter laufen weich aus), Mittelgrau 0.18 bei ~0.27 (mittlere Anzeigehelligkeit).
SUNLIT_TARGET = 1.5


def auto_exposure(sun):
    """Belichtung in EV wie eine Kamera mit Belichtungsautomatik: besonnte weisse Flaeche -> SUNLIT_TARGET, je nach
    Sonnenhoehe (tiefe Sonne = weniger Licht = hellere Belichtung) und Sonnenstaerke. Sonst brennt Weiss aus (Nishita ~ 45 bei 60 Grad)."""
    elevation = max(float(sun.get("elevation", 40.0)), 1.0)
    strength = max(float(sun.get("intensity", 1.0)), 1e-3)
    value = SUNLIT_WHITE[-1][1]
    for (e0, v0), (e1, v1) in zip(SUNLIT_WHITE, SUNLIT_WHITE[1:]):
        if elevation <= e1:
            f = max(0.0, (elevation - e0) / (e1 - e0))
            value = math.exp(math.log(v0) * (1.0 - f) + math.log(v1) * f)
            break
    return max(-8.0, min(3.0, -math.log2(value * strength / SUNLIT_TARGET)))


def setup_cycles(spec):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    r = spec.get("resolution") or {}
    scene.render.resolution_x = int(r.get("width", 1920))
    scene.render.resolution_y = int(r.get("height", 1080))
    scene.render.resolution_percentage = 100
    scene.cycles.samples = int(spec.get("samples", 128))
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.use_denoising = bool(spec.get("denoise", True))
    if scene.cycles.use_denoising:
        try:
            scene.cycles.denoiser = "OPENIMAGEDENOISE"
        except Exception:
            pass
    # Standard-Belichtung (0 EV) mit AgX (Filmic, wo es fehlt): die Farbumsetzung komprimiert Lichter, Weiss frisst nicht aus.
    # In scene.json uebersteuerbar (`exposure` in EV, `sun.intensity`).
    for transform in ("AgX", "Filmic", "Standard"):
        try:
            scene.view_settings.view_transform = transform
            break
        except TypeError:
            continue
    for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue
    scene.view_settings.exposure = float(spec["exposure"]) if "exposure" in spec else auto_exposure(spec.get("sun") or {})
    scene.cycles.max_bounces = 8
    # Glas-Abpraller heissen je nach Version `glass_bounces` (3.x) oder `transmission_bounces` (4.x+).
    for name in ("transmission_bounces", "glass_bounces"):
        if hasattr(scene.cycles, name):
            setattr(scene.cycles, name, 8)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    kind = setup_device(scene, spec.get("device", "auto"))
    print("DOSSIER_NOTE Geraet: %s" % kind, flush=True)
    return scene


def main():
    args = script_args()
    if not args:
        raise RuntimeError("Aufruf: blender -b --python render_dossier.py -- <szene.json>")
    scene_path = os.path.abspath(args[0])
    base_dir = os.path.dirname(scene_path)
    with open(scene_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    reset_scene()
    objects = import_model(os.path.join(base_dir, spec.get("model", "model.glb")))
    apply_materials(spec.get("materials") or [], base_dir)
    scene = setup_cycles(spec)
    res = spec.get("resolution") or {}
    make_camera(spec.get("camera") or {"preset": "iso"}, objects, int(res.get("width", 1920)), int(res.get("height", 1080)))
    make_sky(spec.get("sun") or {})
    if spec.get("ground", True):
        add_ground(objects)

    out = os.path.join(base_dir, spec.get("output", "render.png"))
    scene.render.filepath = out
    stage("render")
    bpy.ops.render.render(write_still=True)
    if not os.path.exists(out):
        raise RuntimeError("Blender hat kein Bild geschrieben")
    print("DOSSIER_DONE " + out, flush=True)


try:
    main()
except Exception as exc:  # Fehlertext fuer Dossier, danach Exit-Code != 0
    print("DOSSIER_ERROR " + str(exc), flush=True)
    sys.exit(1)
