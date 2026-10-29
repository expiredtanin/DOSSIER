// Gemeinsame Grundlage des Grundriss-Generators: das `Primitive`-Vokabular
// (das EINZIGE Austauschformat zwischen `generatePlan()`, Schnitt/Ansicht
// und den Domänen — unter `generatePlan/` in TS, die meisten im Rust-Kern mit
// derselben JSON-Form, `src-tauri/core/src/plan/prim.rs`), die By-Layer/By-Object-
// Attribut-Auflösung (`resolve*`) sowie die Papier-mm-/Tinten-Konstanten, die
// über mehrere Domänen hinweg identisch gelten müssen (SIA-Poché, Haarlinien).
//
// Jede Datei unter `generatePlan/` importiert von hier, NIE von `../generatePlan`
// selbst — das hielte die Orchestrator-Datei (`generatePlan.ts`) andernfalls in
// einem Zirkelimport mit jeder einzelnen Domäne.

import type {
  AttributeSource,
  Component,
  HatchPattern,
  HatchStyle,
  LayerCategory,
  Project,
  Vec2,
} from "../../model/types";
import { getHatch, getLineStyle } from "../../model/types";
import type { Marks, RichTextDoc } from "../../text/richText";
import type { RoomStampLine } from "../../model/roomStamp";

/**
 * Detailgrad der Plan-Darstellung (Oberleiste „grob/mittel/fein"). Steuert hier
 * konkret zwei Dinge im Grundriss:
 *  • Tür-/Fenstersymbole: grob = nur Öffnungs-Lücke + gerade Türblatt-Linie;
 *    mittel = + Schwenkbogen; fein = + Rahmen/Anschlag-Striche.
 *  • Schraffuren + Linienfeinheit: grob = vereinfachte Poché (eine Sammelfläche
 *    ohne Schraffur, dickere Umrisslinie); mittel = aktueller mehrschichtiger
 *    Aufbau mit Schraffuren; fein = volle Schraffuren + dünnere Linien.
 *
 * NOCH OFFEN (folgt, sobald die Features existieren — hier bewusst KEIN
 * Schein-Effekt): Bemaßung/Beschriftung werden mit dem Detailgrad auf-/abblenden
 * (Maßketten, Raumstempel), und die 3D-Geometrie-Auflösung (z. B. Profil-
 * Rundungen, Tritt-/Setzstufen) wird ebenfalls dem Detailgrad folgen, sobald
 * Bemaßung bzw. eine feinere 3D-Tessellierung implementiert sind.
 */
export type DetailLevel = "grob" | "mittel" | "fein";

/** Stroke-Farbe der Schicht-Polygone (neutrales Schwarz, geteilte Tinte mit der Schraffur). */
export const POCHE_STROKE = "#1a1a1a";

/** Tinte für den Schwarz-Weiss-Modus: einheitliches Dunkel für alle Striche. */
export const MONO_INK = "#111111";

// ── Linienstärken in PAPIER-Millimeter (vgl. docs/design/plans-output.md §3.2) ──
// Alle Stricharten sind in mm Papier definiert; die PlanView rechnet sie über
// dpi = 96 in konstante Bildschirm-Pixel um (non-scaling-stroke), damit Linien
// beim Zoomen ihre Papiergröße behalten und der Massstab stimmt.

/** Default-Schichtfuge zwischen den Materialschichten in mm — Haarlinie (0.02),
 *  gleiche Stärke wie die Schraffur-Tinte. Pro Fuge im Wandstil überschreibbar
 *  (z. B. 0.13, wenn zwei massive Materialien aufeinandertreffen). */
export const LAYER_LINE_MM = 0.02;
// Strichstärken und -muster der Bauteil-Domänen (Symbole, Überkopf, Dach, Detailgrad-Faktoren) stehen
// seit [K3d] im Kern (`src-tauri/core/src/plan/style.rs`).
/** Default-Umrandungs-Strichstärke (mm), falls die Kategorie keine lw trägt
   (Grundeinstellung für „normale Elemente"). */
export const WALL_FALLBACK_MM = 0.18;

