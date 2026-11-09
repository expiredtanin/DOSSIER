// Gemeinsame Eingabefelder der Objekt-Info ([165] aus `ObjectInfoPanel.tsx`): Mass-Feld mit Anzeige-Einheit,
// Drehfeld, Zeile für den vertikalen Anker und die Bauteil-Schalter (aussen, tragend). Gerufen von den
// Abschnitten in diesem Ordner und von `ObjectInfoPanel.tsx`.

import { usePanelHost } from "../host";
import { t } from "../../i18n";
import type { VerticalAnchor } from "../../model/types";
import { Dropdown } from "../../ui/Dropdown";
import { useState, useRef } from "react";

// ── Decken-Attribut-Abschnitt ────────────────────────────────────────────────
// Aufbau-Typ (einschichtig/mehrschichtig), Dicke/Preset, Referenzgeschoss +
// OK-Bindung, Fläche. Alle Werte/Setter über den Host.
/** Aussenbauteil / tragend ([97]/[98]): wirken auf Bauteil-/Öffnungslisten und das IFC-Pset. */
export function BuildingFlags({ isExternal, loadBearing, host }: { isExternal: boolean; loadBearing: boolean; host: ReturnType<typeof usePanelHost> }) {
  return (
    <>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.isExternal")}</span>
        <input type="checkbox" data-testid="objinfo-isExternal" checked={isExternal} onChange={(e) => host.onSetBuildingFlags({ isExternal: e.target.checked })} />
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.loadBearing")}</span>
        <input type="checkbox" data-testid="objinfo-loadBearing" checked={loadBearing} onChange={(e) => host.onSetBuildingFlags({ loadBearing: e.target.checked })} />
      </div>
    </>
  );
}


// ── UK/OK-Zeile: Modus-Umschalter (Geschoss/eigene Höhe) + Feld ──────────────
// „Geschoss gebunden" → Geschoss-Dropdown; „eigene Höhe" → absolutes Z-Feld.
// `null`-Anchor (undefined im Modell) = Geschoss-Default; zeigt „eigene Höhe"
// mit dem aufgelösten Default-Z als Ausgangswert NICHT — Default ist
// „an Geschoss gebunden" (Geschoss-Default-Verhalten).
export function VerticalAnchorRow({
  label,
  anchor,
  defaultZ,
  floors,
  defaultFloorId,
  onChange,
}: {
  label: string;
  anchor?: VerticalAnchor;
  defaultZ: number;
  floors: { id: string; name: string }[];
  defaultFloorId: string;
  onChange: (a: VerticalAnchor | null) => void;
}) {
  const mode: "floor" | "custom" = anchor?.mode === "custom" ? "custom" : "floor";

  function setMode(next: "floor" | "custom") {
    if (next === mode) return;
    if (next === "custom") {
      onChange({ mode: "custom", z: defaultZ });
    } else {
      // Zurück auf Geschoss-Bindung: bei vorhandenem expliziten Geschoss dieses,
      // sonst Default-Geschoss → entspricht dem Geschoss-Default-Verhalten.
      onChange({ mode: "floor", floorId: defaultFloorId });
    }
  }

  return (
    <div className="objinfo-wall-anchor">
      <div className="objinfo-field">
        <span className="objinfo-flabel">{label}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (mode === "floor" ? " active" : "")}
            onClick={() => setMode("floor")}
          >
            {t("objinfo.wall.anchorFloor")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (mode === "custom" ? " active" : "")}
            onClick={() => setMode("custom")}
          >
            {t("objinfo.wall.anchorCustom")}
          </button>
        </div>
      </div>
      {/* Unterzeile in normaler Label-/Wert-Struktur: Label links, Control in
          der Wert-Spalte (Nutzer-Wunsch — vorher hing das Control ohne Label
          im Einzug der linken Spalte). */}
      {mode === "floor" ? (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.anchor.refFloor")}</span>
          <Dropdown
            value={anchor?.mode === "floor" ? anchor.floorId : defaultFloorId}
            onChange={(id) => onChange({ mode: "floor", floorId: id })}
            options={floors.map((f) => ({ value: f.id, label: f.name }))}
            title={t("objinfo.anchor.refFloor")}
            width={150}
          />
        </div>
      ) : (
        <DimensionField
          label={t("objinfo.anchor.customHeight")}
          value={anchor?.mode === "custom" ? anchor.z : defaultZ}
          min={-Infinity}
          onCommit={(z) => onChange({ mode: "custom", z })}
        />
      )}
    </div>
  );
}


export function DimensionField({
  label,
  value,
  onCommit,
  min = 0,
  unit = "m",
  step = 0.01,
  digits = 3,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  unit?: string;
  step?: number;
  /** Nachkommastellen der Anzeige (Papier-mm: 1). */
  digits?: number;
}) {
  // Entwurf als String, damit Zwischenzustände (leer, „1.") tippbar sind.
  // `null` = kein aktiver Entwurf → zeige den Host-Wert.
  const [draft, setDraft] = useState<string | null>(null);
  // Enter committet und nimmt danach den Fokus — das `blur` im selben Handler sieht noch den alten
  // Entwurf (State noch nicht neu gerendert) und committete ein zweites Mal (X/Y: doppelte Verschiebung).
  const pending = useRef<string | null>(null);
  pending.current = draft;

  const shown = draft ?? (Object.is(Number(value.toFixed(digits)), -0) ? 0 : value).toFixed(digits);

  function commit() {
    const d = pending.current;
    if (d === null) return;
    pending.current = null;
    const v = Number(d);
    setDraft(null);
    if (isFinite(v) && v >= min) onCommit(v);
  }

  return (
    <label className="objinfo-field">
      <span className="objinfo-flabel">{label}</span>
      <input
        className="objinfo-input"
        type="number"
        step={step}
        min={isFinite(min) ? min : undefined}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="objinfo-unit">{unit}</span>
    </label>
  );
}


// ── Dreh-Feld (Delta-Winkel in Grad) ─────────────────────────────────────────
// Anders als DimensionField zeigt dieses Feld KEINEN persistenten Host-Wert —
// eine „aktuelle Rotation" gibt es für die Selektion generell nicht (Wand ist
// nur eine Achse, Drawing2D/Extrusion tragen keinen Rotationswinkel). Das Feld
// ist daher ein Delta: Eingabe = Drehung ab jetzt, danach zeigt es wieder „0".
export function RotateField({ onCommit }: { onCommit: (deg: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? "0";

  function commit() {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (isFinite(v) && v !== 0) onCommit(v);
  }

  return (
    <label className="objinfo-field">
      <span className="objinfo-flabel">{t("objinfo.rotate")}</span>
      <input
        className="objinfo-input"
        type="number"
        step={1}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span className="objinfo-unit">°</span>
    </label>
  );
}
