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

import { UValueRow } from "./UValueRow";
import { lengthFromDisplay, lengthToDisplay, unitsForLevel, xToDisplay, yFromDisplay, yToDisplay } from "../tools/displayUnits";
import { solidProps } from "../engine/truckSolid";
import type { SolidProps, SolidSpec } from "../engine/truckSolid";
import { useEffect, useRef, useState } from "react";
// Anzeige-Fallbacks für die Öffnungs-Linien-Übersteuerung (LineStyleRow) —
// dieselben Werte wie POCHE_STROKE/SYMBOL_HAIRLINE_MM im Grundriss (Kern: plan/style.rs)
// (reine UI-Default-Anzeige, kein Re-Export nötig).
const OPENING_LINE_DEFAULT_COLOR = "#1a1a1a";
const OPENING_LINE_DEFAULT_WEIGHT = 0.02;
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { flattenCategories, formatM } from "../model/types";
import type {
  DimRef,
  Dormer,
  DormerKind,
  DrawingLevel,
  RoofShape,
  SiaCategory,
  SliceTermination,
  StairShape,
  Vec2,
  VerticalAnchor,
  WallReferenceLine,
} from "../model/types";
import { SIA_CATEGORIES, siaLabelFull, surfaceOpeningInfo } from "../core";
import type { EdgeSpec, RoofEdge } from "../core";
import { Dropdown } from "../ui/Dropdown";
import type { DetailLevel } from "../model/viewTypes";
import { ColorHexField } from "../ui/ColorHexField";
import { usePanelHost } from "./host";
import type {
  CeilingInfo,
  ColumnInfo,
  DetailRefInfo,
  ExtrudedSolidInfo,
  OpeningInfo,
  RoofInfo,
  RoomInfo,
  StairInfo,
  WallInfo,
} from "../state/selectionInfo";
import type { MeasurementReadout } from "../tools/types";

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
  const sel = host.selection;

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

  // ── Leerzustand ───────────────────────────────────────────────────────────
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
  const u = unitsForLevel(host.project.drawingLevels.find((z) => z.id === sel.floorId));
  const len = (m: number): number => lengthToDisplay(u, m);
  const unlen = (v: number): number => lengthFromDisplay(u, v);
  const lenProps = { unit: u.suffix, digits: u.digits };

  // Rohe Drawing2D-Geometrie der Selektion (nur bei kind==="drawing2d") — für
  // die Linien-Länge/Kreis-Radius-Felder unten; die Selection-Sicht trägt
  // keine Geometrieform, daher direkter (Lese-)Zugriff aufs Projekt.
  const rawDrawing =
    sel.kind === "drawing2d"
      ? host.project.drawings2d.find((d) => d.id === sel.id)
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
            options={flattenCategories(host.project.layers).map((c) => ({
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
            options={host.project.drawingLevels
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

// ── Raum-Attribut-Abschnitt ──────────────────────────────────────────────────
// Editierbarer Name, SIA-416-Kategorie (5 Blatt-Kategorien), abgeleitete Fläche
// + Umfang (read-only), Referenzgeschoss, sowie ein Button, der den Rich-Text-
// Stempel-Editor öffnet. Alle Werte/Setter über den Host.
export function RoomSection({
  room,
  roomId,
  host,
}: {
  room: RoomInfo;
  roomId: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.room.section")}</div>

      {/* Name (editierbar). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.name")}</span>
        <input
          type="text"
          className="objinfo-text"
          value={room.name}
          onChange={(e) => host.onSetRoomName(e.target.value)}
          title={t("objinfo.room.name")}
        />
      </div>

      {/* SIA-416-Kategorie (5 Blatt-Kategorien). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.sia")}</span>
        <Dropdown
          value={room.siaCategory}
          onChange={(v) => host.onSetRoomSia(v as SiaCategory)}
          options={SIA_CATEGORIES.map((c) => ({
            value: c,
            label: siaLabelFull(c),
          }))}
          title={t("objinfo.room.sia")}
          width={170}
        />
      </div>

      {/* Fläche + Umfang (read-only, abgeleitet). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.area")}</span>
        <span className="objinfo-fval">{room.area.toFixed(2)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.perimeter")}</span>
        <span className="objinfo-fval">{formatM(room.perimeter)}</span>
      </div>

      {/* Referenzgeschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.room.refFloor")}</span>
        <span className="objinfo-fval">{room.floorName}</span>
      </div>

      {/* Stempel bearbeiten (öffnet den Rich-Text-Editor). */}
      <button
        type="button"
        className="objinfo-btn"
        onClick={() => host.onEditRoomStamp(roomId)}
      >
        {t("objinfo.room.editStamp")}
      </button>
    </>
  );
}

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
  const line = level.linePoints;
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
        {t("objinfo.sectionLine.section")} · {kindLabel}
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
        <span className="objinfo-flabel">{t("objinfo.sectionLine.depth")}</span>
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
          title={t("objinfo.sectionLine.depth")}
        />
      </div>

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
              ...host.project.drawingLevels
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
        {t("objinfo.sectionLine.delete")}
      </button>
    </>
  );
}

// ── Assoziative Bemassung ([38]) ────────────────────────────────────────────
// Je Punkt: frei, angehängt (Merkmal + Element) oder Bezug verloren; „Bemassung lösen" entfernt alle.
export function DimRefsSection({
  refs,
  drawingId,
  host,
}: {
  refs: (DimRef | null)[];
  drawingId: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  const lost = refs.some((r) => r?.lost);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.dimRefs.section")}</div>
      {refs.map((r, i) => (
        <div className="objinfo-field" key={i} data-testid="dim-ref">
          <span className="objinfo-flabel">{t("objinfo.dimRefs.point", { n: i + 1 })}</span>
          <span className="objinfo-fval">
            {!r
              ? t("objinfo.dimRefs.free")
              : r.lost
                ? t("objinfo.dimRefs.lost", { id: r.id })
                : `${t(`objinfo.dimRefs.feature.${r.feature}` as TranslationKey)} · ${r.id}${r.id2 ? ` / ${r.id2}` : ""}`}
          </span>
        </div>
      ))}
      {lost && <div className="objinfo-measure-hint">{t("objinfo.dimRefs.lostHint")}</div>}
      <div className="objinfo-field">
        <button type="button" className="objinfo-btn" onClick={() => host.onDetachDimension(drawingId)}>
          {t("cmd.dimdetach.label")}
        </button>
      </div>
    </>
  );
}

// ── Detail-/Schnitt-Verweis-Attribut-Abschnitt ──────────────────────────────
// Bezeichner (obere Zeile) + Blattverknüpfung (Dropdown der Project.layouts,
// „kein Verweis" löst sie); ohne Verknüpfung zusätzlich ein manueller
// Blattname-Platzhalter (untere Zeile, s. `DetailRefInfo`-Kommentar).
export function DetailRefSection({
  detailRef,
  drawingId,
  host,
}: {
  detailRef: DetailRefInfo;
  drawingId: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.detailRef.section")}</div>

      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.detailRef.label")}</span>
        <input
          type="text"
          className="objinfo-text"
          value={detailRef.label}
          onChange={(e) => host.onSetDetailRefLabel(drawingId, e.target.value)}
          title={t("objinfo.detailRef.label")}
        />
      </div>

      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.detailRef.sheet")}</span>
        <Dropdown
          value={detailRef.sheetLayoutId ?? ""}
          onChange={(v) => host.onSetDetailRefSheetLayout(drawingId, v === "" ? undefined : v)}
          options={[
            { value: "", label: t("objinfo.detailRef.sheet.none") },
            ...detailRef.availableLayouts.map((l) => ({ value: l.id, label: l.name })),
          ]}
          title={t("objinfo.detailRef.sheet")}
          width={130}
        />
      </div>

      {!detailRef.sheetLayoutId && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.detailRef.sheetLabel")}</span>
          <input
            type="text"
            className="objinfo-text"
            value={detailRef.sheetLabel ?? ""}
            placeholder={t("objinfo.detailRef.sheetLabel.hint")}
            onChange={(e) => host.onSetDetailRefSheetLabel(drawingId, e.target.value)}
            title={t("objinfo.detailRef.sheetLabel")}
          />
        </div>
      )}
    </>
  );
}

/** Volumen/Oberfläche/Schwerpunkt aus truck (asynchron, aus dem tessellierten B-Rep). */
function SolidPropsRows({ spec }: { spec: SolidSpec | null }) {
  const [props, setProps] = useState<SolidProps | null>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    let alive = true;
    setProps(null);
    if (!spec) return;
    solidProps(spec).then(
      (p) => alive && setProps(p),
      () => alive && setProps(null),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!props) return null;
  const f = (v: number, d = 2) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  return (
    <>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.volume")}</span>
        <span className="objinfo-fval">{f(props.volume)} m³</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.surface")}</span>
        <span className="objinfo-fval">{f(props.area)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.centroid")}</span>
        <span className="objinfo-fval">
          {f(props.centroid[0])} / {f(props.centroid[1])} / {f(props.centroid[2])}
        </span>
      </div>
      {!props.closed && <div className="objinfo-field objinfo-warn">{t("objinfo.extrudedSolid.notClosed")}</div>}
    </>
  );
}

// ── Extrusions-Attribut-Abschnitt (truck-Integration) ───────────────────────
// Höhe editierbar (löst Re-Extrusion aus); Grundfläche + Geschoss read-only.
export function ExtrudedSolidSection({
  solid,
  host,
}: {
  solid: ExtrudedSolidInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.extrudedSolid.section")}</div>

      {/* Höhe (editierbar, > 0) — löst eine Re-Extrusion (truck-WASM) aus. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.height")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.01}
          min={0.01}
          value={solid.height}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) host.onSetExtrudedSolidHeight(v);
          }}
          title={t("objinfo.extrudedSolid.height")}
        />
      </div>

      <SolidPropsRows spec={solid.spec} />

      {/* Abstand über Geschoss-UK (Brüstungs-/Durchbruchshöhe). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.baseOffset")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.05}
          value={solid.baseOffset}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) host.onSetExtrudedSolidBaseOffset(v);
          }}
          title={t("objinfo.extrudedSolid.baseOffset")}
        />
      </div>

      {/* Abzugskörper: zieht sich von Wänden/Decken/Stützen ab (Grundriss, Schnitt, 3D, STEP). */}
      {solid.canSubtract && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.subtract")}</span>
          <input
            type="checkbox"
            checked={solid.subtract}
            onChange={(e) => host.onSetExtrudedSolidSubtract(e.target.checked)}
            title={t("objinfo.extrudedSolid.subtractHint")}
          />
        </div>
      )}

      {solid.brepLabel && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.brep")}</span>
          <span className="objinfo-fval">{solid.brepLabel}</span>
        </div>
      )}

      {/* Eckenradius (editierbar, ≥ 0): echte Kreisbögen an den Ecken der Aussenkontur. */}
      {!solid.brepLabel && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.cornerRadius")}</span>
          <input
            type="number"
            className="objinfo-text"
            step={0.05}
            min={0}
            value={solid.cornerRadius}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) host.onSetExtrudedSolidCornerRadius(v);
            }}
            title={t("objinfo.extrudedSolid.cornerRadius")}
          />
        </div>
      )}

      {/* Fase (editierbar, ≥ 0): gerade Abschrägung der Ecken der Aussenkontur. */}
      {!solid.brepLabel && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.extrudedSolid.chamfer")}</span>
          <input
            type="number"
            className="objinfo-text"
            step={0.05}
            min={0}
            value={solid.chamfer}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) host.onSetExtrudedSolidChamfer(v);
            }}
            title={t("objinfo.extrudedSolid.chamfer")}
          />
        </div>
      )}

      {/* Verjüngung (editierbar, 0..1) — löst eine Re-Extrusion (truck-WASM) aus. */}
      {!solid.brepLabel && (
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.taper")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={0.05}
          min={0}
          max={1}
          value={solid.taper}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) host.onSetExtrudedSolidTaper(v);
          }}
          title={t("objinfo.extrudedSolid.taper")}
        />
      </div>
      )}

      {/* Grundfläche (read-only, abgeleitet). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.area")}</span>
        <span className="objinfo-fval">{solid.area.toFixed(2)} m²</span>
      </div>

      {/* Geschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.extrudedSolid.floor")}</span>
        <span className="objinfo-fval">{solid.floorName}</span>
      </div>
    </>
  );
}

// ── Stützen-Attribut-Abschnitt (Tragwerk) ───────────────────────────────────
// Profil (Rechteck/Kreis) + Masse, Höhe, Drehung editierbar; Geschoss + UK/OK
// read-only.
export function ColumnSection({
  column,
  host,
}: {
  column: ColumnInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.column.section")}</div>

      {/* Profil-Dropdown (Rechteck/Kreis). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.profile")}</span>
        <Dropdown
          value={column.profile.kind}
          onChange={(v) => host.onSetColumnProfileKind(v as "rect" | "round")}
          options={[
            { value: "rect", label: t("objinfo.column.profile.rect") },
            { value: "round", label: t("objinfo.column.profile.round") },
          ]}
          title={t("objinfo.column.profile")}
          width={130}
        />
      </div>

      {/* Editierbare Masse je Profil. */}
      {column.profile.kind === "round" ? (
        <DimensionField
          label={t("objinfo.column.radius")}
          value={column.profile.radius}
          onCommit={(v) => host.onSetColumnRadius(v)}
        />
      ) : (
        <>
          <DimensionField
            label={t("objinfo.column.width")}
            value={column.profile.kind === "rect" ? column.profile.width : 0}
            onCommit={(v) => host.onSetColumnWidth(v)}
          />
          <DimensionField
            label={t("objinfo.column.depth")}
            value={column.profile.kind === "rect" ? column.profile.depth : 0}
            onCommit={(v) => host.onSetColumnDepth(v)}
          />
        </>
      )}

      <DimensionField
        label={t("objinfo.column.height")}
        value={column.height}
        onCommit={(v) => host.onSetColumnHeight(v)}
      />

      {/* Drehung (Grad). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.rotation")}</span>
        <input
          type="number"
          className="objinfo-text"
          step={1}
          value={Number(column.rotationDeg.toFixed(1))}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) host.onSetColumnRotation(v);
          }}
          title={t("objinfo.column.rotation")}
        />
      </div>

      {/* Geschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.floor")}</span>
        <span className="objinfo-fval">{column.floorName}</span>
      </div>
    </>
  );
}

// ── Treppen-Attribut-Abschnitt ───────────────────────────────────────────────
// Grundform (gerade/L/Wendel), Laufbreite, Stufenanzahl, Steighöhe (+ abgeleitete
// Steigungshöhe/Auftrittstiefe), Laufrichtung; Referenzgeschoss + UK/OK read-only.
/** Rechteck-Umriss (CCW) aus unterer/linker Ecke + Breite/Tiefe (für Dach-Resize). */
function rectOutline(x0: number, y0: number, w: number, d: number) {
  return [
    { x: x0, y: y0 },
    { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + d },
    { x: x0, y: y0 + d },
  ];
}

/** Gauben ([G5]) des Dachs: Art, Masse, Neigung, Aufbau je Gaube; Hinzufügen über den Befehl „Gaube". */
function DormersSection({ roof, host }: { roof: RoofInfo; host: ReturnType<typeof usePanelHost> }) {
  const dormers = roof.dormers ?? [];
  const patch = (i: number, p: Partial<Dormer>) =>
    host.onSetRoofPatch({ dormers: dormers.map((d, k) => (k === i ? { ...d, ...p } : d)) }, `dormer-${i}`);
  const num = (labelKey: TranslationKey, value: number, step: number, apply: (v: number) => void) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(labelKey)}</span>
      <input
        type="number"
        className="objinfo-text"
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) apply(v);
        }}
        title={t(labelKey)}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.dormer.section")}</div>
      {dormers.map((d, i) => (
        <div key={d.id} data-testid="objinfo-dormer">
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.dormer.kind")}</span>
            <Dropdown
              value={d.kind}
              onChange={(v) => patch(i, { kind: v as DormerKind })}
              options={[
                { value: "schlepp", label: t("objinfo.dormer.kind.schlepp") },
                { value: "sattel", label: t("objinfo.dormer.kind.sattel") },
                { value: "flach", label: t("objinfo.dormer.kind.flach") },
                { value: "walm", label: t("objinfo.dormer.kind.walm") },
              ]}
              title={t("objinfo.dormer.kind")}
              width={130}
            />
            <button
              type="button"
              className="objinfo-typebtn"
              title={t("objinfo.dormer.remove")}
              aria-label={t("objinfo.dormer.remove")}
              onClick={() => host.onSetRoofPatch({ dormers: dormers.filter((_, k) => k !== i) })}
            >
              ×
            </button>
          </div>
          {num("objinfo.dormer.width", d.width, 0.1, (v) => patch(i, { width: Math.max(0.8, v) }))}
          {num("objinfo.dormer.frontHeight", d.frontHeight, 0.05, (v) => patch(i, { frontHeight: Math.max(0.5, v) }))}
          {d.kind !== "flach" &&
            num("objinfo.dormer.pitch", d.pitchDeg ?? (d.kind === "schlepp" ? 15 : 40), 1, (v) =>
              patch(i, { pitchDeg: Math.max(0, Math.min(75, v)), depth: undefined }),
            )}
          {d.kind === "schlepp" &&
            num("objinfo.dormer.depth", d.depth ?? 0, 0.1, (v) => patch(i, { depth: v > 0.1 ? v : undefined }))}
          {num("objinfo.dormer.overhang", d.overhang ?? 0.15, 0.05, (v) => patch(i, { overhang: Math.max(0, v) }))}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.dormer.wallType")}</span>
            <Dropdown
              value={d.wallTypeId ?? ""}
              onChange={(v) => patch(i, { wallTypeId: v || undefined })}
              options={[
                { value: "", label: t("objinfo.dormer.wallType.default") },
                ...host.project.wallTypes.map((wt) => ({ value: wt.id, label: wt.name })),
              ]}
              title={t("objinfo.dormer.wallType")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.dormer.roofType")}</span>
            <Dropdown
              value={d.roofTypeId ?? ""}
              onChange={(v) => patch(i, { roofTypeId: v || undefined })}
              options={[
                { value: "", label: t("objinfo.dormer.roofType.host") },
                ...(host.project.roofTypes ?? []).map((rt) => ({ value: rt.id, label: rt.name })),
              ]}
              title={t("objinfo.dormer.roofType")}
              width={130}
            />
          </div>
        </div>
      ))}
      <div className="objinfo-field">
        <button type="button" className="objinfo-typebtn" title={t("objinfo.dormer.add")} onClick={() => host.onRunCommand("dormer")}>
          {t("objinfo.dormer.addBtn")}
        </button>
      </div>
    </>
  );
}

