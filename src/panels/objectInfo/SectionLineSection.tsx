// Abschnitt „Schnitt-/Ansichtslinie" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Name, Art, Tiefe,
// Umkehren, Höhenmarken, Plan-Unterlage. Gerufen von `AttributesPanel`.

import { useStore } from "../../state/appStore";
import type { DrawingLevel, Vec2 } from "../../model/types";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";

// ── Schnitt-/Ansichtslinien-Abschnitt (Object-Info; nur die gewählte Linie) ──
// Name (editierbar), Blickrichtung umkehren (directionSign-Flip), Endpunkt-
// Koordinaten (editierbar) + Schnitt-Tiefe; Löschen setzt linePoints zurück
// (die Ebene bleibt bestehen). Eine Schnittlinie ist KEIN Projekt-Bauteil,
// darum kommt sie über `host.sectionLine` (nicht über `selection`).
export function SectionLineSection({
  level,
  host,
}: {
  level: DrawingLevel;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  const line = level.linePoints;
  const isElev = level.kind === "elevation";
  const kindLabel =
    level.kind === "elevation"
      ? t("objinfo.sectionLine.kind.elevation")
      : t("objinfo.sectionLine.kind.section");
  const patchPoint = (which: 0 | 1, axis: "x" | "y", value: number) => {
    if (!line) return;
    const next: [Vec2, Vec2] = [{ ...line[0] }, { ...line[1] }];
    next[which] = { ...next[which], [axis]: value };
    host.onSetSectionLinePatch({ linePoints: next });
  };
  const coordField = (labelKey: TranslationKey, value: number, on: (v: number) => void) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(labelKey)}</span>
      <input
        type="number"
        className="objinfo-text"
        step={0.1}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) on(v);
        }}
        title={t(labelKey)}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">
        {t(isElev ? "objinfo.sectionLine.section.elevation" : "objinfo.sectionLine.section")} · {kindLabel}
      </div>

      {/* Name (editierbar). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.sectionLine.name")}</span>
        <input
          type="text"
          className="objinfo-text"
          value={level.name}
          onChange={(e) => host.onSetSectionLinePatch({ name: e.target.value })}
          title={t("objinfo.sectionLine.name")}
        />
      </div>

      {/* Blickrichtung umkehren (directionSign-Flip). */}
      <button
        type="button"
        className="objinfo-btn"
        onClick={() =>
          host.onSetSectionLinePatch({
            directionSign: (level.directionSign ?? 1) === 1 ? -1 : 1,
          })
        }
      >
        {t("objinfo.sectionLine.flip")}
      </button>

      {/* 3D-Live-Schnitt an diese Linie binden (nur mit gesetzter Linie sinnvoll):
          der Viewport clippt dann vertikal entlang dieser Ebene. */}
      {line && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.sectionLine.cut3d")}</span>
          <input
            type="checkbox"
            checked={host.section3dCutActive}
            onChange={() => host.onToggleSection3dCut(level.id)}
            title={t("objinfo.sectionLine.cut3d")}
          />
        </div>
      )}

      {/* Endpunkt-Koordinaten (nur wenn eine Linie gesetzt ist). */}
      {line && (
        <>
          {coordField("objinfo.sectionLine.startX", line[0].x, (v) => patchPoint(0, "x", v))}
          {coordField("objinfo.sectionLine.startY", line[0].y, (v) => patchPoint(0, "y", v))}
          {coordField("objinfo.sectionLine.endX", line[1].x, (v) => patchPoint(1, "x", v))}
          {coordField("objinfo.sectionLine.endY", line[1].y, (v) => patchPoint(1, "y", v))}
        </>
      )}

      {/* Schnitt-Tiefe (leer = unbegrenzt). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t(isElev ? "objinfo.sectionLine.depth.elevation" : "objinfo.sectionLine.depth")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.5}
          min={0}
          value={level.depth ?? ""}
          placeholder={t("objinfo.sectionLine.depthHint")}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === "") {
              host.onSetSectionLinePatch({ depth: undefined });
              return;
            }
            const v = Number(raw);
            if (Number.isFinite(v) && v > 0) host.onSetSectionLinePatch({ depth: v });
          }}
          title={t(isElev ? "objinfo.sectionLine.depth.elevation" : "objinfo.sectionLine.depth")}
        />
      </div>

      {/* [176] Schnittmarke im Grundriss: leer = Vorgabe der Modelldarstellung (sonst Pfeil). */}
      {level.kind === "section" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.sectionLine.marker")}</span>
          <Dropdown
            value={level.markerStyle ?? ""}
            onChange={(v) => host.onSetSectionLinePatch({ markerStyle: v === "arrow" || v === "lAngle" ? v : undefined })}
            options={[
              { value: "", label: t("objinfo.sectionLine.marker.model") },
              { value: "arrow", label: t("resources.modelViews.val.arrow") },
              { value: "lAngle", label: t("resources.modelViews.val.lAngle") },
            ]}
            title={t("objinfo.sectionLine.marker")}
            width={150}
          />
        </div>
      )}

      {/* Verdeckte Kanten (gestrichelt) — Default aus (blasses Liniengewirr). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.sectionLine.hiddenLines")}</span>
        <input
          type="checkbox"
          checked={level.hiddenLines ?? false}
          onChange={(e) => host.onSetSectionLinePatch({ hiddenLines: e.target.checked })}
          title={t("objinfo.sectionLine.hiddenLines")}
        />
      </div>

      {/* Automatische Höhenkoten (Geschosse + oberste Kante). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.sectionLine.levelMarks")}</span>
        <input
          type="checkbox"
          checked={level.levelMarks !== false}
          onChange={(e) => host.onSetSectionLinePatch({ levelMarks: e.target.checked ? undefined : false })}
          title={t("objinfo.sectionLine.levelMarks")}
        />
      </div>

      {/* Grundriss-Unterlage: ein Geschoss ausgerichtet unter dem Schnitt/der Ansicht. */}
      {line && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.sectionLine.planUnderlay")}</span>
          <Dropdown
            value={level.planUnderlayId ?? ""}
            onChange={(v) => host.onSetSectionLinePatch({ planUnderlayId: v || undefined })}
            options={[
              { value: "", label: t("objinfo.sectionLine.planUnderlay.none") },
              ...storeProject.drawingLevels
                .filter((l) => l.kind === "floor")
                .map((l) => ({ value: l.id, label: l.name })),
            ]}
            title={t("objinfo.sectionLine.planUnderlay")}
            width={150}
          />
        </div>
      )}

      {/* Löschen: linePoints zurücksetzen (die Ebene bleibt bestehen). */}
      <button type="button" className="objinfo-btn" onClick={() => host.onDeleteSectionLine()}>
        {t(isElev ? "objinfo.sectionLine.delete.elevation" : "objinfo.sectionLine.delete")}
      </button>
    </>
  );
}
