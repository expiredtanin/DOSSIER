// Schlanker, handgeschriebener DXF-Writer (ASCII, AutoCAD R2000/AC1015-kompatibel).
// Erzeugt eine gültige Datei mit HEADER-, TABLES- (LAYER) und ENTITIES-Sektion und
// korrektem EOF. Geometrie wird in MODELL-SPACE in ECHTEN Metern geschrieben
// ($INSUNITS = 6 = Meter); nachgelagerte Nutzer skalieren beim Plot.
//
// Bewusst minimaler Funktionsumfang (LINE, LWPOLYLINE, CIRCLE, ARC, TEXT), aber mit
// korrekten Gruppen-Codes, damit AutoCAD/LibreCAD/andere Viewer die Datei sauber
// öffnen. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

/** Ein Layer im DXF (Kategorie): Name, ACI-Farbindex, Linienstärke (mm × 100). */
export interface DxfLayer {
  /** Layer-Name (keine Leerzeichen/Sonderzeichen → werden bereinigt). */
  name: string;
  /** AutoCAD Color Index (1..255). */
  color: number;
  /** True-Color (0xRRGGBB) für Viewer mit 24-Bit-Farbe; optional. */
  trueColor?: number;
  /** Linienstärke in 1/100 mm (DXF-LWEIGHT-Konvention), z. B. 25 = 0.25 mm. */
  lineWeight: number;
}

/** 2D-Punkt (Meter, Modell-Space). */
export interface DxfPoint {
  x: number;
  y: number;
}

/**
 * Sammelt Entities und Layer und serialisiert sie zu einem gültigen DXF-String.
 * Alle Koordinaten sind Meter (Modell-Space). Der Y-Wert wird 1:1 übernommen
 * (DXF-Y zeigt wie das Weltmodell nach oben — keine Spiegelung wie beim SVG).
 */
export class DxfWriter {
  private layers = new Map<string, DxfLayer>();
  private entities: string[] = [];
  private handle = 0x100;

  /** Nächstes eindeutiges Entity-Handle (Hex), fortlaufend. */
  private nextHandle(): string {
    return (this.handle++).toString(16).toUpperCase();
  }

  /** Registriert einen Layer (idempotent über den Namen). */
  addLayer(layer: DxfLayer): void {
    const name = sanitizeLayerName(layer.name);
    if (!this.layers.has(name)) {
      this.layers.set(name, { ...layer, name });
    }
  }

  /** Stellt sicher, dass ein Layer existiert; liefert den bereinigten Namen. */
  private ensureLayer(name: string): string {
    const clean = sanitizeLayerName(name);
    if (!this.layers.has(clean)) {
      this.layers.set(clean, { name: clean, color: 7, lineWeight: 25 });
    }
    return clean;
  }

  addLine(layer: string, a: DxfPoint, b: DxfPoint): void {
    const l = this.ensureLayer(layer);
    this.entities.push(
      tag(0, "LINE"),
      tag(5, this.nextHandle()),
      tag(100, "AcDbEntity"),
      tag(8, l),
      tag(100, "AcDbLine"),
      num(10, a.x),
      num(20, a.y),
      num(30, 0),
      num(11, b.x),
      num(21, b.y),
      num(31, 0),
    );
  }

  /**
   * LWPOLYLINE (leichte 2D-Polylinie). `closed` setzt das Ringflag (Bit 1 in
   * Code 70), sodass die letzte Kante zurück zum ersten Punkt geschlossen wird.
   */
  addPolyline(layer: string, pts: DxfPoint[], closed: boolean): void {
    if (pts.length < 2) return;
    const l = this.ensureLayer(layer);
    this.entities.push(
      tag(0, "LWPOLYLINE"),
      tag(5, this.nextHandle()),
      tag(100, "AcDbEntity"),
      tag(8, l),
      tag(100, "AcDbPolyline"),
      tag(90, String(pts.length)),
      tag(70, closed ? "1" : "0"),
    );
    for (const p of pts) {
      this.entities.push(num(10, p.x), num(20, p.y));
    }
  }

  addCircle(layer: string, center: DxfPoint, r: number): void {
    const l = this.ensureLayer(layer);
    this.entities.push(
      tag(0, "CIRCLE"),
      tag(5, this.nextHandle()),
      tag(100, "AcDbEntity"),
      tag(8, l),
      tag(100, "AcDbCircle"),
      num(10, center.x),
      num(20, center.y),
      num(30, 0),
      num(40, r),
    );
  }

  /**
   * ARC — Bogen um `center` mit Radius `r`, von `startAngle` bis `endAngle`
   * (Grad, gegen den Uhrzeigersinn, DXF-Konvention).
   */
  addArc(
    layer: string,
    center: DxfPoint,
    r: number,
    startAngle: number,
    endAngle: number,
  ): void {
    const l = this.ensureLayer(layer);
    this.entities.push(
      tag(0, "ARC"),
      tag(5, this.nextHandle()),
      tag(100, "AcDbEntity"),
      tag(8, l),
      tag(100, "AcDbCircle"),
      num(10, center.x),
      num(20, center.y),
      num(30, 0),
      num(40, r),
      tag(100, "AcDbArc"),
      num(50, startAngle),
      num(51, endAngle),
    );
  }

