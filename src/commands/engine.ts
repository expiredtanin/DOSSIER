// Command-Runner / State-Machine (docs/design/rhino-command-system.md §3.2, §2.3,
// §2.6). Hält den aktiven Befehl + Schritt-Zustand, einen Prompt-Stack-Grundbau
// (für künftige transparente Befehle §2.6) und `lastCommand` (Leer-Enter bzw.
// Rechtsklick wiederholt den letzten Befehl §2.3).
//
// Eingaben kommen aus DREI Quellen, die alle in DENSELBEN Schritt fließen:
//   • getippte Command-Line-Eingabe (submitText)
//   • Maus-Pick aus PlanView (pick) / Hover (move)
//   • Klick auf eine Inline-Option (chooseOption)
//
// Die Engine ist UI-agnostisch: Kontext (Projekt/Level/Kategorie), Snapping und
// das Anwenden von draft/commit liefert ein injizierter `EngineHost`. Bei jeder
// Zustandsänderung ruft sie `emit()` → React-Komponenten (CommandLine, App)
// abonnieren via subscribe() und re-rendern.

import type { Project, Vec2 } from "../model/types";
import type { SnapResult, ToolDraft } from "../tools/types";
import { parseInput, resolvePoint } from "./parseInput";
import { getCommand, resolveCommand, autocomplete } from "./registry";
import type {
  Command,
  CommandContext,
  CommandResult,
  CommandState,
  CmdInput,
} from "./types";

/**
 * Brücke zur App: liefert den Live-Kontext + Snapping und wendet die Ergebnisse
 * an (Vorschau zeigen, committen). So bleibt die Engine frei von React/Store.
 */
/** Modifikatoren (Shift=Ortho, Ctrl=Snap aus) beim Snap eines Befehlsschritts. */
export interface EngineMods {
  shift: boolean;
  ctrl: boolean;
}

export interface EngineHost {
  /** Aktueller Befehls-Kontext (Projekt, aktive Ebene/Kategorie, lastPoint). */
  context(lastPoint: Vec2 | null): CommandContext;
  /**
   * Snap für einen rohen Cursor-Punkt (oder null), inkl. der Draft-Punkte. `mods`
   * trägt Shift (Ortho) / Ctrl (Snap aus) durch — auch der ERSTE Punkt (ohne
   * Draft) wird so gesnappt bzw. per Ctrl unterdrückt.
   */
  snap(raw: Vec2, draftPoints: Vec2[], mods?: EngineMods): SnapResult | null;
  /** Aktuelle Pixel/Meter-Skala (für Snap-Toleranz). */
  pxPerMeter(): number;
  /** Vorschau setzen (oder löschen). */
  setDraft(draft: ToolDraft | null): void;
  /** Commit immutabel anwenden. */
  commit(mutate: (p: Project) => Project): void;
  /** Ist die aktive Ebene ein Geschoss? (für floorOnly-Befehle). */
  isFloor(): boolean;
  /**
   * Optional: ein frisch erzeugtes Drawing2D-Element fokussieren (Passthrough
   * von `CommandResult.focusDrawingId`/`focusMinHeightM`, z. B. um sofort den
   * Inline-Text-Editor zu öffnen). Fehlt der Host-Handler, ist das ein No-op.
   */
  focusDrawing?(drawingId: string, minHeightM?: number): void;
}

/** Öffentlicher Schnappschuss für die Command-Line-UI (rein lesend). */
export interface EngineView {
  /** Läuft gerade ein Befehl? */
  active: boolean;
  /** Aktueller Prompt-Key (i18n) oder null (Ruhezustand). */
  promptKey: string | null;
  /** Inline-Optionen des aktuellen Schritts. */
  options: { id: string; labelKey: string; value?: string }[];
  /** Name des aktiven Befehls (für Anzeige), null im Ruhezustand. */
  commandName: string | null;
  /**
   * Geordnete Zahlenfelder des aktuellen Schritts (Tab-Feld-Zyklus §2.7). Leer,
   * wenn der aktive Befehl/Schritt keine Felder anbietet. `value` ist der
   * gelockte Wert ODER — wenn ungelockt — der LIVE-Wert unter der Maus (oder null,
   * wenn (noch) keiner bestimmbar ist). `locked` unterscheidet beide für die UI;
   * `active` markiert das aktuelle Tab-Ziel.
   */
  fields: {
    id: string;
    labelKey: string;
    value: number | null;
    locked: boolean;
    active: boolean;
  }[];
}