/**
 * Aufgelöste Schraffur eines Polygons — alle Werte stammen aus einer
 * HatchStyle-Ressource (Muster/Maßstab/Winkel/Farbe) plus dem optional
 * verknüpften LineStyle (Linienstärke/Strichmuster der Musterlinien). Die
 * PlanView ist damit rein darstellend und kennt das Projekt nicht.
 */
export interface HatchRender {
  pattern: HatchPattern;
  scale: number;
  angle: number;
  /**
   * AUFGELÖSTE Farbe der Musterlinien bzw. der Vollfüllung (pattern==="solid").
   * Ergebnis der Farb-Resolve-Kette (siehe {@link resolveHatch}): Vordergrund =
   * (Attribut-Override) ?? (Component.foreground) ?? (HatchStyle.color, Backward-
   * Compat) ?? Default. Der heutige SVG-/GL-/DXF-Renderer liest weiterhin nur
   * dieses Feld — die Kette ist zur Renderzeit bereits kollabiert.
   */
  color: string;
  /**
   * Ankerpunkt des Musterrasters (Modellkoordinaten). Fehlt er, ist es der
   * Modellursprung — dadurch teilen benachbarte Flächen dieselbe Musterphase
   * (s. `hatchLineFamily`). Gesetzt wird er über `Drawing2D.hatchOrigin`.
   */
  origin?: Vec2;
  /** Linienstärke der Musterlinien in mm. */
  lineWeight: number;
  /** Strichmuster der Musterlinien in mm; null = durchgezogen. */
  dash: number[] | null;
  /**
   * Schraffur-Typ (additiv). `undefined`/"vector" ⇒ Muster nach `pattern` (heutiges
   * Verhalten); "image" ⇒ Bild-Muster (`image`); "gradient" ⇒ Farbverlauf
   * (`gradient`). Bestehende Renderer ignorieren `kind` und zeichnen nach
   * `pattern` → unbekannte kinds fallen auf heute zurück.
   */
  kind?: "vector" | "image" | "gradient";
  /** Vektor-Untermodus (additiv). `undefined`/"parallel" ⇒ regelmäßig; "random" ⇒ zufällig. */
  lines?: "parallel" | "random";
  /** Bild-Muster-Parameter (nur `kind==="image"`); durchgereicht aus dem HatchStyle. */
  image?: { src: string; scaleX: number; scaleY: number; rotation: number };
  /** Farbverlauf-Parameter (nur `kind==="gradient"`); durchgereicht aus dem HatchStyle. */
  gradient?: { color1: string; color2: string; angle: number; type: "linear" | "radial" };
  /**
   * Steuer-Parameter der Random-Vektor-Streuung (nur `lines==="random"`), 1:1 aus
   * dem HatchStyle durchgereicht. Alle optional — die eigentliche Erzeugung/
   * Default-Auflösung liegt zentral in `glPlan/glPlanHatch.ts` (single render truth).
   */
  seed?: number;
  density?: number;
  lengthMin?: number;
  lengthMax?: number;
  /** Frei gezeichnetes Wiederhol-Motiv (nur `pattern==="custom"`); 1:1 aus dem HatchStyle durchgereicht. */
  motif?: HatchStyle["motif"];
}

/**
 * Render-Entscheidung je Kategorie-Code für den Grundriss (vgl. ItemDisplay aus
 * dem Panel-Darstellungsmodus). `render`=false blendet die Kategorie ganz aus,
 * `greyed`=true zeichnet sie gedimmt, `locked`=true (nur Modus „grey_locked")
 * verbietet die Anwahl (siehe App.tsx onPlanSelect). Wird kein Resolver
 * übergeben, gilt für jede sichtbare Kategorie {render:true, greyed:false,
 * locked:false} (bisheriges Verhalten).
 */
export interface CategoryDisplay {
  render: boolean;
  greyed: boolean;
  locked: boolean;
}

/** Funktion, die je Kategorie-Code die Render-Entscheidung liefert. */
export type CategoryDisplayResolver = (code: string) => CategoryDisplay;

/** Standard-Resolver: jede (bereits gefilterte) Kategorie normal zeichnen. */
export const SHOW_ALL: CategoryDisplayResolver = () => ({ render: true, greyed: false, locked: false });

