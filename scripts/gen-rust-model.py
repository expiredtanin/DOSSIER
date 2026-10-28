#!/usr/bin/env python3
"""Einmaliger Übersetzer: TS-Modelltypen -> Rust-Strukturen (serde) für src-tauri/core/src/model/generated.rs.

Zweck: Startpunkt für [K4] S2/S4. Danach gehört die Rust-Datei dem Kern (von Hand gepflegt, TS-Typen
kommen künftig aus Rust). Nicht für den Dauerbetrieb gedacht.
"""
import re, sys, json

SRC = [
    "src/model/types.ts", "src/model/viewTypes.ts", "src/text/richText.ts", "src/geometry/roomArea.ts",
]
# Typen, die von Hand geschrieben sind (diskriminierte Unions o. ä.) oder ersetzt werden
MANUAL = {"Vec2", "Drawing2DGeom", "VerticalAnchor", "ColumnProfile", "LayoutAnnotation", "ParametricRule",
          "LayoutAnnotationPatch", "ContextObject", "BuiltinPaletteBank", "SiaKey", "SiaAggregate",
          "BoolMark", "TextRange"}
TAGGED = {"GridRule", "ModuleRule", "ConditionalThicknessRule", "ReferenceLineRule", "SequenceRule", "ImportedMesh", "ContourSet", "TerrainMesh", "ContextImage"}
RENAMES = {"OpeningKind2": "ElementKind"}
ONLY = None  # alle Interfaces aus SRC, die erreichbar sind

def strip_comments(s):
    s = re.sub(r"/\*.*?\*/", "", s, flags=re.S)
    s = re.sub(r"(?m)//.*$", "", s)
    return s

TOK = re.compile(r'\s*(?:(?P<str>"(?:[^"\\]|\\.)*")|(?P<num>-?\d+(?:\.\d+)?)|(?P<id>[A-Za-z_$][\w$]*)|(?P<p>=>|[{}\[\]()<>;:,|?=&*.]))')

def tokenize(s):
    pos = 0; out = []
    while pos < len(s):
        m = TOK.match(s, pos)
        if not m:
            if s[pos:].strip() == "": break
            pos += 1; continue
        pos = m.end()
        for k in ("str", "num", "id", "p"):
            if m.group(k) is not None:
                out.append((k, m.group(k))); break
    return out

class P:
    def __init__(self, toks): self.t = toks; self.i = 0
    def peek(self, o=0): return self.t[self.i + o] if self.i + o < len(self.t) else (None, None)
    def next(self): v = self.t[self.i]; self.i += 1; return v
    def eat(self, v):
        if self.peek()[1] == v: self.i += 1; return True
        return False

def parse_type(p):
    alts = []
    p.eat("|")
    while True:
        alts.append(parse_primary(p))
        if not p.eat("|"): break
    return alts[0] if len(alts) == 1 else ("union", alts)

def parse_primary(p):
    k, v = p.peek()
    if v == "(":
        p.next(); t = parse_type(p); p.eat(")"); base = t
    elif k == "str":
        p.next(); base = ("lit", json.loads(v))
    elif k == "num":
        p.next(); base = ("numlit", float(v))
    elif v == "{":
        p.next(); fields = parse_fields(p); p.eat("}"); base = ("obj", fields)
    elif v == "[":
        p.next(); items = [parse_type(p)]
        while p.eat(","): items.append(parse_type(p))
        p.eat("]"); base = ("tuple", items)
    elif k == "id":
        p.next()
        if v == "keyof":
            parse_primary(p); base = ("keyof",)
        else:
            args = []
            if p.peek()[1] == "<":
                p.next(); args.append(parse_type(p))
                while p.eat(","): args.append(parse_type(p))
                p.eat(">")
            base = ("ref", v, args)
    else:
        raise SyntaxError(f"unerwartet {p.peek()} @ {p.i}")
    while p.peek()[1] == "[" and p.peek(1)[1] == "]":
        p.next(); p.next(); base = ("array", base)
    return base