export class CommandEngine {
  private host: EngineHost;
  private command: Command | null = null;
  private state: CommandState | null = null;
  private lastCommandName: string | null = null;
  /** Letzter (gesnappter) Cursor-Punkt für Distanz-/Winkel-Lock-Auflösung. */
  private lastCursor: Vec2 | null = null;
  /** Tab-Feld-Zyklus: aktiver Feld-Index des aktuellen Schritts (§2.7). */
  private activeFieldIndex = 0;
  /** Tab-Feld-Zyklus: gelockte Feldwerte (id → Zahl); ungelockt folgt der Maus. */
  private locks: Record<string, number> = {};
  /** Identität des Schritts, für den der Feld-Zustand gilt (Reset bei Wechsel). */
  private fieldPhaseKey: string | null = null;
  private listeners = new Set<() => void>();

  constructor(host: EngineHost) {
    this.host = host;
  }

  // ── Abo / Snapshot ─────────────────────────────────────────────────────────

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Läuft gerade ein Befehl? */
  isActive(): boolean {
    return this.command !== null;
  }

  /** Lesender Schnappschuss für die Command-Line. */
  view(): EngineView {
    if (!this.command || !this.state) {
      return { active: false, promptKey: null, options: [], commandName: null, fields: [] };
    }
    this.syncFields();
    const defs = this.currentFields();
    // Live-Werte (Maus-Vorschau) für ungelockte Felder, falls der Befehl sie
    // liefert — so zeigt die Befehlszeile beim Zeichnen die folgende Länge/Winkel.
    const live = this.command.fieldValues
      ? this.command.fieldValues(this.state, this.locks, this.lastCursor)
      : {};
    const fields = defs.map((f, i) => {
      const locked = f.id in this.locks;
      const value = locked
        ? this.locks[f.id]
        : f.id in live
          ? live[f.id]
          : null;
      return {
        id: f.id,
        labelKey: f.labelKey as string,
        value,
        locked,
        active: i === this.activeFieldIndex,
      };
    });
    return {
      active: true,
      promptKey: this.command.prompt(this.state),
      options: this.command.options(this.state),
      commandName: this.command.name,
      fields,
    };
  }

  /** Autocomplete-Kandidaten für die getippte Eingabe (Präfix). */
  suggest(prefix: string): string[] {
    return autocomplete(prefix);
  }

  // ── Tab-Feld-Zyklus (§2.7) ────────────────────────────────────────────────

  /** Feld-Definitionen des aktuellen Schritts (leer, wenn keine angeboten). */
  private currentFields(): { id: string; labelKey: string }[] {
    if (!this.command || !this.state || !this.command.fields) return [];
    return this.command.fields(this.state);
  }

  /** Hat der aktuelle Schritt einen Tab-Feld-Modus? */
  hasFields(): boolean {
    return this.currentFields().length > 0;
  }

  /**
   * Erwartet der aktuelle Schritt freien Text (z. B. das Textwerkzeug-Label)?
   * Dort ist JEDE Taste — auch Ziffern — literaler Inhalt, im Unterschied zu
   * einem reinen Punkt-Pick-Schritt (nur „point"/„number", keine Felder), wo
   * Ziffern ansonsten ungenutzt sind.
   */
  acceptsFreeText(): boolean {
    if (!this.command || !this.state) return false;
    return this.command.accepts(this.state).includes("text");
  }

  /**
   * Setzt den Feld-Zustand zurück, wenn der Schritt wechselt — Signatur =
   * phase + Feld-IDs + lastPoint. Der lastPoint-Teil sorgt dafür, dass ein
   * mehrteiliger Befehl (Polyline) je gesetztem Punkt FRISCHE Felder/Locks
   * bekommt, obwohl die phase ("next") gleich bleibt.
   */
  private syncFields(): void {
    const defs = this.currentFields();
    const lp = this.state?.lastPoint;
    const lpKey = lp ? `${lp.x.toFixed(6)},${lp.y.toFixed(6)}` : "∅";
    const key = this.state
      ? `${this.state.phase}:${defs.map((f) => f.id).join(",")}:${lpKey}`
      : null;
    if (key !== this.fieldPhaseKey) {
      this.fieldPhaseKey = key;
      this.activeFieldIndex = 0;
      this.locks = {};
    }
  }

