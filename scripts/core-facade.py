#!/usr/bin/env python3
"""Erzeugt src/core/index.ts aus den Importen der Hülle in plan/ und geometry/ und schreibt die
Importe der Hülle auf "core" um (Phase A der Kern/UI-Trennung, docs/core-ui-split.md).
Aufruf: scripts/core-facade.py [--dry]"""
import re, glob, os, sys, collections
SHELL = ['ui','panels','views','menus','editors','viewport','native','tools','state','commands']
FACADE_DIRS = ('plan', 'geometry')
imp_re = re.compile(r'''import\s+(type\s+)?\{([^}]*)\}\s+from\s+["'](\.[^"']*)["'];?[ \t]*\n''', re.S)

# Namen, die ein Modul nur weiterreicht — kanonisch aus dem Ursprungsmodul exportieren.
CANON = {
    'buildDrawingIndex': 'src/geometry/drawingIndex', 'DrawingIndex': 'src/geometry/drawingIndex',
    'drawingsWithinDistance': 'src/geometry/drawingIndex', 'nearestInDrawings': 'src/geometry/drawingIndex',
    'Primitive': 'src/plan/generatePlan/shared',
}

def shell_file(f):
    parts = f.split('/')
    top = parts[1] if len(parts) > 2 else parts[1].split('.')[0]
    return top in SHELL or top in ('App', 'main')

uses = collections.defaultdict(dict)  # name -> {module: is_type_only}
edits = {}
for f in glob.glob('src/**/*.ts*', recursive=True):
    if '.test.' in f or not shell_file(f): continue
    s = open(f).read()
    out = s
    for m in imp_re.finditer(s):
        tgt = os.path.normpath(os.path.join(os.path.dirname(f), m.group(3)))
        tp = tgt.split('/')
        if len(tp) < 3 or tp[0] != 'src' or tp[1] not in FACADE_DIRS: continue
        all_type = bool(m.group(1))
        for raw in m.group(2).split(','):
            raw = raw.strip()
            if not raw: continue
            is_t = all_type or raw.startswith('type ')
            nm = raw[5:].strip() if raw.startswith('type ') else raw
            orig = nm.split(' as ')[0].strip()
            tgt2 = CANON.get(orig, tgt)
            prev = uses[orig].get(tgt2)
            uses[orig][tgt2] = (prev if prev is not None else True) and is_t
    edits[f] = s

# Kollisionen: gleicher Name aus mehreren Modulen
coll = {n: m for n, m in uses.items() if len(m) > 1}
if coll:
    print('Namenskollisionen (werden mit Modul-Präfix aliasiert):')
    for n, m in coll.items(): print(' ', n, list(m))

def alias(n, mod):
    if n not in coll: return n
    return n + '__' + re.sub(r'\W+', '_', mod[len('src/'):])

lines = ['// Fassade des Kerns für die Hülle (Phase A der Kern/UI-Trennung, docs/core-ui-split.md).',
         '// Dünne Durchreichung, Namen 1:1; die Hülle importiert Plan-/Geometrie-Funktionen nur noch von hier.',
         '// Erzeugt mit scripts/core-facade.py — neue Einträge von Hand ergänzen.', '']
bymod = collections.defaultdict(list)
for n, mods in uses.items():
    for mod, is_t in mods.items(): bymod[mod].append((n, is_t))
for mod in sorted(bymod):
    rel = '../' + mod[len('src/'):]
    items = []
    for n, is_t in sorted(bymod[mod]):
        a = alias(n, mod)
        core = f'{n} as {a}' if a != n else n
        items.append(('type ' if is_t else '') + core)
    lines.append('export {\n  ' + ',\n  '.join(items) + f',\n}} from "{rel}";')
    lines.append('')
os.makedirs('src/core', exist_ok=True)
if '--dry' not in sys.argv:
    open('src/core/index.ts', 'w').write('\n'.join(lines))

def rel_core(f):
    r = os.path.relpath('src/core', os.path.dirname(f))
    return r if r.startswith('.') else './' + r

changed = 0
if '--dry' not in sys.argv:
    for f, s in edits.items():
        keep_stmts = []
        core_items = []
        def fix(m):
            tgt = os.path.normpath(os.path.join(os.path.dirname(f), m.group(3)))
            tp = tgt.split('/')
            if len(tp) < 3 or tp[0] != 'src' or tp[1] not in FACADE_DIRS: return m.group(0)
            all_type = bool(m.group(1))
            items = []
            for raw in m.group(2).split(','):
                raw = raw.strip()
                if not raw: continue
                is_t = all_type or raw.startswith('type ')
                nm = raw[5:].strip() if raw.startswith('type ') else raw
                orig, _, loc = nm.partition(' as ')
                a = alias(orig.strip(), CANON.get(orig.strip(), tgt))
                spec = (a if a == orig.strip() else f'{a} as {orig.strip()}') if not loc else f'{a} as {loc.strip()}'
                items.append(('type ' if is_t and not all_type else '') + spec)
            kw = 'import type' if all_type else 'import'
            return f'{kw} {{ {", ".join(items)} }} from "{rel_core(f)}";\n'
        n = imp_re.sub(fix, s)
        if n != s:
            open(f, 'w').write(n); changed += 1
    print('umgeschrieben:', changed, 'Dateien;', len(uses), 'Namen')