def parse_fields(p):
    fields = []
    while p.peek()[1] not in ("}", None):
        k, name = p.next()
        if k == "str": name = json.loads(name)
        opt = p.eat("?")
        p.eat(":")
        t = parse_type(p)
        p.eat(";") or p.eat(",")
        fields.append((name, opt, t))
    return fields

def parse_file(path):
    text = strip_comments(open(path).read())
    toks = tokenize(text)
    out = {}
    i = 0
    while i < len(toks):
        if toks[i][1] == "export" and toks[i+1][1] in ("interface", "type") and toks[i+2][0] == "id":
            kind = toks[i+1][1]; name = toks[i+2][1]
            j = i + 3
            try:
                p = P(toks); p.i = j
                if kind == "interface":
                    while p.peek()[1] != "{": p.next()
                    p.next(); fields = parse_fields(p); p.eat("}")
                    out[name] = ("interface", fields)
                else:
                    if p.peek()[1] == "<": 
                        i += 1; continue
                    p.eat("=")
                    out[name] = ("alias", parse_type(p))
                i = p.i
                continue
            except Exception as e:
                sys.stderr.write(f"skip {name}: {e}\n")
        i += 1
    return out

def snake(n):
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", n).lower()
    kw = {"type", "match", "ref", "box", "move", "in", "loop", "impl", "fn", "use", "mod", "as", "where", "for", "if", "else", "while", "static", "const", "struct", "enum", "trait", "pub", "let", "mut", "return", "break", "continue", "dyn", "async", "await", "try", "yield", "unsafe", "extern", "abstract", "final", "override", "macro", "typeof", "virtual", "become", "do", "priv", "unsized"}
    if s in ("super", "self", "crate", "Self"):
        return s + "_"
    return "r#" + s if s in kw else s

def pascal(v):
    parts = re.split(r"[^A-Za-z0-9]+", v)
    s = "".join(x[:1].upper() + x[1:] for x in parts if x)
    if not s or s[0].isdigit(): s = "V" + s
    return s

decls = {}
for f in SRC:
    decls.update(parse_file(f))

out_items = []   # generated rust texts
emitted = set()
enum_counter = {}
enum_lits = {}

PRIM = {"string": "String", "number": "f64", "boolean": "bool", "unknown": "serde_json::Value", "any": "serde_json::Value", "null": "()"}

def rust_enum(name, lits):
    seen = set(); lines = []
    for l in lits:
        v = pascal(l)
        base = v; n = 2
        while v in seen: v = f"{base}{n}"; n += 1
        seen.add(v)
        lines.append(f'    #[serde(rename = {json.dumps(l, ensure_ascii=False)})]\n    {v},')
    lines[0] = "    #[default]\n" + lines[0]
    return ("#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]\n"
            f"pub enum {name} {{\n" + "\n".join(lines) + "\n}\n")

