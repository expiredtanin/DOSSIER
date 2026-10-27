#!/usr/bin/env python3
"""Verschiebt TS-Module (git mv) und schreibt alle relativen Imports im Projekt um.
Aufruf: scripts/move-modules.py alt1=neu1 alt2=neu2 …  (Pfade mit Endung, relativ zum Repo)
Importe werden über den aufgelösten Zielpfad (ohne Endung) erkannt — auch aus den verschobenen
Dateien selbst und aus Testdateien."""
import re, glob, os, subprocess, sys

moves = dict(a.split('=') for a in sys.argv[1:])
strip = lambda p: re.sub(r'\.(tsx?|test\.tsx?)$', '', p)
base_moves = {strip(o): strip(n) for o, n in moves.items()}
old_loc = {n: o for o, n in moves.items()}  # neuer Pfad -> alter Pfad

for o, n in moves.items():
    os.makedirs(os.path.dirname(n), exist_ok=True)
    subprocess.check_call(['git', 'mv', o, n])

def rel(frm, to):
    r = os.path.relpath(to, os.path.dirname(frm))
    return r if r.startswith('.') else './' + r

spec_re = re.compile(r'((?:from|import)\s*\(?\s*["\'])(\.[^"\']*)(["\'])')
for f in glob.glob('src/**/*.ts*', recursive=True) + glob.glob('scripts/*.ts') + glob.glob('scripts/*.mjs'):
    s = open(f).read()
    where_old = old_loc.get(f, f)  # Auflösung relativ zum ALTEN Ort der Datei
    def fix(m):
        spec = m.group(2)
        target = os.path.normpath(os.path.join(os.path.dirname(where_old), spec))
        new_target = base_moves.get(target, target)
        if new_target == target and where_old == f:
            return m.group(0)
        return m.group(1) + rel(f, new_target) + m.group(3)
    n = spec_re.sub(fix, s)
    if n != s:
        open(f, 'w').write(n)
