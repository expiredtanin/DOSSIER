// Objekt-Info eines Bibliotheks-Objekts ([253], `Drawing2DGeom.shape === "libobj"`): die Felder entstehen generisch
// aus der Parameterliste des Katalogs (Länge, Anzahl, Ja/Nein, Anteil) — kein Formular je Objekt, damit eigene
// Objekte [254] ohne Änderung hier dazukommen. Änderungen laufen als Ops über `updateDrawing2D` (ein Undo-Schritt je
// Eingabe). Unbekannte Objekt-Id: nur ein Hinweis (die Plandarstellung zeigt einen Platzhalter-Rahmen).

import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { useStore } from "../../state/appStore";
import type { Drawing2D } from "../../model/types";
import { libDefaultParams, libObjectDef, type LibObjectDef, type LibParamDef, type LibParams } from "../../model/furnitureLib";
import { DimensionField } from "./fields";

type LibGeom = Extract<Drawing2D["geom"], { shape: "libobj" }>;

/** Beschriftung eines Parameters; je Gruppe/Form spezifischer (Stühle, Module, Durchmesser). */
function paramLabel(def: LibObjectDef, p: LibParamDef): TranslationKey {
  if (p.key === "n" && def.group === "kitchen") return "lib.p.n.kitchen";
  if (p.key === "n" && def.group === "tables") return "lib.p.n.tables";
  if (p.key === "w" && !def.params.some((q) => q.key === "d")) return "lib.p.diameter";
  return `lib.p.${p.key}` as TranslationKey;
}

export function LibObjectSection({ drawing, geom }: { drawing: Drawing2D; geom: LibGeom }) {
  const update = useStore((s) => s.updateDrawing2D);
  const def = libObjectDef(geom.libId);
  if (!def) {
    return (
      <div className="objinfo-field">
        <span className="objinfo-fval objinfo-muted">
          {t("lib.unknown")}: {geom.libId}
        </span>
      </div>
    );
  }
  const values: LibParams = { ...libDefaultParams(def), ...(geom.params ?? {}) };
  const set = (key: string, v: number | boolean) => update(drawing.id, { geom: { ...geom, params: { ...(geom.params ?? {}), [key]: v } } });
  const name = t(`lib.o.${def.id.replace(/^lib:/, "")}` as TranslationKey);

  return (
    <div data-testid="libobj-section">
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("lib.section")}</span>
        <span className="objinfo-fval">{name}</span>
      </div>
      {def.params.map((p) => {
        const label = t(paramLabel(def, p));
        const v = values[p.key];
        if (p.kind === "length") {
          return <DimensionField key={p.key} label={label} value={Number(v)} min={p.min} step={p.step} digits={3} onCommit={(x) => set(p.key, Math.min(p.max, Math.max(p.min, x)))} />;
        }
        if (p.kind === "flag") {
          return (
            <label className="objinfo-field" key={p.key}>
              <span className="objinfo-flabel">{label}</span>
              <input type="checkbox" checked={v === true || Number(v) >= 0.5} onChange={(e) => set(p.key, e.target.checked)} />
            </label>
          );
        }
        if (p.kind === "fraction") {
          return (
            <label className="objinfo-field" key={p.key}>
              <span className="objinfo-flabel">{label}</span>
              <input type="range" min={p.min} max={p.max} step={p.step} value={Number(v)} onChange={(e) => set(p.key, Number(e.target.value))} />
              <span className="objinfo-unit">{Math.round(Number(v) * 100)} %</span>
            </label>
          );
        }
        return (
          <label className="objinfo-field" key={p.key}>
            <span className="objinfo-flabel">{label}</span>
            <input
              className="objinfo-input"
              type="number"
              min={p.min}
              max={p.max}
              step={p.step}
              value={Number(v)}
              onChange={(e) => {
                const x = Math.round(Number(e.target.value));
                if (Number.isFinite(x)) set(p.key, Math.min(p.max, Math.max(p.min, x)));
              }}
            />
          </label>
        );
      })}
      {def.seeded && (
        <div className="objinfo-field">
          <button type="button" className="objinfo-btn" onClick={() => update(drawing.id, { geom: { ...geom, seed: (Math.random() * 0xffffffff) >>> 0 } })}>
            {t("lib.reroll")}
          </button>
        </div>
      )}
    </div>
  );
}