  /** Tab: nächstes Feld aktiv (zyklisch). No-op ohne Felder. */
  cycleField(): void {
    this.syncFields();
    const n = this.currentFields().length;
    if (n === 0) return;
    this.activeFieldIndex = (this.activeFieldIndex + 1) % n;
    this.emit();
  }

  /**
   * Lockt einen getippten Zahlenwert ins aktive Feld und rückt aufs nächste vor
   * (§2.7, Task-Schritt 2). Sind danach ALLE Felder gelockt, committet der Schritt
   * sofort den daraus gebildeten Punkt — so commitet ein Ein-Feld-Befehl (Kreis:
   * Radius) direkt und ein Zwei-Feld-Befehl (Linie) nach dem zweiten Wert.
   */
  private lockActiveField(value: number): void {
    this.syncFields();
    const defs = this.currentFields();
    if (defs.length === 0) return;
    const field = defs[this.activeFieldIndex];
    this.locks = { ...this.locks, [field.id]: value };
    const allLocked = defs.every((f) => f.id in this.locks);
    if (allLocked) {
      this.commitFields();
      return;
    }
    this.activeFieldIndex = (this.activeFieldIndex + 1) % defs.length;
    this.refreshFieldPreview();
    this.emit();
  }

  /** Committet den aus den Feld-Locks (+ Cursor) gebildeten Punkt als Schritt-Eingabe. */
  private commitFields(): void {
    const pt = this.fieldResultPoint(this.lastCursor);
    if (pt) this.feed({ kind: "point", point: pt });
    else this.emit();
  }

  /** Vorschau aus den gelockten Feldern + dem letzten Cursor neu zeichnen. */
  private refreshFieldPreview(): void {
    if (!this.command || !this.state || !this.command.pointFromFields) return;
    const pt = this.command.pointFromFields(this.state, this.locks, this.lastCursor);
    if (!pt) return;
    const ctx = this.context();
    const [st, res] = this.command.onMove(this.state, pt, null, ctx);
    this.state = st;
    if (res.draft) this.host.setDraft(res.draft);
  }

  // ── Befehls-Lebenszyklus ─────────────────────────────────────────────────

  /** Startet einen Befehl per Name/Alias/Präfix. Liefert true bei Erfolg. */
  start(nameOrPrefix: string): boolean {
    const cmd = resolveCommand(nameOrPrefix) ?? getCommand(nameOrPrefix);
    if (!cmd) return false;
    return this.startCommand(cmd);
  }

  /** Startet einen konkreten Befehl (z. B. zur Wiederholung). */
  startCommand(cmd: Command): boolean {
    if (cmd.floorOnly && !this.host.isFloor()) return false;
    this.command = cmd;
    this.state = cmd.init();
    this.lastCommandName = cmd.name;
    this.lastCursor = null;
    this.resetFields();
    this.host.setDraft(null);
    // Sofort-Befehl (Join/Split u. Ä.): direkt ausführen, ohne auf einen Pick zu
    // warten. So sind Tastenkürzel und getippter Befehl EIN Pfad (§Task C).
    if (cmd.autoRun) {
      const res = cmd.autoRun(this.context());
      this.applyResult(res);
      return true;
    }
    this.emit();
    return true;
  }

  /** Tab-Feld-Zustand vollständig zurücksetzen (Befehlsstart/-ende/Abbruch). */
  private resetFields(): void {
    this.activeFieldIndex = 0;
    this.locks = {};
    this.fieldPhaseKey = null;
  }

  /** Bricht den laufenden Befehl ab (Esc). */
  cancel(): void {
    if (this.command && this.state) {
      const [, res] = this.command.onCancel(this.state);
      this.applyResult(res);
    }
    this.command = null;
    this.state = null;
    this.resetFields();
    this.host.setDraft(null);
    this.emit();
  }

