// Inhalts-Panel „Objekt-Info" (Vectorworks-Stil) — kompakte Sicht auf die
// aktuelle Auswahl: ein 3×3-Bezugspunkt-„Würfel", die X/Y-Koordinaten des
// gewählten Bezugspunkts (read-only) sowie editierbare Maße Breite×Höhe.
//
// Bei Auswahl GENAU EINER Wand zeigt das Panel zusätzlich einen Wand-Abschnitt
// (Referenzlinie, Aufbau-Typ/Dicke/Preset, Referenzgeschoss + UK/OK) — analog
// Vectorworks. Die Referenzlinie sitzt rechts oben im Kopf.
//
// Alle Daten/Handler kommen über usePanelHost (kein Prop-Drilling, kein
// Modellzugriff). Der gewählte Bezugspunkt (fx,fy ∈ {0,0.5,1}) ist lokaler
// State und wird als Anker an onResizeSelection durchgereicht: Beim Ändern
// der Maße bleibt genau dieser Punkt fix.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Alle sichtbaren
// Texte über t(...).
//
// [165] Die Abschnitte (Wand, Decke, Dach, Treppe …) liegen in `objectInfo/`; `AttributesPanel` ruft sie
// von dort, das Panel selbst nur Baum, Messwerte und die gemeinsamen Felder.

import { useSelectionInfo } from "../state/useSelectionInfo";
import { lengthFromDisplay, lengthToDisplay, unitsForLevel, xToDisplay, yFromDisplay, yToDisplay } from "../tools/displayUnits";
import { useMemo, useState } from "react";
import { t } from "../i18n";
import { flattenCategories } from "../model/types";
import { Dropdown } from "../ui/Dropdown";
import { usePanelHost } from "./host";
import { useStore } from "../state/appStore";
import { excavationQuantities } from "../core";
import { ContextObjectProps } from "./ContextObjectProps";
import { SunStudySection } from "./SunStudySection";
import { SiteRulesSection } from "./SiteRulesSection";
import { TreeSection } from "./objectInfo/TreeSection";
import { ViewShadowsInfo, MeasurementSection } from "./objectInfo/InfoBlocks";
import { DimensionField, RotateField } from "./objectInfo/fields";

// ── Bezugspunkt-Raster ───────────────────────────────────────────────────────
// Neun Anker als 3×3-Raster. Zeile 0 = oben (fy=0), Spalte 0 = links (fx=0).
// Reihenfolge des Arrays = Lesereihenfolge des Grids (links→rechts, oben→unten).
const FRACTIONS = [0, 0.5, 1] as const;


/** Stabiler Schlüssel je Anker (z. B. "0-0.5"), unabhängig von Float-Anzeige. */
function anchorKey(fx: number, fy: number): string {
  return `${fx}-${fy}`;
}


/** Radiant → Grad, normiert auf [0, 360) (für Winkel-Anzeigefelder). */
function toDeg360(rad: number): number {
  return (((rad * 180) / Math.PI) % 360 + 360) % 360;
}