export type Primitive =
  | {
      kind: "polygon";
      pts: Vec2[];
      /** Füllfarbe (Component-Poché) bzw. "none" für reine Umrisslinien. */
      fill: string;
      stroke: string;
      /** Umriss-Strichstärke in PAPIER-Millimeter (siehe oben). */
      strokeWidthMm: number;
      hatch: HatchRender;
      /** Gedimmt zeichnen (Darstellungsmodus „andere grau"). */
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
      /**
       * Kanten-Indizes, die NICHT umrissen (gestrichen) werden dürfen — die Füllung
       * bleibt das volle Polygon. Kante `i` läuft von `pts[i]` nach `pts[(i+1)%n]`.
       * Damit werden die inneren Gehrungs-/Stoß-Stirnflächen an einer Wandecke
       * unterdrückt: die Diagonale, an der GLEICHFARBIGE Schichten zweier Wände
       * aneinanderstoßen, würde sonst als sichtbare 45°-Naht erscheinen und der
       * Umriss würde als Barbe über den Eck-Apex hinausschießen (Gehrungs-Spitze).
       * Längskanten (Schichtfugen zwischen VERSCHIEDENEN Materialien) bleiben
       * gestrichen — nur die Stoß-Stirnkanten am Knoten entfallen.
       */
      noStrokeEdges?: number[];
      /**
       * ID der Wand, zu der dieses Schicht-/Umriss-Polygon gehört (für die
       * Links-Klick-Auswahl: die PlanView markiert ALLE Polygone derselben
       * Wand und meldet die wallId nach oben). Reine Umriss-/Symbol-Primitive
       * ohne Wandbezug lassen das Feld weg.
       */
      wallId?: string;
      /**
       * ID des 2D-Zeichenelements (Drawing2D), falls dieses gefüllte Polygon eine
       * geschlossene 2D-Form ist (für die Links-Klick-Auswahl der Fläche).
       */
      drawingId?: string;
      /**
       * ID der Decke (Ceiling), falls dieses Polygon eine Decken-Fläche/-Umriss
       * ist (für die Links-Klick-Auswahl der Decke).
       */
      ceilingId?: string;
      /** ID der Öffnung (Fenster/Tür), z. B. der Fensterrahmen (Auswahl). */
      openingId?: string;
      /** ID der Treppe (Stair), falls dieses Polygon ein Tritt/Podest ist (Auswahl). */
      stairId?: string;
      /** ID des Raums (Room), falls dieses Polygon eine Raum-Fläche ist (Auswahl). */
      roomId?: string;
      /**
       * ID des extrudierten Körpers (truck-Integration), falls dieses Polygon der
       * Grundriss-Footprint einer Extrusion ist (für eine spätere Links-Klick-
       * Auswahl — heute nur zur Nachvollziehbarkeit getaggt, noch nicht verdrahtet).
       */
      extrudedSolidId?: string;
      /**
       * ID des Kontext-Objekts (importiertes Gebäude/Terrain, `project.context`),
       * falls dieses (unsichtbare) Pick-Band dessen Grundriss-Bounding-Box
       * umhüllt (Links-Klick-Auswahl — analog `sectionLineId`, s. u.).
       */
      contextObjectId?: string;
      /**
       * ID der Stütze (Column), falls dieses Polygon der Grundriss-Querschnitt
       * (Poché) einer Stütze ist (für die Links-Klick-Auswahl der Fläche).
       */
      columnId?: string;
      /** ID des Dachs (Roof), falls dieses (unsichtbare) Polygon der Traufe-Umriss ist (Auswahl). */
      roofId?: string;
      /**
       * ID der Schnitt-/Ansichtslinie (DrawingLevel), falls dieses (unsichtbare)
       * Pick-Band das Schnittführungs-Symbol umhüllt (für die Links-Klick-Auswahl
       * der Schnittlinie im Grundriss).
       */
      sectionLineId?: string;
    }
  | {
      kind: "line";
      a: Vec2;
      b: Vec2;
      cls: string;
      /** Strichstärke in mm Papier (non-scaling). */
      weightMm: number;
      /** Strichmuster in mm Papier; null/undefined = durchgezogen. */
      dash?: number[] | null;
      /**
       * Zickzack-/Wellen-Parameter (aus einem LineStyle mit `kind==="zigzag"`),
       * beide in mm Papier. Ist es gesetzt, zeichnen die Renderer die Linie als
       * Zickzack-Pfad statt als gerade (ggf. gestrichelte) Linie — ADDITIV, ohne
       * die bestehenden Strich/Dash-Linien zu verändern (Feld fehlt ⇒ heute).
       */
      zigzag?: { amplitude: number; wavelength: number };
      /**
       * Frei gezeichnetes Wiederhol-Motiv (aus einem LineStyle mit
       * `kind==="custom"`): eine offene Polylinie in einer Einheitszelle, `points`
       * in mm Papier, `length` = Wiederhollänge in mm Papier. Ist es gesetzt,
       * kacheln die Renderer das Motiv entlang der Linie (analog `zigzag`) —
       * ADDITIV; fehlt es, bleibt die Linie gerade/gestrichelt.
       */
      motif?: { points: Vec2[]; length: number };
      /** Optionale explizite Strichfarbe (überschreibt die CSS-Klasse). */
      color?: string;
      /** ID des 2D-Zeichenelements (für Links-Klick-Auswahl von Drawing2D). */
      drawingId?: string;
      /** ID der Öffnung (für Links-Klick-Auswahl von Fenster/Tür-Symbolen). */
      openingId?: string;
      /** ID der Treppe (für Links-Klick-Auswahl von Treppen-Symbollinien). */
      stairId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    }
  | {
      kind: "arc";
      center: Vec2;
      from: Vec2;
      to: Vec2;
      r: number;
      cls: string;
      /** Strichstärke in mm Papier (non-scaling). */
      weightMm: number;
      /** Strichmuster in mm Papier; null/undefined = durchgezogen. */
      dash?: number[] | null;
      /** ID der Öffnung (für Links-Klick-Auswahl von Tür-Schwenkbögen). */
      openingId?: string;
      /** ID der Treppe (für Links-Klick-Auswahl von Wendel-Outline-Bögen). */
      stairId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    }
  | {
      kind: "text";
      /** Ankerpunkt im Modell (Meter). */
      at: Vec2;
      /**
       * Frei editierbarer Stempel-Text (Rich-Text). Wird zuerst gezeichnet;
       * `align` je Absatz steuert die Ausrichtung.
       */
      doc: RichTextDoc;
      /**
       * LIVE-Zusatzzeilen (z. B. Fläche „24.30 m²" + SIA-Tag), UNTER dem Doc
       * gezeichnet — unabhängig vom editierten Text, stets aktuell. Jede Zeile
       * trägt ihre eigene Ausrichtung (`align`).
       */
      extraLines: RoomStampLine[];
      /** Basis-Schriftgrösse in PUNKT (für Runs ohne eigene Grösse + Zusatzzeilen). */
      basePt: number;
      /** Textfarbe (hex) als Default. */
      color: string;
      /** ID des Raums (Room), zu dem dieser Stempel gehört (Auswahl). */
      roomId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    }
  | {
      // Schlichter, modellverankerter Einzeltext (aus Drawing2D `{shape:"text"}`,
      // z. B. DXF-Import). Anders als `kind:"text"` (Raum-Stempel, RichText) trägt
      // er nur einen String mit Höhe in Metern + Drehung — rein SVG-gerendert.
      kind: "drawingText";
      /** Ankerpunkt im Modell (Meter). */
      at: Vec2;
      text: string;
      /** Schrifthöhe in Modell-Metern. */
      heightM: number;
      /** Drehung in RADIANT (CCW im Modell). */
      angle: number;
      color: string;
      /** Optionale einheitliche Formatierung (Schriftfamilie/fett/kursiv/…). */
      marks?: Marks;
      /**
       * Optionale Spaltenbreite in Modell-Metern (Textspalte): ist sie gesetzt,
       * bricht der Renderer den Text wortweise auf diese Breite um. Fehlt sie,
       * bleibt es einzeiliger Text.
       */
      wrapWidth?: number;
      /**
       * Reiches Textfeld (mehrere Absätze, gemischte Formatierung) — Vorrang vor
       * `text`/`marks` beim Rendern, s. `Drawing2DGeom["text"].doc`. Bricht bei
       * gesetztem `wrapWidth` wortweise um (Run-Grenzen bleiben erhalten).
       */
      doc?: RichTextDoc;
      /** ID des 2D-Zeichenelements (für Links-Klick-Auswahl). */
      drawingId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    }
  | {
      // Text-entlang-Pfad (aus Drawing2D `{shape:"text", pathPts}` mit ≥2
      // Stützpunkten) — echtes SVG `<textPath>`, nur schlichter String (kein
      // Rich-Doc/mehrere Formate in v1). Eigener Primitive-Typ statt einer
      // Variante von `drawingText`, damit der bestehende Rich-Text-Renderpfad
      // unangetastet bleibt.
      kind: "drawingTextPath";
      pathPts: Vec2[];
      text: string;
      heightM: number;
      color: string;
      drawingId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    }
  | {
      // Eingebettetes Rasterbild (aus Drawing2D `{shape:"image"}`, Foto/Logo/
      // gerasterte PDF-Seite) — achsparalleles Rechteck, Data-URL als Quelle.
      kind: "drawingImage";
      min: Vec2;
      max: Vec2;
      src: string;
      /** Deckkraft 0..1 — beim Bild bereits Pflichtfeld (eigene Bild-Deckkraft). */
      opacity: number;
      drawingId?: string;
      greyed?: boolean;
    }
  | {
      // Glatter Kreis (aus Drawing2D `{shape:"circle"}`, z. B. DXF-CIRCLE) — als
      // echtes `<circle>` gerendert (rund bei jedem Zoom), nicht als Vieleck.
      kind: "drawingCircle";
      center: Vec2;
      /** Radius in Modell-Metern. */
      r: number;
      /** Vollton-Füllfarbe oder "none". */
      fill: string;
      stroke: string;
      weightMm: number;
      dash?: number[] | null;
      drawingId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    }
  | {
      // Glatter Bogen (aus Drawing2D `{shape:"arc"}`, z. B. DXF-ARC) — als
      // SVG-Bogenpfad gerendert; Winkel in RADIANT (CCW im Modell).
      kind: "drawingArc";
      center: Vec2;
      r: number;
      a0: number;
      a1: number;
      stroke: string;
      weightMm: number;
      dash?: number[] | null;
      drawingId?: string;
      greyed?: boolean;
      /**
       * Deckkraft 0..1 dieses Primitivs (Default 1 = deckend). Kommt von der
       * Objekt-Transparenz eines 2D-Elements (`Drawing2D.opacity`) und wird in
       * im Kern (`plan/drawings.rs`) EINMAL auf alle erzeugten Primitive gestempelt, statt an
       * jeder Push-Stelle mitgeführt zu werden.
       */
      opacity?: number;
    };