/** Dach-Abschnitt: Form, Neigung(en), Überstand, Firstrichtung, Dicke. */
export function RoofSection({
  roof,
  host,
}: {
  roof: RoofInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const numField = (
    labelKey: TranslationKey,
    value: number,
    step: number,
    apply: (v: number) => void,
  ) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(labelKey)}</span>
      <input
        type="number"
        className="objinfo-text"
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) apply(v);
        }}
        title={t(labelKey)}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.roof.section")}</div>

      {/* Dachform. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.shape")}</span>
        <Dropdown
          value={roof.shape}
          onChange={(v) => host.onSetRoofPatch({ shape: v as RoofShape })}
          options={[
            { value: "flach", label: t("objinfo.roof.shape.flach") },
            { value: "pult", label: t("objinfo.roof.shape.pult") },
            { value: "sattel", label: t("objinfo.roof.shape.sattel") },
            { value: "walm", label: t("objinfo.roof.shape.walm") },
            { value: "mansarde", label: t("objinfo.roof.shape.mansarde") },
            { value: "zelt", label: t("objinfo.roof.shape.zelt") },
          ]}
          title={t("objinfo.roof.shape")}
          width={130}
        />
      </div>

      {/* Dachtyp (mehrschichtiger Aufbau) — leer = einschichtig (Dicke unten). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.type")}</span>
        <Dropdown
          value={roof.roofTypeId ?? ""}
          onChange={(v) => host.onSetRoofPatch({ roofTypeId: v || undefined })}
          options={[
            { value: "", label: t("objinfo.roof.type.single") },
            ...(host.project.roofTypes ?? []).map((rt) => ({ value: rt.id, label: rt.name })),
          ]}
          title={t("objinfo.roof.type")}
          width={130}
        />
      </div>
      <UValueRow project={host.project} kind="roof" typeId={roof.roofTypeId} />

      {/* Firstrichtung (X/Y) — nur bei Formen mit First relevant. */}
      {roof.shape !== "flach" && roof.shape !== "zelt" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.roof.ridgeAxis")}</span>
          <Dropdown
            value={roof.ridgeAxis}
            onChange={(v) => host.onSetRoofPatch({ ridgeAxis: v as "x" | "y" })}
            options={[
              { value: "x", label: t("objinfo.roof.ridgeAxis.x") },
              { value: "y", label: t("objinfo.roof.ridgeAxis.y") },
            ]}
            title={t("objinfo.roof.ridgeAxis")}
            width={130}
          />
        </div>
      )}

      {/* Neigung(en) — Flachdach hat keine. */}
      {roof.shape !== "flach" &&
        numField("objinfo.roof.pitch", roof.pitchDeg, 1, (v) =>
          host.onSetRoofPatch({ pitchDeg: Math.max(0, Math.min(85, v)) }),
        )}
      {roof.shape === "mansarde" &&
        numField("objinfo.roof.pitchUpper", roof.pitchUpperDeg ?? roof.pitchDeg / 2, 1, (v) =>
          host.onSetRoofPatch({ pitchUpperDeg: Math.max(0, Math.min(85, v)) }),
        )}
      {/* Mansarde-Untertyp (Giebel/Walm/Zelt) + Knicklage. */}
      {roof.shape === "mansarde" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.roof.mansardType")}</span>
          <Dropdown
            value={roof.mansardType ?? "giebel"}
            onChange={(v) =>
              host.onSetRoofPatch({ mansardType: v as "giebel" | "walm" | "zelt" })
            }
            options={[
              { value: "giebel", label: t("objinfo.roof.mansard.giebel") },
              { value: "walm", label: t("objinfo.roof.mansard.walm") },
              { value: "zelt", label: t("objinfo.roof.mansard.zelt") },
            ]}
            title={t("objinfo.roof.mansardType")}
            width={130}
          />
        </div>
      )}
      {roof.shape === "mansarde" &&
        numField("objinfo.roof.mansardKnee", (roof.mansardKneeRatio ?? 0.4) * 100, 1, (v) =>
          host.onSetRoofPatch({ mansardKneeRatio: Math.max(5, Math.min(49, v)) / 100 }),
        )}

      {roof.shape === "sattel" &&
        numField("objinfo.roof.halfHip", (roof.halfHipRatio ?? 0) * 100, 5, (v) =>
          host.onSetRoofPatch({ halfHipRatio: Math.max(0, Math.min(90, v)) / 100 }),
        )}

      {/* Grundriss-Masse (Breite/Tiefe): das Umriss-Rechteck neu bilden, die
          untere/linke Ecke (minX/minY) bleibt fix. */}
      {/* Mit Innenhöfen oder Kanten ausserhalb eines Vierecks würde das Rechteck die Höfe/Kantenneigungen
          zerstören — dort entfallen Breite/Tiefe. */}
      {roof.holes.length === 0 &&
        roof.edges.length === 4 &&
        numField("objinfo.roof.width", roof.width, 0.1, (v) => {
          const w = Math.max(0.2, v);
          host.onSetRoofPatch({
            outline: rectOutline(roof.minX, roof.minY, w, roof.depth),
          });
        })}
      {roof.holes.length === 0 &&
        roof.edges.length === 4 &&
        numField("objinfo.roof.depth", roof.depth, 0.1, (v) => {
          const d = Math.max(0.2, v);
          host.onSetRoofPatch({
            outline: rectOutline(roof.minX, roof.minY, roof.width, d),
          });
        })}

      {/* Überstand: Traufe (senkrecht zum First) + Ortgang (Giebelseite). */}
      {numField("objinfo.roof.overhang", roof.overhang, 0.05, (v) =>
        host.onSetRoofPatch({ overhang: Math.max(0, v) }),
      )}
      {roof.shape !== "flach" &&
        roof.shape !== "zelt" &&
        numField(
          "objinfo.roof.overhangGable",
          roof.overhangGable ?? roof.overhang,
          0.05,
          (v) => host.onSetRoofPatch({ overhangGable: Math.max(0, v) }),
        )}
      {numField("objinfo.roof.thickness", roof.thickness, 0.02, (v) =>
        host.onSetRoofPatch({ thickness: Math.max(0.01, v) }),
      )}
      {/* Traufhöhe (absolutes Z) — z. B. für einen Kniestock übers Geschoss anheben. */}
      {numField("objinfo.roof.baseElevation", roof.baseElevation, 0.1, (v) =>
        host.onSetRoofPatch({ baseElevation: v }),
      )}

      {/* Kanten: Neigung je Kante (leer = Standard) und Giebel ([26]). Wirkt bei Sattel/Walm/
          Mansarde/Zelt; Flach und Pult ignorieren sie. */}
      {roof.shape !== "flach" && roof.shape !== "pult" && (
        <RoofEdgesSection roof={roof} host={host} />
      )}
      {/* Innenhöfe: Liste mit Entfernen, Hinzufügen über den Befehl „Dachhof“. */}
      <DormersSection roof={roof} host={host} />
      {roof.shape !== "pult" && (
        <>
          <div className="objinfo-sep" />
          <div className="objinfo-section-label">{t("objinfo.roof.courts")}</div>
          {roof.holes.map((h, i) => (
            <div className="objinfo-field" key={i}>
              <span className="objinfo-flabel objinfo-muted">
                {t("objinfo.roof.courtRow", { n: i + 1, area: h.area.toFixed(2) })}
              </span>
              <button
                type="button"
                className="objinfo-typebtn"
                title={t("objinfo.roof.courtRemove")}
                aria-label={t("objinfo.roof.courtRemove")}
                onClick={() => host.onRemoveRoofHole(i)}
              >
                ×
              </button>
            </div>
          ))}
          <div className="objinfo-field">
            <button
              type="button"
              className="objinfo-typebtn"
              title={t("objinfo.roof.courtAdd")}
              onClick={() => host.onRunCommand("roofhole")}
            >
              {t("objinfo.roof.courtAddBtn")}
            </button>
          </div>
        </>
      )}
      <div className="objinfo-sep" />

      {/* Abgeleitete Werte (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.ridgeHeight")}</span>
        <span className="objinfo-fval">{formatM(roof.ridgeHeight)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.area")}</span>
        <span className="objinfo-fval">{roof.footprintArea.toFixed(2)} m²</span>
      </div>
    </>
  );
}

/** Kantenliste eines Dachs: Neigung je Kante (leer = Standard) + Giebel-Schalter. */
function RoofEdgesSection({
  roof,
  host,
}: {
  roof: RoofInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  // Tippen einer Zahl = ein Undo-Schritt je Kante (gleicher coalesceKey, s. Host).
  const setEdge = (e: RoofEdge, spec: EdgeSpec) => host.onSetRoofEdge(e.index, spec);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.roof.edges")}</div>
      {roof.edges.map((e) => {
        const label =
          e.ring === 0
            ? t("objinfo.roof.edge", { n: e.edge + 1 })
            : t("objinfo.roof.edgeCourt", { c: e.ring, n: e.edge + 1 });
        const gable = e.spec.kind === "gable";
        const placeholder = e.defaultGable ? t("objinfo.roof.edgeGable") : String(roof.pitchDeg);
        return (
          <div className="objinfo-field objinfo-roof-edge" key={e.index} data-edge={e.index}>
            <span className="objinfo-flabel" title={`${e.length.toFixed(2)} m`}>
              {label}
            </span>
            <input
              type="number"
              className="objinfo-text"
              min={0}
              max={89}
              step={1}
              disabled={gable}
              placeholder={placeholder}
              value={e.spec.kind === "pitch" ? Number(e.spec.deg.toFixed(2)) : ""}
              aria-label={`${label}: ${t("objinfo.roof.edgePitch")}`}
              title={t("objinfo.roof.edgePitch")}
              onChange={(ev) => {
                const raw = ev.target.value;
                if (raw === "") return setEdge(e, { kind: "default" });
                const v = Number(raw);
                if (Number.isFinite(v)) setEdge(e, { kind: "pitch", deg: v });
              }}
            />
            <label className="objinfo-muted" title={t("objinfo.roof.edgeGableHint")}>
              <input
                type="checkbox"
                checked={gable}
                aria-label={`${label}: ${t("objinfo.roof.edgeGable")}`}
                onChange={(ev) => setEdge(e, ev.target.checked ? { kind: "gable" } : { kind: "default" })}
              />
              {t("objinfo.roof.edgeGable")}
            </label>
          </div>
        );
      })}
      {roof.hasEdgePitch && (
        <div className="objinfo-field">
          <button
            type="button"
            className="objinfo-typebtn"
            onClick={() => host.onSetRoofPatch({ edgePitchDeg: undefined })}
          >
            {t("objinfo.roof.edgesReset")}
          </button>
        </div>
      )}
    </>
  );
}

export function StairSection({
  stair,
  host,
}: {
  stair: StairInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.stair.section")}</div>

      {/* Treppentyp (Bibliothek) — treibt u. a. die 3D-Tragart (massiv/offen). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.type")}</span>
        <Dropdown
          value={stair.typeId ?? ""}
          onChange={(v) => host.onSetStairType(v)}
          options={[
            { value: "", label: t("objinfo.type.none") },
            ...(host.project.stairTypes ?? []).map((st) => ({
              value: st.id,
              label: st.name,
            })),
          ]}
          title={t("objinfo.stair.type")}
          width={130}
        />
      </div>

      {/* Grundform-Dropdown. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.shape")}</span>
        <Dropdown
          value={stair.shape}
          onChange={(v) => host.onSetStairShape(v as StairShape)}
          options={[
            { value: "straight", label: t("objinfo.stair.shape.straight") },
            { value: "L", label: t("objinfo.stair.shape.L") },
            { value: "spiral", label: t("objinfo.stair.shape.spiral") },
          ]}
          title={t("objinfo.stair.shape")}
          width={130}
        />
      </div>

      {/* Referenzpunkt der Laufbreite (links/mitte/rechts). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.referenz")}</span>
        <Dropdown
          value={stair.referenz ?? "mitte"}
          onChange={(v) => host.onSetStairReferenz(v as "links" | "mitte" | "rechts")}
          options={[
            { value: "links", label: t("objinfo.stair.referenz.links") },
            { value: "mitte", label: t("objinfo.stair.referenz.mitte") },
            { value: "rechts", label: t("objinfo.stair.referenz.rechts") },
          ]}
          title={t("objinfo.stair.referenz")}
          width={130}
        />
      </div>

      {/* Laufrichtung (aufwärts/abwärts). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.direction")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (stair.up ? " active" : "")}
            onClick={() => host.onSetStairUp(true)}
          >
            {t("objinfo.stair.direction.up")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (!stair.up ? " active" : "")}
            onClick={() => host.onSetStairUp(false)}
          >
            {t("objinfo.stair.direction.down")}
          </button>
        </div>
      </div>

      {/* Pfeil-Darstellung (offener Winkel- oder gefüllter SIA-Vollpfeil). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.arrow")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + ((stair.arrowStyle ?? "line") === "line" ? " active" : "")}
            onClick={() => host.onSetStairArrowStyle("line")}
          >
            {t("objinfo.stair.arrow.line")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (stair.arrowStyle === "filled" ? " active" : "")}
            onClick={() => host.onSetStairArrowStyle("filled")}
          >
            {t("objinfo.stair.arrow.filled")}
          </button>
        </div>
      </div>

      {/* Editierbare Maße. */}
      <DimensionField
        label={t("objinfo.stair.width")}
        value={stair.width}
        onCommit={(v) => host.onSetStairWidth(v)}
      />
      {stair.shape === "spiral" && (
        <DimensionField
          label={t("objinfo.stair.column")}
          value={stair.centerColumn ?? 0}
          onCommit={(v) => host.onSetStairColumn(v)}
        />
      )}
      <DimensionField
        label={t("objinfo.stair.steps")}
        value={stair.stepCount}
        onCommit={(v) => host.onSetStairSteps(v)}
      />
      <DimensionField
        label={t("objinfo.stair.rise")}
        value={stair.totalRise}
        onCommit={(v) => host.onSetStairRise(v)}
      />

      {/* Abgeleitete Werte (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.riser")}</span>
        <span className="objinfo-fval">{formatM(stair.riserHeight)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.tread")}</span>
        <span className="objinfo-fval">{formatM(stair.treadDepth)}</span>
      </div>

      {/* Referenzgeschoss (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.refFloor")}</span>
        <span className="objinfo-fval">{stair.floorName}</span>
      </div>

      <div className="objinfo-sep" />

      {/* UK/OK (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.bottom")}</span>
        <span className="objinfo-fval">{formatM(stair.zBottom)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.stair.top")}</span>
        <span className="objinfo-fval">{formatM(stair.zTop)}</span>
      </div>
    </>
  );
}

// ── Öffnungs-Attribut-Abschnitt ──────────────────────────────────────────────
// Art (Fenster/Tür), Wirts-Wand, Position/Breite/Höhe/Brüstung, bei Türen
// zusätzlich Anschlag/Aufschlag/Richtung/Winkel; UK/OK read-only.
export function OpeningSection({
  opening,
  host,
}: {
  opening: OpeningInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const isDoor = opening.kind === "door";
  if (opening.hostRoofId || opening.hostCeilingId) {
    return <SurfaceOpeningSection opening={opening} host={host} />;
  }
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.opening.section")}</div>

      {/* Tür-/Fenstertyp (Bibliothek) — je nach Art aus doorTypes bzw. windowTypes.
          Der ⚙-Knopf öffnet den reichen Fenster-/Tür-Einstellungsdialog. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.type")}</span>
        <Dropdown
          value={opening.typeId ?? ""}
          onChange={(v) => host.onSetOpeningType(v)}
          options={[
            { value: "", label: t("objinfo.type.none") },
            ...(isDoor
              ? host.project.doorTypes ?? []
              : host.project.windowTypes ?? []
            ).map((ty) => ({ value: ty.id, label: ty.name })),
          ]}
          title={t("objinfo.opening.type")}
          width={106}
        />
        <button
          type="button"
          className="objinfo-typebtn"
          title={t("objinfo.opening.editType")}
          aria-label={t("objinfo.opening.editType")}
          onClick={() => host.onOpenOpeningEditor(opening.id)}
        >
          ⚙
        </button>
      </div>

      {/* Art (Fenster/Tür) — read-only: die Gattung wird beim Platzieren mit dem
          jeweiligen Werkzeug festgelegt und NICHT nachträglich umgeschaltet
          (ein Fenster in eine Tür zu verwandeln ergibt keinen sinnvollen Bauteil). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.kind")}</span>
        <span className="objinfo-fval">
          {t(isDoor ? "objinfo.opening.kind.door" : "objinfo.opening.kind.window")}
        </span>
      </div>

      {/* Wirts-Wand (read-only Anzeige des Geschosses/Wand-Bezugs). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.hostWall")}</span>
        <span className="objinfo-fval">{opening.hostWallName}</span>
      </div>

      {/* Editierbare Maße. */}
      <DimensionField
        label={t("objinfo.opening.position")}
        value={opening.position}
        onCommit={(v) => host.onSetOpeningPosition(v)}
      />
      <DimensionField
        label={t("objinfo.opening.width")}
        value={opening.width}
        onCommit={(v) => host.onSetOpeningWidth(v)}
      />
      <DimensionField
        label={t("objinfo.opening.height")}
        value={opening.height}
        onCommit={(v) => host.onSetOpeningHeight(v)}
      />
      {!isDoor && (
        <>
          <DimensionField
            label={t("objinfo.opening.sill")}
            value={opening.sillHeight}
            onCommit={(v) => host.onSetOpeningSill(v)}
          />
          {/* Fenster-spezifisch: Flügelanzahl (1–4). */}
          <DimensionField
            label={t("objinfo.opening.wingCount")}
            value={opening.wingCount ?? 1}
            min={1}
            onCommit={(v) => host.onSetOpeningWingCount(Math.max(1, Math.min(4, Math.round(v))))}
          />
          {/* Grundriss-Linien je Kategorie: Rahmen (Blendrahmen+Stulp), Fenster
              (Flügelrahmen/Sprossen), Sims (Auf-/Untersicht, nur wenn der
              Fenstertyp sie aktiviert hat — s. WindowType.sillLine). */}
          <LineStyleRow
            label={t("objinfo.opening.frameLine")}
            value={opening.frameLine}
            fallbackColor={OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningFrameLine}
          />
          <LineStyleRow
            label={t("objinfo.opening.frameViewLine")}
            value={opening.frameViewLine}
            fallbackColor={opening.frameLine?.color ?? OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={opening.frameLine?.weight ?? OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningFrameViewLine}
          />
          <LineStyleRow
            label={t("objinfo.opening.sashLine")}
            value={opening.sashLine}
            fallbackColor={OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningSashLine}
          />
          <LineStyleRow
            label={t("objinfo.opening.sillLine")}
            value={opening.sillLineStyle}
            fallbackColor={OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningSillLineStyle}
          />
        </>
      )}

      {/* Tür-spezifisch: Typ / Sturzlinien / Anschlag / Aufschlagseite / Richtung / Winkel. */}
      {isDoor && (
        <>
          {/* Tür-Typ (normal / Wandöffnung). */}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.doorType")}</span>
            <Dropdown
              value={opening.doorType ?? "normal"}
              onChange={(v) => host.onSetOpeningDoorType(v as "normal" | "wandoeffnung")}
              options={[
                { value: "normal", label: t("objinfo.opening.doorType.normal") },
                { value: "wandoeffnung", label: t("objinfo.opening.doorType.wandoeffnung") },
              ]}
              title={t("objinfo.opening.doorType")}
              width={130}
            />
          </div>
          {/* Sturzlinien-Darstellung (keine/innen/aussen/beide). */}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.lintelLines")}</span>
            <Dropdown
              value={opening.lintelLines ?? "beide"}
              onChange={(v) => host.onSetOpeningLintelLines(v as "keine" | "innen" | "aussen" | "beide")}
              options={[
                { value: "keine", label: t("objinfo.opening.lintelLines.keine") },
                { value: "innen", label: t("objinfo.opening.lintelLines.innen") },
                { value: "aussen", label: t("objinfo.opening.lintelLines.aussen") },
                { value: "beide", label: t("objinfo.opening.lintelLines.beide") },
              ]}
              title={t("objinfo.opening.lintelLines")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.hinge")}</span>
            <Dropdown
              value={opening.hinge ?? "start"}
              onChange={(v) => host.onSetOpeningHinge(v as "start" | "end")}
              options={[
                { value: "start", label: t("objinfo.opening.hinge.start") },
                { value: "end", label: t("objinfo.opening.hinge.end") },
              ]}
              title={t("objinfo.opening.hinge")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.swing")}</span>
            <Dropdown
              value={opening.swing ?? "left"}
              onChange={(v) => host.onSetOpeningSwing(v as "left" | "right")}
              options={[
                { value: "left", label: t("objinfo.opening.swing.left") },
                { value: "right", label: t("objinfo.opening.swing.right") },
              ]}
              title={t("objinfo.opening.swing")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.dir")}</span>
            <Dropdown
              value={opening.openingDir ?? "in"}
              onChange={(v) => host.onSetOpeningDir(v as "in" | "out")}
              options={[
                { value: "in", label: t("objinfo.opening.dir.in") },
                { value: "out", label: t("objinfo.opening.dir.out") },
              ]}
              title={t("objinfo.opening.dir")}
              width={130}
            />
          </div>
          <DimensionField
            label={t("objinfo.opening.swingAngle")}
            value={opening.swingAngle ?? 90}
            min={1}
            onCommit={(v) => host.onSetOpeningSwingAngle(v)}
          />
        </>
      )}

      {/* Detailstufe-Übersteuerung — fehlt sie ("" = Ansicht), gilt die
          ansichtsweite Detailstufe (Grundriss-Kopfzeile). Wirkt auf dasselbe
          grob/mittel/fein-Symbol wie die Ansichts-Detailstufe (Türblatt-Bogen,
          Rahmen/Glaslinien), nur PRO ELEMENT statt für den ganzen Plan. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.detailLevel")}</span>
        <Dropdown
          value={opening.detailLevel ?? ""}
          onChange={(v) =>
            host.onSetOpeningDetailLevel(v === "" ? undefined : (v as DetailLevel))
          }
          options={[
            { value: "", label: t("objinfo.detailLevel.view") },
            { value: "grob", label: t("topbar.detail.grob") },
            { value: "mittel", label: t("topbar.detail.mittel") },
            { value: "fein", label: t("topbar.detail.fein") },
          ]}
          title={t("objinfo.opening.detailLevel")}
          width={130}
        />
      </div>

      <div className="objinfo-sep" />

      {/* UK/OK (read-only, aus der Wand-UK + Brüstung/Höhe abgeleitet). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.bottom")}</span>
        <span className="objinfo-fval">{formatM(opening.zBottom)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.top")}</span>
        <span className="objinfo-fval">{formatM(opening.zTop)}</span>
      </div>
    </>
  );
}

// ── Dach-/Deckenfenster ([103]) ─────────────────────────────────────────────
// Wirt (Dach/Decke + Geschoss), Breite quer und Höhe im Gefälle (in der Fläche gemessen), Lage des
// Mittelpunkts im Grundriss, Drehung nur auf waagrechten Flächen; UK/OK und Neigung aus dem Kern.
function SurfaceOpeningSection({
  opening,
  host,
}: {
  opening: OpeningInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const info = surfaceOpeningInfo(host.project, opening.id);
  const roof = !!opening.hostRoofId;
  const hp = opening.hostPoint ?? { x: 0, y: 0 };
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.opening.section")}</div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.type")}</span>
        <Dropdown
          value={opening.typeId ?? ""}
          onChange={(v) => host.onSetOpeningType(v)}
          options={[
            { value: "", label: t("objinfo.type.none") },
            ...(host.project.windowTypes ?? []).map((ty) => ({ value: ty.id, label: ty.name })),
          ]}
          title={t("objinfo.opening.type")}
          width={106}
        />
        <button
          type="button"
          className="objinfo-typebtn"
          title={t("objinfo.opening.editType")}
          aria-label={t("objinfo.opening.editType")}
          onClick={() => host.onOpenOpeningEditor(opening.id)}
        >
          ⚙
        </button>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t(roof ? "objinfo.opening.hostRoof" : "objinfo.opening.hostCeiling")}</span>
        <span className="objinfo-fval">{info?.hostName ?? "–"}</span>
      </div>
      <DimensionField label={t("objinfo.opening.surfaceWidth")} value={opening.width} onCommit={(v) => host.onSetOpeningWidth(v)} />
      <DimensionField label={t("objinfo.opening.surfaceHeight")} value={opening.height} onCommit={(v) => host.onSetOpeningHeight(v)} />
      <DimensionField label={t("objinfo.opening.hostX")} value={hp.x} min={-1e9} onCommit={(x) => host.onSetOpeningHost?.({ hostPoint: { x, y: hp.y } })} />
      <DimensionField label={t("objinfo.opening.hostY")} value={hp.y} min={-1e9} onCommit={(y) => host.onSetOpeningHost?.({ hostPoint: { x: hp.x, y } })} />
      {!roof && (
        <DimensionField
          label={t("objinfo.opening.hostAngle")}
          value={opening.hostAngle ?? 0}
          min={-360}
          unit="°"
          step={1}
          digits={1}
          onCommit={(a) => host.onSetOpeningHost?.({ hostAngle: a })}
        />
      )}
      {info && (
        <>
          <div className="objinfo-sep" />
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.slope")}</span>
            <span className="objinfo-fval">{info.slopeDeg.toFixed(1)}°</span>
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.bottom")}</span>
            <span className="objinfo-fval">{formatM(info.zBottom)}</span>
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.top")}</span>
            <span className="objinfo-fval">{formatM(info.zTop)}</span>
          </div>
        </>
      )}
    </>
  );
}

// ── Decken-Attribut-Abschnitt ────────────────────────────────────────────────
// Aufbau-Typ (einschichtig/mehrschichtig), Dicke/Preset, Referenzgeschoss +
// OK-Bindung, Fläche. Alle Werte/Setter über den Host.
export function CeilingSection({
  ceiling,
  host,
}: {
  ceiling: CeilingInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const isSingle = ceiling.singleLayer;
  const multiPresets = ceiling.ceilingTypes.filter((ct) => ct.layerCount > 1);

  function chooseSingle() {
    if (isSingle) return;
    host.onSetCeilingThickness(ceiling.thickness);
  }
  function chooseMulti() {
    if (!isSingle) return;
    const first = multiPresets[0];
    if (first) host.onSetCeilingType(first.id);
  }

  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.ceiling.section")}</div>

      {/* Aufbau-Typ-Segment. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.buildup")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (isSingle ? " active" : "")}
            onClick={chooseSingle}
          >
            {t("objinfo.wall.single")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (!isSingle ? " active" : "")}
            onClick={chooseMulti}
            disabled={isSingle && multiPresets.length === 0}
          >
            {t("objinfo.wall.multi")}
          </button>
        </div>
      </div>

      {/* Einschichtig → Dicke-Zahlfeld. Mehrschichtig → Preset-Dropdown. */}
      {isSingle ? (
        <DimensionField
          label={t("objinfo.ceiling.thickness")}
          value={ceiling.thickness}
          onCommit={(v) => host.onSetCeilingThickness(v)}
        />
      ) : (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.ceiling.preset")}</span>
          <Dropdown
            value={ceiling.typeId}
            onChange={(id) => host.onSetCeilingType(id)}
            options={ceiling.ceilingTypes.map((ct) => ({
              value: ct.id,
              label: ct.label,
              title: ct.name,
            }))}
            title={t("objinfo.ceiling.preset")}
            width={150}
          />
        </div>
      )}

      {/* Referenzgeschoss (read-only Anzeige). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.refFloor")}</span>
        <span className="objinfo-fval">{ceiling.floorName}</span>
      </div>
      <UValueRow project={host.project} kind="ceiling" typeId={ceiling.typeId} />

      {/* Fläche + Volumen (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.area")}</span>
        <span className="objinfo-fval">{ceiling.area.toFixed(2)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.volume")}</span>
        <span className="objinfo-fval">{ceiling.volume.toFixed(2)} m³</span>
      </div>

      {/* Aussparungen (Treppenauge/Schacht) — Liste mit Entfernen je Loch.
          Anlegen über den Befehl „Deckenloch" (BIM-Ribbon). */}
      {ceiling.openings.length > 0 && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.ceiling.openings")}</span>
            <span className="objinfo-fval">{ceiling.openings.length}</span>
          </div>
          {ceiling.openings.map((o, i) => (
            <div className="objinfo-field" key={i}>
              <span className="objinfo-flabel objinfo-muted">
                {`${i + 1}: ${o.width.toFixed(2)} × ${o.depth.toFixed(2)} m`}
              </span>
              <button
                type="button"
                className="objinfo-typebtn"
                title={t("objinfo.ceiling.removeOpening")}
                aria-label={t("objinfo.ceiling.removeOpening")}
                onClick={() => host.onRemoveCeilingOpening(i)}
              >
                ×
              </button>
            </div>
          ))}
        </>
      )}

      <div className="objinfo-sep" />

      {/* OK der Decke: an Geschoss gebunden ODER eigene Höhe. */}
      <VerticalAnchorRow
        label={t("objinfo.ceiling.top")}
        anchor={ceiling.top}
        defaultZ={ceiling.zTop}
        floors={ceiling.floors}
        defaultFloorId={ceiling.floorId}
        onChange={(a) => host.onSetCeilingTop(a)}
      />

      {/* UK der Decke: an Geschoss gebunden ODER eigene Höhe; ohne Override
          bleibt es beim heutigen Verhalten UK = OK − Dicke. */}
      <VerticalAnchorRow
        label={t("objinfo.ceiling.bottom")}
        anchor={ceiling.bottom}
        defaultZ={ceiling.zBottom}
        floors={ceiling.floors}
        defaultFloorId={ceiling.floorId}
        onChange={(a) => host.onSetCeilingBottom?.(a)}
      />
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.height")}</span>
        <span className="objinfo-fval">{formatM(ceiling.zTop - ceiling.zBottom)}</span>
      </div>
    </>
  );
}

// ── Wand-Attribut-Abschnitt ──────────────────────────────────────────────────
// Aufbau-Typ (einschichtig/mehrschichtig), Dicke/Preset, Referenzgeschoss +
// Oberverknüpfung, UK/OK je Modus-Umschalter. Alle Werte/Setter über den Host.
export function WallSection({
  wall,
  host,
}: {
  wall: WallInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  // Aufbau-Typ-Segment: einschichtig vs. mehrschichtig. Aus dem Modell
  // abgeleitet (singleLayer); der Umschalter auf „mehrschichtig" wählt einen
  // mehrschichtigen Wandtyp-Preset (erster mit >1 Schicht), auf „einschichtig"
  // setzt er die Dicke des aktuellen Aufbaus als einschichtige Wand.
  const isSingle = wall.singleLayer;

  const multiPresets = wall.wallTypes.filter((wt) => wt.layerCount > 1);

  function chooseSingle() {
    if (isSingle) return;
    // Auf einschichtig wechseln: aktuelle Gesamtdicke als Einzelschicht setzen.
    host.onSetWallThickness(wall.thickness);
  }
  function chooseMulti() {
    if (!isSingle) return;
    const first = multiPresets[0];
    if (first) host.onSetWallType(first.id);
  }

  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.wall.section")}</div>

      {/* Referenzlinie (wo die Achse über die Dicke liegt) — außen/mitte/innen ODER
          bei mehrschichtigen Wänden eine SCHICHTTRENNLINIE (Fuge). Ein Fugenwert
          wird als "off:<offset>" kodiert und übersteuert die benannte Linie. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.refLine")}</span>
        <Dropdown
          value={
            wall.referenceOffset != null
              ? `off:${wall.referenceOffset.toFixed(4)}`
              : wall.referenceLine
          }
          onChange={(v) => {
            if (v.startsWith("off:")) host.onSetWallReferenceOffset(Number(v.slice(4)));
            else host.onSetWallReferenceLine(v as WallReferenceLine);
          }}
          options={[
            { value: "left", label: t("objinfo.wall.refLine.left") },
            { value: "center", label: t("objinfo.wall.refLine.center") },
            { value: "right", label: t("objinfo.wall.refLine.right") },
            ...wall.layerBoundaries.map((b) => ({
              value: `off:${b.offset.toFixed(4)}`,
              label: `${t("objinfo.wall.refLine.joint")} ${b.label}`,
            })),
          ]}
          title={t("objinfo.wall.refLine")}
          width={120}
        />
      </div>

      {/* Terminierung am Deckenanschluss (Zuschnitt, NICHT Priorität): ob die Wand
          an der Decke endet oder oberhalb wieder auftaucht. Default "both". */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.sliceTermination")}</span>
        <Dropdown
          value={wall.sliceTermination}
          onChange={(v) => host.onSetWallSliceTermination(v as SliceTermination)}
          options={[
            { value: "both", label: t("objinfo.wall.sliceTermination.both") },
            { value: "below", label: t("objinfo.wall.sliceTermination.below") },
            { value: "above", label: t("objinfo.wall.sliceTermination.above") },
          ]}
          title={t("objinfo.wall.sliceTermination")}
          width={120}
        />
      </div>

      {/* An Dach anschliessen ([G2]): automatisch endet die Wand an der Dach-Unterkante, "Ja"
          verlängert sie bis unter das Dach, "Nein" lässt die Dächer die Wand nicht schneiden. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.roofAttach")}</span>
        <Dropdown
          value={wall.roofAttach}
          onChange={(v) => host.onSetWallRoofAttach(v as "auto" | "on" | "off")}
          options={[
            { value: "auto", label: t("objinfo.wall.roofAttach.auto") },
            { value: "on", label: t("objinfo.wall.roofAttach.on") },
            { value: "off", label: t("objinfo.wall.roofAttach.off") },
          ]}
          title={t("objinfo.wall.roofAttach.tip")}
          width={120}
        />
      </div>

      {/* Aufbau-Typ-Segment. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.buildup")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (isSingle ? " active" : "")}
            onClick={chooseSingle}
          >
            {t("objinfo.wall.single")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (!isSingle ? " active" : "")}
            onClick={chooseMulti}
            disabled={isSingle && multiPresets.length === 0}
          >
            {t("objinfo.wall.multi")}
          </button>
        </div>
      </div>

      {/* Einschichtig → Dicke-Zahlfeld. Mehrschichtig → Preset-Dropdown. */}
      {isSingle ? (
        <DimensionField
          label={t("objinfo.wall.thickness")}
          value={wall.thickness}
          onCommit={(v) => host.onSetWallThickness(v)}
        />
      ) : (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.wall.preset")}</span>
          <Dropdown
            value={wall.wallTypeId}
            onChange={(id) => host.onSetWallType(id)}
            options={wall.wallTypes.map((wt) => ({
              value: wt.id,
              label: wt.label,
              title: wt.name,
            }))}
            title={t("objinfo.wall.preset")}
            width={150}
          />
        </div>
      )}

      {/* Referenzgeschoss (read-only Anzeige). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.refFloor")}</span>
        <span className="objinfo-fval">{wall.floorName}</span>
      </div>
      <UValueRow project={host.project} kind="wall" typeId={wall.wallTypeId} />

      {/* Länge + Volumen (read-only). Volumen ist NETTO — Fenster/Türen
          abgezogen; der Titel zeigt zusätzlich das Bruttovolumen. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.length")}</span>
        <span className="objinfo-fval">{formatM(wall.length)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.volume")}</span>
        <span
          className="objinfo-fval"
          title={
            wall.openingVolume > 0
              ? `${t("objinfo.wall.volumeGross")}: ${wall.grossVolume.toFixed(2)} m³ − ${wall.openingVolume.toFixed(2)} m³`
              : undefined
          }
        >
          {wall.netVolume.toFixed(2)} m³
        </span>
      </div>

      {/* Verknüpfung zum oberen Geschoss: OK an nächstes Geschoss binden. */}
      <label className="objinfo-field objinfo-check-field">
        <span className="objinfo-flabel">{t("objinfo.wall.linkAbove")}</span>
        <input
          type="checkbox"
          className="objinfo-check"
          checked={wall.top?.mode === "floor"}
          disabled={!wall.floorAbove}
          title={
            wall.floorAbove
              ? wall.floorAbove.name
              : t("objinfo.wall.floorAboveNone")
          }
          onChange={(e) => {
            if (e.target.checked && wall.floorAbove) {
              host.onSetWallTop({ mode: "floor", floorId: wall.floorAbove.id });
            } else {
              host.onSetWallTop(null);
            }
          }}
        />
      </label>

      <div className="objinfo-sep" />

      {/* OK & UK getrennt: je „an Geschoss gebunden" ODER „eigene Höhe". OK
          (oben) steht oben, UK (unten) darunter — räumlich passend (Nutzer). */}
      <VerticalAnchorRow
        label={t("objinfo.wall.top")}
        anchor={wall.top}
        defaultZ={wall.zTop}
        floors={wall.floors}
        defaultFloorId={wall.floorAbove?.id ?? wall.floorId}
        onChange={(a) => host.onSetWallTop(a)}
      />
      <VerticalAnchorRow
        label={t("objinfo.wall.bottom")}
        anchor={wall.bottom}
        defaultZ={wall.zBottom}
        floors={wall.floors}
        defaultFloorId={wall.floorId}
        onChange={(a) => host.onSetWallBottom(a)}
      />

      {/* Höhe = OK − UK (abgeleitet, read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.height")}</span>
        <span className="objinfo-fval">{formatM(wall.zTop - wall.zBottom)}</span>
      </div>
    </>
  );
}

// ── UK/OK-Zeile: Modus-Umschalter (Geschoss/eigene Höhe) + Feld ──────────────
// „Geschoss gebunden" → Geschoss-Dropdown; „eigene Höhe" → absolutes Z-Feld.
// `null`-Anchor (undefined im Modell) = Geschoss-Default; zeigt „eigene Höhe"
// mit dem aufgelösten Default-Z als Ausgangswert NICHT — Default ist
// „an Geschoss gebunden" (Geschoss-Default-Verhalten).
function VerticalAnchorRow({
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

// ── Editierbares Maßfeld ─────────────────────────────────────────────────────
// Kontrolliert über den vom Host gelieferten Wert, hält aber während des
// Tippens einen lokalen Entwurf. Commit auf blur/Enter; Escape verwirft.
// Nach erfolgreichem Resize liefert der Host eine neue bbox → neuer `value` →
// das Feld zeigt automatisch die aktualisierte Größe. `min` erlaubt negative
// Werte (z. B. absolute Z-Höhen unter 0).
function DimensionField({
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

/** Farbe + Strichstärke (mm) einer Linien-Kategorie, mit "System"-Fallback-
 *  Anzeige (Override `undefined` ⇒ zeigt `fallbackColor`/`fallbackWeight`,
 *  Ändern setzt sofort einen expliziten Override). */
function LineStyleRow({
  label,
  value,
  fallbackColor,
  fallbackWeight,
  onChange,
}: {
  label: string;
  value: { color?: string; weight?: number } | undefined;
  fallbackColor: string;
  fallbackWeight: number;
  onChange: (v: { color?: string; weight?: number } | undefined) => void;
}) {
  return (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{label}</span>
      <ColorHexField
        value={value?.color ?? fallbackColor}
        onChange={(color) => onChange({ ...value, color })}
      />
      <input
        className="objinfo-input objinfo-input-narrow"
        type="number"
        step={0.01}
        min={0}
        value={(value?.weight ?? fallbackWeight).toFixed(2)}
        onChange={(e) => {
          const w = Number(e.target.value);
          if (isFinite(w) && w >= 0) onChange({ ...value, weight: w });
        }}
        title={t("objinfo.lineWeight")}
      />
      <span className="objinfo-unit">mm</span>
    </div>
  );
}

// ── Dreh-Feld (Delta-Winkel in Grad) ─────────────────────────────────────────
// Anders als DimensionField zeigt dieses Feld KEINEN persistenten Host-Wert —
// eine „aktuelle Rotation" gibt es für die Selektion generell nicht (Wand ist
// nur eine Achse, Drawing2D/Extrusion tragen keinen Rotationswinkel). Das Feld
// ist daher ein Delta: Eingabe = Drehung ab jetzt, danach zeigt es wieder „0".
function RotateField({ onCommit }: { onCommit: (deg: number) => void }) {
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

// ── Mess-Werkzeug-Abschnitt ───────────────────────────────────────────────────
// Zeigt die Live-Messwerte (letztes Segment, aufsummierte Länge, umschlossene
// Fläche, Richtung). Fläche nur, sobald der Zug ≥ 3 Ecken hat.
function MeasurementSection({ m }: { m: MeasurementReadout }) {
  return (
    <div className="objinfo-measure">
      <div className="objinfo-section-label">{t("objinfo.measure.title")}</div>
      <div className="objinfo-measure-grid">
        <span className="objinfo-measure-key">{t("objinfo.measure.segment")}</span>
        <span className="objinfo-measure-val">{m.segment.toFixed(3)} m</span>
        <span className="objinfo-measure-key">{t("objinfo.measure.total")}</span>
        <span className="objinfo-measure-val">{m.total.toFixed(3)} m</span>
        <span className="objinfo-measure-key">{t("objinfo.measure.angle")}</span>
        <span className="objinfo-measure-val">{m.angle.toFixed(1)}°</span>
        {m.area != null && (
          <>
            <span className="objinfo-measure-key">{t("objinfo.measure.area")}</span>
            <span className="objinfo-measure-val">{m.area.toFixed(2)} m²</span>
          </>
        )}
      </div>
      <div className="objinfo-measure-hint">{t("objinfo.measure.hint")}</div>
    </div>
  );
}