def rtype(t, ctx):
    """-> (rust_type, is_option)"""
    k = t[0]
    if k == "ref":
        n, args = t[1], t[2]
        if n in PRIM: return PRIM[n], False
        if n == "Record": return f"std::collections::BTreeMap<String, {rtype(args[1], ctx)[0]}>", False
        if n == "Partial": return "serde_json::Value", False
        if n == "Array": return f"Vec<{rtype(args[0], ctx)[0]}>", False
        if n == "Date": return "String", False
        ensure(n)
        return n, False
    if k == "array":
        return f"Vec<{rtype(t[1], ctx)[0]}>", False
    if k == "tuple":
        if len(t[1]) == 2 and t[1][0] == t[1][1]:
            return f"[{rtype(t[1][0], ctx)[0]}; 2]", False
        return "serde_json::Value", False
    if k == "lit": return "String", False
    if k == "numlit": return "f64", False
    if k == "keyof": return "String", False
    if k == "obj":
        name = ctx
        emit_struct(name, t[1])
        return name, False
    if k == "union":
        alts = [a for a in t[1] if not (a[0] == "ref" and a[1] in ("undefined",))]
        had_undef = len(alts) != len(t[1])
        nulls = [a for a in alts if a[0] == "ref" and a[1] == "null"]
        alts = [a for a in alts if not (a[0] == "ref" and a[1] == "null")]
        opt = had_undef or bool(nulls)
        if len(alts) == 1:
            r, _ = rtype(alts[0], ctx); return (f"Option<{r}>" if nulls else r), had_undef
        if all(a[0] == "lit" for a in alts):
            lits = [a[1] for a in alts]
            ename = ctx
            n = 1
            while ename in enum_lits and enum_lits[ename] != lits:
                n += 1; ename = f"{ctx}{n}"
            if ename not in emitted:
                emitted.add(ename); enum_lits[ename] = lits; out_items.append(rust_enum(ename, lits))
            return ename, opt
        if all(a[0] == "numlit" for a in alts): return "f64", opt
        return "serde_json::Value", opt
    raise ValueError(t)

def emit_struct(name, fields):
    if name in emitted: return
    emitted.add(name)
    lines = []
    for fname, opt, t in fields:
        if fname == "type" and name in TAGGED:
            continue  # Tag steckt im umgebenden Enum (model/manual.rs)
        sub = name + pascal(fname)
        r, uopt = rtype(t, sub)
        is_opt = opt or uopt
        rn = snake(fname)
        attrs = []
        if rn.replace("r#", "") != fname:
            attrs.append(f'rename = {json.dumps(fname)}')
        if r.startswith("Option<"):
            attrs.append('default')
            if is_opt:
                attrs.append('skip_serializing_if = "Option::is_none"')
            # sonst `T | null` ohne `?`: Feld ist da, darf null sein -> beim Schreiben `null` ausgeben
        elif is_opt:
            attrs.append('default'); attrs.append('skip_serializing_if = "Option::is_none"')
            r = f"Option<{r}>"
        a = f"    #[serde({', '.join(attrs)})]\n" if attrs else ""
        lines.append(f"{a}    pub {rn}: {r},")
    out_items.append("#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]\n"
                     + '#[serde(default)]\n'
                     + '#[cfg_attr(test, serde(deny_unknown_fields))]\n'
                     + f"pub struct {name} {{\n" + "\n".join(lines) + "\n}\n")

def ensure(n):
    if n in emitted or n in MANUAL: return
    d = decls.get(n)
    if d is None:
        sys.stderr.write(f"unbekannt: {n}\n"); return
    if d[0] == "interface":
        emit_struct(n, d[1])
    else:
        t = d[1]
        if t[0] == "union" and all(a[0] == "lit" for a in t[1]):
            emitted.add(n); enum_lits[n] = [a[1] for a in t[1]]; out_items.append(rust_enum(n, [a[1] for a in t[1]]))
        elif t[0] == "lit":
            emitted.add(n); out_items.append(rust_enum(n, [t[1]]))
        else:
            emitted.add(n)
            r, _ = rtype(t, n)
            out_items.append(f"pub type {n} = {r};\n")

for root in sys.argv[1:] or ["Project"]:
    ensure(root)

print("// GENERIERT von scripts/gen-rust-model.py aus den TS-Typen (Stand 28.10.), danach von Hand gepflegt.\n"
      "// Rust-Gegenstück zu src/model/types.ts ([K4] S2). Union-Typen mit Tag stehen in model/manual.rs.\n"
      "#![allow(clippy::large_enum_variant)]\n"
      "use super::manual::*;\nuse serde::{Deserialize, Serialize};\n")
body = "\n".join(out_items)
for a, b in RENAMES.items():
    body = body.replace(a, b)
print(body)