/**
 * Löst eine HatchStyle-Ressource (per id) zu einer darstellungsfertigen
 * {@link HatchRender} auf. Der Linienstil der Musterlinien wird, falls gesetzt,
 * aus dem Line Manager nachgeschlagen; sonst gilt ein dünner Default.
 *
 * VORDERGRUND (Muster-/Schraffurlinienfarbe bzw. Vollfüllung): der über
 * {@link resolveForeground} aufgelöste Vordergrund gewinnt, wenn gesetzt (Nach
 * Ebene/Nach Bauteil/eigener Wert); OHNE aufgelösten Wert bleibt es bei der
 * neutralen Tinte {@link HATCH_INK} (bisheriges Verhalten — 2026-07-04 war die
 * Vordergrund-Kette hier noch fest auf HATCH_INK gezwungen, unabhängig vom
 * Ergebnis; auf Nutzer-Wunsch wieder aufgehoben, da „Vordergrund" im Attribut-
 * Panel sonst wirkungslos bliebe — betrifft nur Elemente mit tatsächlich
 * gesetztem Vordergrund, unverändertes Verhalten für alle anderen).
 */
export function resolveHatch(
  project: Project,
  hatchId: string,
  wallAngleDeg?: number,
  foreground?: string,
  /**
   * Platzierung am OBJEKT (s. `Drawing2D.hatchAngleDeg`/`hatchScale`/
   * `hatchOrigin`): Winkel ersetzt, Massstab multipliziert, Anker verschiebt
   * das Raster. Ohne Angabe bleibt alles bei der Ressource.
   */
  placement?: { angleDeg?: number; scale?: number; origin?: Vec2 },
): HatchRender {
  const h = getHatch(project, hatchId);
  const ls = h.lineStyleId ? getLineStyle(project, h.lineStyleId) : null;
  // Wandbezogener Winkel: `HatchRender.angle` wird von allen Renderern in der
  // SVG-Konvention (im Uhrzeigersinn, Bildschirm-Y nach unten) verstanden — der
  // Modell-Renderer negiert ihn in `toModelAngleRad`. Die Wandachse `wallAngleDeg`
  // ist dagegen ein MODELL-Winkel (atan2 der Richtung, gegen den Uhrzeigersinn,
  // Y nach oben). Wegen der Y-Spiegelung entspricht die Wandrichtung am Bildschirm
  // dem Winkel −wallAngleDeg; das Muster folgt der Wand also, indem der
  // Wandwinkel SUBTRAHIERT wird. Ohne Wandkontext (Decke) bleibt `angle` absolut.
  // Objekt-Winkel ERSETZT den der Ressource (danach greift die Wandbindung
  // weiterhin, damit „relativ zur Wand" auch mit eigenem Winkel funktioniert).
  const baseAngle = placement?.angleDeg ?? h.angle;
  const angle =
    h.relativeToWall && wallAngleDeg != null ? baseAngle - wallAngleDeg : baseAngle;
  return {
    pattern: h.pattern,
    // Objekt-Massstab MULTIPLIZIERT (die Ressource bleibt die Grundteilung).
    scale: h.scale * (placement?.scale ?? 1),
    angle,
    origin: placement?.origin,
    // Aufgelöster Vordergrund gewinnt (s. JSDoc oben), sonst neutrale Tinte.
    color: foreground ?? HATCH_INK,
    lineWeight: ls?.weight ?? 0.13,
    dash: ls?.dash ?? null,
    kind: h.kind,
    lines: h.lines,
    image: h.image,
    gradient: h.gradient,
    // Random-Streu-Parameter unverändert durchreichen (Erzeugung in glPlanHatch).
    seed: h.seed,
    density: h.density,
    lengthMin: h.lengthMin,
    lengthMax: h.lengthMax,
    motif: h.motif,
  };
}