export function ObjectInfoPanel() {
  const host = usePanelHost();
  const storeProject = useStore((st) => st.project);
  const sel = useSelectionInfo();

  // Gewählter Bezugspunkt — Default Mitte (Vectorworks-Standardanker beim
  // Skalieren). Bleibt erhalten, solange das Panel montiert ist.
  const [anchor, setAnchor] = useState<{ fx: number; fy: number }>({
    fx: 0.5,
    fy: 0.5,
  });

  // ── Mess-Werkzeug: Live-Messwerte (Länge/Fläche/Winkel) ─────────────────────
  // Werden angezeigt, sobald gemessen wird — unabhängig von einer Selektion
  // (das Mess-Werkzeug erzeugt kein Element). Hat Vorrang vor dem Leerzustand.
  const m = host.measurement;

  // [137] Lage-Darstellung angeklickt (Schattenfläche / Baurechtslinie): Einstellungen der Quelle.
  const site = useStore((s) => s.selection.site);
  const treeSel = useStore((s) => s.selection.trees);
  const ctxObj = sel?.kind === "contextObject" ? (storeProject.context ?? []).find((o) => o.id === sel.id) : undefined;
  const quantities = useMemo(
    () => (ctxObj?.type === "excavation" ? excavationQuantities(storeProject) : []),
    [ctxObj?.type, storeProject],
  );

  // ── Leerzustand ───────────────────────────────────────────────────────────
  // [149] Baum gewählt: eigene Felder (Lage, Masse, Form, Bestand).
  if (sel === null && treeSel.length > 0) return <TreeSection ids={treeSel} />;
  if (sel === null && site[0] === "viewShadows") return <ViewShadowsInfo />;
  if (sel === null && site.length > 0) {
    const sun = site[0] === "sunStudy";
    return (
      <div className="objinfo-panel">
        <div className="objinfo-head">
          <span className="objinfo-kind">{t(sun ? "objinfo.kind.sunStudy" : "objinfo.kind.siteRules")}</span>
        </div>
        <div className="objinfo-muted objinfo-site-hint">{t(sun ? "objinfo.sunStudy.hint" : "objinfo.siteRules.hint")}</div>
        <div className="site-panel objinfo-site">{sun ? <SunStudySection /> : <SiteRulesSection />}</div>
      </div>
    );
  }
  if (sel === null) {
    return (
      <div className="objinfo-panel">
        {m ? <MeasurementSection m={m} /> : <div className="objinfo-empty">{t("objinfo.empty")}</div>}
      </div>
    );
  }

  const { bbox } = sel;
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;

  // X/Y des gewählten Bezugspunkts (Modell-Meter). Editierbar: Commit
  // verschiebt die Selektion so, dass der gewählte Bezugspunkt auf die
  // eingegebene Koordinate wandert (Delta = neu − aktuell → generischer Move
  // über den Host). Bei Öffnungen (wandgebunden, kein freier 2D-Punkt) ist der
  // Host-Aufruf ein No-op — das Feld zeigt danach wieder den unveränderten
  // Wert (wie bei Breite/Höhe oben).
  const px = bbox.minX + anchor.fx * width;
  const py = bbox.minY + anchor.fy * height;
  // Auf einem Layout-Blatt zeigt und liest das Panel Papier-mm mit y nach unten ([93]).
  const u = unitsForLevel(storeProject.drawingLevels.find((z) => z.id === sel.floorId));
  const len = (m: number): number => lengthToDisplay(u, m);
  const unlen = (v: number): number => lengthFromDisplay(u, v);
  const lenProps = { unit: u.suffix, digits: u.digits };

  // Rohe Drawing2D-Geometrie der Selektion (nur bei kind==="drawing2d") — für
  // die Linien-Länge/Kreis-Radius-Felder unten; die Selection-Sicht trägt
  // keine Geometrieform, daher direkter (Lese-)Zugriff aufs Projekt.
  const rawDrawing =
    sel.kind === "drawing2d"
      ? storeProject.drawings2d.find((d) => d.id === sel.id)
      : undefined;
  const drawingShape = rawDrawing?.geom.shape;

  // ── Maß-Commit ──────────────────────────────────────────────────────────────
  // Liest beide aktuellen Maße aus den Feldern und skaliert um den aktiven
  // Anker. Negative/ungültige Werte werden ignoriert (kein Resize).
  function commitSize(nextWidth: number, nextHeight: number) {
    if (!isFinite(nextWidth) || !isFinite(nextHeight)) return;
    if (nextWidth < 0 || nextHeight < 0) return;
    host.onResizeSelection(nextWidth, nextHeight, anchor);
  }

  return (
    <div className="objinfo-panel">
      {m && <MeasurementSection m={m} />}
      {/* Kopfzeile: Typ + editierbare Klasse (Grafik-Kategorie) + Zeichnungsebene
          (VW-Muster „Klasse"/„Ebene"). Die element-spezifischen Attribut-
          Abschnitte (Wand/Decke/Öffnung/Treppe/Raum) liegen im Attribute-Panel. */}
      <div className="objinfo-head">
        <span className="objinfo-kind">{t(`objinfo.kind.${sel.kind}`)}</span>
      </div>
      {sel.categoryCode !== "" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.category")}</span>
          <Dropdown
            value={sel.categoryCode}
            onChange={(v) => host.onSetSelectionCategory(v)}
            options={flattenCategories(storeProject.layers).map((c) => ({
              value: c.code,
              label: `${c.code} ${c.name}`,
            }))}
            title={t("objinfo.category")}
            width={150}
          />
        </div>
      )}
      {sel.floorId != null && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.level")}</span>
          <Dropdown
            value={sel.floorId}
            onChange={(v) => host.onSetSelectionLevel(v)}
            options={storeProject.drawingLevels
              // Geschosse + die aktuelle Ebene (2D-Zeichnungen können auch auf
              // Schnitt-/Zeichnungs-Ebenen liegen — die darf nicht verschwinden).
              .filter((z) => z.kind === "floor" || z.id === sel.floorId)
              .map((z) => ({ value: z.id, label: z.name }))}
            title={t("objinfo.level")}
            width={150}
          />
        </div>
      )}

      <div className="objinfo-sep" />

      {(
        <>
          {/* Bezugspunkt-Würfel (3×3, immer quadratisch) links, X/Y/Z als Spalte
              rechts daneben (Nutzer-Wunsch). */}
          <div className="objinfo-section-label">{t("objinfo.refpoint")}</div>
          <div className="objinfo-refrow">
            <div className="objinfo-cube" role="group" aria-label={t("objinfo.refpoint")}>
              {FRACTIONS.map((fy) =>
                FRACTIONS.map((fx) => {
                  const active = anchor.fx === fx && anchor.fy === fy;
                  return (
                    <button
                      key={anchorKey(fx, fy)}
                      type="button"
                      className={"objinfo-anchor" + (active ? " active" : "")}
                      title={t("objinfo.setRefpoint")}
                      aria-pressed={active}
                      onClick={() => setAnchor({ fx, fy })}
                    >
                      <span className="objinfo-dot" />
                    </button>
                  );
                }),
              )}
            </div>

            {/* X / Y des gewählten Bezugspunkts (editierbar) + Z (read-only) + ein
                Dreh-Feld, als Spalte. */}
            <div className="objinfo-xyzcol">
              <DimensionField
                label={t("objinfo.x")}
                value={xToDisplay(u, px)}
                min={-Infinity}
                {...lenProps}
                onCommit={(nx) => host.onMoveSelectionBy(unlen(nx) - px, 0)}
              />
              <DimensionField
                label={t("objinfo.y")}
                value={yToDisplay(u, py)}
                min={-Infinity}
                {...lenProps}
                onCommit={(ny) => host.onMoveSelectionBy(0, yFromDisplay(u, ny) - py)}
              />
              {/* Z ehrlich: Das Modell ist 2D pro Ebene; es gibt keine Z am Element.
                  Daher „—" statt einer gefakten 0, mit kurzem Hinweis im Titel. */}
              <div className="objinfo-field">
                <span className="objinfo-flabel">{t("objinfo.z")}</span>
                <span className="objinfo-fval objinfo-muted" title={t("objinfo.zHint")}>
                  —
                </span>
              </div>
              {/* Drehen: Delta-Winkel (Grad) um den gewählten Bezugspunkt — kein
                  persistenter Zustand, das Feld zeigt nach dem Commit wieder „0". */}
              <RotateField onCommit={(deg) => host.onRotateSelectionAround(px, py, deg)} />
            </div>
          </div>

          <div className="objinfo-sep" />

          {/* Maße (editierbar) — Commit auf blur/Enter skaliert um den Anker. */}
          <div className="objinfo-section-label">{t("objinfo.dimensions")}</div>
          <DimensionField
            label={t("objinfo.width")}
            value={len(width)}
            {...lenProps}
            onCommit={(w) => commitSize(unlen(w), height)}
          />
          <DimensionField
            label={t("objinfo.height")}
            value={len(height)}
            {...lenProps}
            onCommit={(h) => commitSize(width, unlen(h))}
          />
          {/* Formspezifische Zusatzfelder (nur wenn das Modell den Wert direkt
              hergibt — andere Formen bleiben ohne Zusatzfeld, s. Dateikopf). */}
          {drawingShape === "line" && rawDrawing?.geom.shape === "line" && (
            <>
              <DimensionField
                label={t("objinfo.drawing.length")}
                value={len(Math.hypot(width, height))}
                {...lenProps}
                onCommit={(v) => host.onSetDrawingLineLength(unlen(v))}
              />
              <DimensionField
                label={t("objinfo.drawing.angle")}
                value={toDeg360(
                  Math.atan2(
                    rawDrawing.geom.b.y - rawDrawing.geom.a.y,
                    rawDrawing.geom.b.x - rawDrawing.geom.a.x,
                  ),
                )}
                min={-Infinity}
                step={1}
                unit="°"
                onCommit={(v) => host.onSetDrawingLineAngle(v)}
              />
            </>
          )}
          {drawingShape === "text" && rawDrawing?.geom.shape === "text" && (
            <DimensionField
              label={t("objinfo.drawing.paperHeight")}
              value={rawDrawing.geom.paperHeight ?? 0}
              min={0}
              step={0.5}
              unit="mm"
              onCommit={(v) => host.onSetDrawingTextPaperHeight(v)}
            />
          )}
          {sel.kind === "drawing2d" && sel.area !== undefined && (
            <div className="objinfo-field">
              <span className="objinfo-flabel">{t("objinfo.drawing.area")}</span>
              <span className="objinfo-fval">{sel.area.toFixed(2)} m²</span>
            </div>
          )}
          {drawingShape === "circle" && (
            <DimensionField
              label={t("objinfo.drawing.radius")}
              value={len(width / 2)}
              {...lenProps}
              onCommit={(v) => host.onSetDrawingCircleRadius(unlen(v))}
            />
          )}
          {drawingShape === "arc" && rawDrawing?.geom.shape === "arc" && (
            <>
              <DimensionField
                label={t("objinfo.drawing.radius")}
                value={len(rawDrawing.geom.r)}
                {...lenProps}
                onCommit={(v) => host.onSetDrawingArcRadius(unlen(v))}
              />
              <DimensionField
                label={t("objinfo.drawing.startAngle")}
                value={toDeg360(rawDrawing.geom.a0)}
                min={-Infinity}
                step={1}
                unit="°"
                onCommit={(v) => host.onSetDrawingArcStartAngle(v)}
              />
              <DimensionField
                label={t("objinfo.drawing.endAngle")}
                value={toDeg360(rawDrawing.geom.a1)}
                min={-Infinity}
                step={1}
                unit="°"
                onCommit={(v) => host.onSetDrawingArcEndAngle(v)}
              />
            </>
          )}
        </>
      )}
      {/* Kontext-Objekt (importiertes Gebäude/Terrain/Konturen): reale LV95-
          Koordinate des Bbox-Mittelpunkts — direkt sichtbar, ob/wohin
          georeferenziert importiert wurde (Nutzer-Wunsch zum Prüfen). */}
      {sel.contextObject && (
        <>
          <div className="objinfo-sep" />
          <div className="objinfo-section-label">{t("objinfo.contextObject.section")}</div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.contextObject.type")}</span>
            <span className="objinfo-fval">{t(`objinfo.contextObject.type.${sel.contextObject.objType}`)}</span>
          </div>
          {ctxObj && (
            <div className="site-panel objinfo-site">
              <ContextObjectProps obj={ctxObj} quantities={quantities} />
            </div>
          )}
          {sel.contextObject.lv95Center ? (
            <>
              <div className="objinfo-field">
                <span className="objinfo-flabel">{t("objinfo.contextObject.lv95E")}</span>
                <span className="objinfo-fval">{sel.contextObject.lv95Center.e.toFixed(1)}</span>
              </div>
              <div className="objinfo-field">
                <span className="objinfo-flabel">{t("objinfo.contextObject.lv95N")}</span>
                <span className="objinfo-fval">{sel.contextObject.lv95Center.n.toFixed(1)}</span>
              </div>
            </>
          ) : (
            <div className="objinfo-field">
              <span className="objinfo-fval objinfo-muted">{t("objinfo.contextObject.noAnchor")}</span>
            </div>
          )}
        </>
      )}
      {/* Die element-spezifischen Abschnitte (Wand/Decke/Öffnung/Treppe/Raum)
          werden jetzt im Attribute-Panel gerendert (AttributesPanel importiert
          die exportierten *Section-Komponenten). */}
    </div>
  );
}