  // ── Eingabe-Routing ────────────────────────────────────────────────────────

  /**
   * Getippte Command-Line-Eingabe (Enter). Im Ruhezustand: Befehl starten / bei
   * leerer Zeile letzten wiederholen (§2.3). In einem Befehl: als Koordinate/
   * Zahl/Option in den aktuellen Schritt routen.
   */
  submitText(raw: string): void {
    const text = raw.trim();
    if (!this.command || !this.state) {
      // Ruhezustand: leere Zeile = letzten Befehl wiederholen.
      if (text === "") {
        this.repeatLast();
        return;
      }
      this.start(text);
      return;
    }
    // Laufender Befehl: leere Zeile = bestätigen/beenden (Enter §2.3).
    if (text === "") {
      this.confirm();
      return;
    }
    this.routeTypedInput(text);
  }

  /** Routet getippten Text in den aktuellen Schritt (Koordinate/Zahl/Option). */
  private routeTypedInput(text: string): void {
    if (!this.command || !this.state) return;
    const accepts = this.command.accepts(this.state);

    // Optionsbuchstabe(n)? (nur wenn der Schritt Optionen annimmt) — Präfix-Match.
    if (accepts.includes("option")) {
      const opts = this.command.options(this.state);
      const q = text.toLowerCase();
      const hit = opts.find((o) => o.id.toLowerCase().startsWith(q));
      if (hit) {
        this.feed({ kind: "option", id: hit.id });
        return;
      }
    }

    // Freitext-Schritt (z. B. Text-Platzierung): der Schritt nimmt beliebigen
    // Text als Label — die komplette getippte Zeile geht 1:1 durch (auch Zahlen/
    // Kommas), bevor die numerische/Koordinaten-Auflösung greift.
    if (accepts.includes("text")) {
      this.feed({ kind: "text", text });
      return;
    }

    const parsed = parseInput(text);

    // Tab-Feld-Modus (§2.7): eine nackte Zahl LOCKT das aktive Feld (statt als
    // distance/number durchzureichen) und rückt aufs nächste Feld vor. Absolute/
    // relative/polare Koordinaten umgehen die Felder (committen wie gewohnt).
    if (parsed.kind === "distance" && this.hasFields()) {
      this.lockActiveField(parsed.value);
      return;
    }

    const lastPoint = this.state.lastPoint;
    const cursor = this.lastCursor;

    if (parsed.kind === "text") {
      // Unparsbar im Schritt: ignorieren (kein gültiger Punkt/Option).
      return;
    }
    // Punktbezogene Eingaben → zu Modellpunkt auflösen, wenn der Schritt Punkte
    // annimmt; sonst nackte Zahl als number-Input.
    if (parsed.kind === "distance" && accepts.includes("number") && !accepts.includes("point")) {
      this.feed({ kind: "number", value: parsed.value });
      return;
    }
    const pt = resolvePoint(parsed, lastPoint, cursor);
    if (pt && accepts.includes("point")) {
      this.feed({ kind: "point", point: pt });
      return;
    }
    if (parsed.kind === "distance" && accepts.includes("number")) {
      this.feed({ kind: "number", value: parsed.value });
    }
  }

  /** Maus-Pick aus PlanView (linker Klick) — gesnappter Modellpunkt. */
  pick(raw: Vec2, mods?: EngineMods): void {
    if (!this.command || !this.state) return;
    if (!this.command.accepts(this.state).includes("point")) return;
    const snap = this.host.snap(raw, this.draftPoints(), mods);
    const point = snap?.point ?? raw;
    this.lastCursor = point;
    // Tab-Feld-Modus: gelockte Felder überschreiben den Klick (z. B. Länge fix,
    // Richtung per Maus). Der finale Punkt kommt aus pointFromFields.
    const fieldPt = this.fieldResultPoint(point);
    if (fieldPt) {
      this.feed({ kind: "point", point: fieldPt });
      return;
    }
    this.feed({ kind: "point", point, snap });
  }