/**
 * Kollabiert die Vordergrund-Farbkette (Muster-/Schraffurlinienfarbe) eines
 * Bauteils zu einem einzelnen Wert für {@link resolveHatch}. AUFLÖSUNGSREIHENFOLGE
 * (By-Layer/By-Object, siehe `docs`/Attribut-Panel):
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.color`) ??
 *   (`Component.foreground`) ?? `undefined`.
 * `source` fehlt/`"object"` ⇒ „Nach Bauteil" — bei WAND/DECKE bewusst der
 * DEFAULT (die Bauteil-Kette liefert die neutrale SIA-Poché, s.
 * {@link resolveBackground}). Ein Drawing2D hat KEIN eigenes Bauteil und
 * bietet „Nach Bauteil" im Attribut-Panel gar nicht erst an — dort wird ein
 * fehlendes Source-Feld vom AUFRUFER (`selectionInfo.ts`) explizit auf
 * `"layer"` gemappt, bevor er hier ankommt (dieser Resolver selbst bleibt
 * Bauteil-Default, unabhängig von der Elementart).
 */
export function resolveForeground(
  comp: Component,
  override?: string,
  category?: LayerCategory,
  source?: AttributeSource,
): string | undefined {
  if (override != null) return override;
  if (source === "layer") return category?.color ?? comp.foreground;
  return comp.foreground;
}