  /** TEXT — einzeiliger Text, Höhe in Metern, an `at` (unten links). */
  addText(layer: string, at: DxfPoint, height: number, value: string): void {
    const l = this.ensureLayer(layer);
    this.entities.push(
      tag(0, "TEXT"),
      tag(5, this.nextHandle()),
      tag(100, "AcDbEntity"),
      tag(8, l),
      tag(100, "AcDbText"),
      num(10, at.x),
      num(20, at.y),
      num(30, 0),
      num(40, height),
      tag(1, sanitizeText(value)),
      tag(100, "AcDbText"),
    );
  }

  /** Anzahl bislang gesammelter Entities (für Tests/Validierung). */
  get entityCount(): number {
    // Jede Entity beginnt mit einem "0"-Gruppencode + Typ-Zeile.
    let n = 0;
    for (let i = 0; i < this.entities.length; i += 2) {
      if (this.entities[i] === "  0") n++;
    }
    return n;
  }

  /** Serialisiert die vollständige DXF-Datei als String (mit EOF). */
  build(): string {
    const out: string[] = [];
    out.push(...this.headerSection());
    out.push(...this.tablesSection());
    out.push(...this.entitiesSection());
    out.push(tag(0, "EOF"));
    return out.join("\r\n") + "\r\n";
  }

  private headerSection(): string[] {
    return [
      tag(0, "SECTION"),
      tag(2, "HEADER"),
      tag(9, "$ACADVER"),
      tag(1, "AC1015"), // AutoCAD 2000
      tag(9, "$INSUNITS"),
      tag(70, "6"), // 6 = Meter
      tag(9, "$MEASUREMENT"),
      tag(70, "1"), // 1 = metrisch
      tag(0, "ENDSEC"),
    ];
  }

  private tablesSection(): string[] {
    const out: string[] = [tag(0, "SECTION"), tag(2, "TABLES")];

    // LTYPE-Tabelle mit dem obligatorischen Continuous-Linetype (Viewer erwarten ihn).
    out.push(
      tag(0, "TABLE"),
      tag(2, "LTYPE"),
      tag(70, "1"),
      tag(0, "LTYPE"),
      tag(2, "CONTINUOUS"),
      tag(70, "0"),
      tag(3, "Solid line"),
      tag(72, "65"),
      tag(73, "0"),
      num(40, 0),
      tag(0, "ENDTAB"),
    );

    // LAYER-Tabelle: Layer 0 (Pflicht) + alle Kategorie-Layer.
    const layers = [...this.layers.values()];
    out.push(tag(0, "TABLE"), tag(2, "LAYER"), tag(70, String(layers.length + 1)));
    out.push(...this.layerRecord({ name: "0", color: 7, lineWeight: 25 }));
    for (const layer of layers) out.push(...this.layerRecord(layer));
    out.push(tag(0, "ENDTAB"));

    out.push(tag(0, "ENDSEC"));
    return out;
  }

  /** Ein LAYER-Datensatz (Name/Farbe/Linetype/Linienstärke, ggf. True-Color). */
  private layerRecord(layer: DxfLayer): string[] {
    const rec = [
      tag(0, "LAYER"),
      tag(5, this.nextHandle()),
      tag(100, "AcDbSymbolTableRecord"),
      tag(100, "AcDbLayerTableRecord"),
      tag(2, layer.name),
      tag(70, "0"), // Flags: nicht gefroren/gesperrt
      tag(62, String(layer.color)), // ACI-Farbindex
      tag(6, "CONTINUOUS"),
      tag(370, String(layer.lineWeight)), // Linienstärke in 1/100 mm
    ];
    // True-Color (Code 420, 24-Bit) für Viewer mit voller Farbtiefe.
    if (layer.trueColor != null) {
      rec.push(tag(420, String(layer.trueColor & 0xffffff)));
    }
    return rec;
  }

  private entitiesSection(): string[] {
    return [tag(0, "SECTION"), tag(2, "ENTITIES"), ...this.entities, tag(0, "ENDSEC")];
  }
}

/** Gruppen-Code-Zeile mit String-Wert (Code rechtsbündig auf 3 Stellen). */
function tag(code: number, value: string): string {
  return `${String(code).padStart(3, " ")}\n${value}`;
}

/** Gruppen-Code-Zeile mit Zahl-Wert (feste, kompakte Dezimaldarstellung). */
function num(code: number, value: number): string {
  return `${String(code).padStart(3, " ")}\n${fmt(value)}`;
}

/** Kompakte, verlustarme Zahlformatierung (bis 6 Nachkommastellen, ohne Nullen). */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0.0";
  const s = v.toFixed(6);
  // Nachlaufende Nullen entfernen, aber mindestens eine Nachkommastelle behalten.
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
}

/**
 * Bereinigt einen Layer-Namen: DXF-verbotene Zeichen (< > / \ " : ; ? * | = `)
 * und Leerzeichen werden zu „_". Leerer Name → "0".
 */
export function sanitizeLayerName(name: string): string {
  const clean = name
    .trim()
    .replace(/[<>/\\":;?*|=`]/g, "_")
    .replace(/\s+/g, "_");
  return clean.length ? clean : "0";
}

/** Entfernt Zeilenumbrüche aus TEXT-Werten (einzeilige TEXT-Entity). */
function sanitizeText(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}