  /** Hover/Drag aus PlanView — nur Vorschau (kein Commit). */
  move(raw: Vec2, mods?: EngineMods): void {
    if (!this.command || !this.state) return;
    const snap = this.host.snap(raw, this.draftPoints(), mods);
    const point = snap?.point ?? raw;
    this.lastCursor = point;
    const ctx = this.context();
    // Tab-Feld-Modus: ungelockte Felder folgen der Maus, gelockte überschreiben.
    const previewPoint = this.fieldResultPoint(point) ?? point;
    const [st, res] = this.command.onMove(this.state, previewPoint, snap, ctx);
    this.state = st;
    // Snap-Marker mit in den Draft hängen.
    if (res.draft) this.host.setDraft({ ...res.draft, snap });
    else if (snap) this.host.setDraft({ preview: [], vertices: [], snap });
    else this.host.setDraft(null);
  }

  /**
   * Punkt aus dem Tab-Feld-Modus für einen gegebenen Cursor — oder null, wenn der
   * Schritt keine Felder hat (dann gilt der rohe Cursor/Pick).
   */
  private fieldResultPoint(cursor: Vec2 | null): Vec2 | null {
    if (!this.command || !this.state || !this.command.pointFromFields) return null;
    if (!this.hasFields()) return null;
    return this.command.pointFromFields(this.state, this.locks, cursor);
  }

  /** Klick auf eine Inline-Option (§2.4). */
  chooseOption(id: string): void {
    if (!this.command || !this.state) return;
    this.feed({ kind: "option", id });
  }

  /** Enter = Space = Rechtsklick: bestätigen/Default/mehrteilig-beenden (§2.3). */
  confirm(): void {
    if (!this.command || !this.state) {
      this.repeatLast();
      return;
    }
    // Tab-Feld-Modus (§2.7): ist ein Feld GELOCKT (getippte Länge/Winkel/Dicke),
    // committet Enter den Schritt mit dem aus (Locks + Cursor) gebildeten Punkt —
    // statt den Befehl zu beenden. OHNE Lock ist Enter/Rechtsklick das normale
    // Bestätigen: mehrteilige Befehle (Wand/Polylinie) beenden ihren Zug über
    // onConfirm (sonst feuerte die Feld-Auflösung einen Cursor-Punkt und der Zug
    // liesse sich nie abschliessen).
    if (Object.keys(this.locks).length > 0) {
      const fieldPt = this.fieldResultPoint(this.lastCursor);
      if (fieldPt) {
        this.feed({ kind: "point", point: fieldPt });
        return;
      }
    }
    const ctx = this.context();
    const [st, res] = this.command.onConfirm(this.state, ctx);
    this.state = st;
    this.applyResult(res);
  }

  /** Leer-Enter/Rechtsklick im Ruhezustand: letzten Befehl wiederholen. */
  repeatLast(): void {
    if (this.lastCommandName) {
      const cmd = getCommand(this.lastCommandName);
      if (cmd) this.startCommand(cmd);
    }
  }

  // ── interne Mechanik ───────────────────────────────────────────────────────

  private feed(input: CmdInput): void {
    if (!this.command || !this.state) return;
    if (input.kind === "point") this.lastCursor = input.point;
    const ctx = this.context();
    const [st, res] = this.command.onInput(this.state, input, ctx);
    this.state = st;
    this.applyResult(res);
  }

  private applyResult(res: CommandResult): void {
    if (res.commit) this.host.commit(res.commit);
    if (res.focusDrawingId) this.host.focusDrawing?.(res.focusDrawingId, res.focusMinHeightM);
    if (res.draft) this.host.setDraft(res.draft);
    else this.host.setDraft(null);
    if (res.done) {
      this.command = null;
      this.state = null;
      this.resetFields();
    }
    this.emit();
  }

  private context(): CommandContext {
    return this.host.context(this.state?.lastPoint ?? null);
  }

  /** Bereits gesetzte Punkte des laufenden Befehls (für Snap-Quellen). */
  private draftPoints(): Vec2[] {
    const s = this.state as (CommandState & { a?: Vec2; points?: Vec2[] }) | null;
    if (!s) return [];
    if (s.points) return s.points;
    if (s.a) return [s.a];
    if (s.lastPoint) return [s.lastPoint];
    return [];
  }
}