/**
 * Kollabiert die Hintergrund-/Füllfarbkette (Poché-Override) eines Bauteils zu
 * einem einzelnen Wert, exakt analog zu {@link resolveForeground}:
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.color`) ??
 *   (`Component.background`) ?? `undefined`.
 * `undefined` als Endergebnis heißt „kein Override gesetzt" — Aufrufer fallen
 * dann auf ihren eigenen Default zurück (bei Wand/Decke die neutrale SIA-
 * Poché-Farbe HATCH_INK/HATCH_PAPER, NICHT `Component.color` — die reale
 * Bauteilfarbe soll die Schnitt-Konvention nicht überschreiben, nur ein
 * bewusster Override). Genau DIESE neutrale Poché ist bei Wand/Decke der
 * gewünschte Default („weisser Grund, schwarzer Vordergrund") — deshalb
 * bleibt „Nach Bauteil" dort der Default, nicht „Nach Ebene".
 */
export function resolveBackground(
  comp: Component,
  override?: string,
  category?: LayerCategory,
  source?: AttributeSource,
): string | undefined {
  if (override != null) return override;
  if (source === "layer") return category?.color ?? comp.background;
  return comp.background;
}

/**
 * Kollabiert die Schraffur-Referenz (Hatch Manager) eines Elements zu einer
 * einzelnen `hatchId` für {@link resolveHatch} — By-Layer/By-Object, analog zu
 * {@link resolveForeground}:
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.hatch`) ??
 *   `fallback` (Bauteil-Schraffur, z. B. `Component.hatchId`/`viewHatchId`, oder
 *   `undefined` bei Drawing2D ohne Bauteil-Bezug).
 * `source` fehlt/`"object"` ⇒ „Nach Bauteil" (DEFAULT bei Wand/Decke, s.
 * {@link resolveForeground}).
 * Ergebnis kann `undefined` sein — der Aufrufer fällt dann auf `NO_HATCH` zurück.
 */
export function resolveHatchId(
  override: string | undefined,
  source: AttributeSource | undefined,
  category: LayerCategory | undefined,
  fallback?: string,
): string | undefined {
  if (override != null) return override;
  if (source === "layer") return category?.hatch ?? fallback;
  return fallback;
}

/**
 * Kollabiert die Strichstärke-Kette (mm Papier) eines Elements, By-Layer/By-
 * Object, analog zu {@link resolveHatchId}:
 *   (Attribut-Override `override`) ?? (`source==="layer"` ⇒ `category.lw`) ??
 *   `fallback` (bisherige Bauteil-/LineStyle-/Kategorie-Default-Kette des
 *   Aufrufers — heutiges Verhalten).
 * `source` fehlt/`"object"` ⇒ „Nach Bauteil" (DEFAULT bei Wand/Decke, s.
 * {@link resolveForeground}).
 */
export function resolveStrokeWeight(
  override: number | undefined,
  source: AttributeSource | undefined,
  category: LayerCategory | undefined,
  fallback: number,
): number {
  if (override != null) return override;
  if (source === "layer") return category?.lw ?? fallback;
  return fallback;
}

// ── SIA-Poché-Füllung + monochrome Schraffur-Tinte ──────────────────────────
// Die 2D-Poché einer (auch mehrschichtigen) Wand trägt NICHT die rohe Bauteil-
// Albedo (3D-Materialfarbe), sondern einen neutralen Hintergrund, auf dem die
// Schraffur-Musterlinien liegen: Vollmuster ("solid") = dunkle Tinten-Poché
// (kein Linienmuster), jedes andere Muster (inkl. "none") = HELLER Hintergrund.
// Dieselben zwei Werte sind AKTUELL auch die feste Schraffur-Vordergrundfarbe
// (siehe {@link resolveHatch}) — Schnitt- wie Oberflächen-Schraffur zeigen also
// einheitlich Tinte auf hellem Papier, unabhängig von Material-/Bauteilfarbe.
export const HATCH_PAPER = "#f0f0f0";
export const HATCH_INK = "#0f0f0f";
/** Schraffur-Platzhalter „ohne" (für reine Umriss-/Sammelflächen). */
export const NO_HATCH: HatchRender = {
  pattern: "none",
  scale: 1,
  angle: 0,
  color: POCHE_STROKE,
  lineWeight: LAYER_LINE_MM,
  dash: null,
};
