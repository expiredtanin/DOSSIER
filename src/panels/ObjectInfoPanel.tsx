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

import { useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { formatM } from "../model/types";
import type {
  RoofShape,
  SiaCategory,
  SliceTermination,
  StairShape,
  VerticalAnchor,
  WallReferenceLine,
} from "../model/types";
import { SIA_CATEGORIES, siaLabelFull } from "../geometry/roomArea";
import { Dropdown } from "../ui/Dropdown";
import { usePanelHost } from "./host";
import type {
  CeilingInfo,
  ColumnInfo,
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
  // über den Host). Bei Elementarten, die der Transform-Kern nicht kennt
  // (Decke/Öffnung/Treppe/Raum), ist der Host-Aufruf ein No-op — das Feld
  // zeigt danach wieder den unveränderten Wert (wie bei Breite/Höhe oben).
  const px = bbox.minX + anchor.fx * width;
  const py = bbox.minY + anchor.fy * height;

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
      {/* Kopfzeile: Typ + Kategorie. Die element-spezifischen Attribut-Abschnitte
          (Wand/Decke/Öffnung/Treppe/Raum) liegen jetzt im Attribute-Panel;
          ObjectInfo trägt nur noch Bezugspunkt + Masse. */}
      <div className="objinfo-head">
        <span className="objinfo-kind">{t(`objinfo.kind.${sel.kind}`)}</span>
        <span className="objinfo-cat">{sel.categoryCode}</span>
      </div>

      <div className="objinfo-sep" />

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
            value={px}
            min={-Infinity}
            onCommit={(nx) => host.onMoveSelectionBy(nx - px, 0)}
          />
          <DimensionField
            label={t("objinfo.y")}
            value={py}
            min={-Infinity}
            onCommit={(ny) => host.onMoveSelectionBy(0, ny - py)}
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
        value={width}
        onCommit={(w) => commitSize(w, height)}
      />
      <DimensionField
        label={t("objinfo.height")}
        value={height}
        onCommit={(h) => commitSize(width, h)}
      />
      {/* Linien-Länge bzw. Kreis-Radius (nur wenn die Selektion genau eine
          Linie/ein Kreis ist — das Modell gibt das direkt her, andere Formen
          bleiben ohne Zusatzfeld). */}
      {drawingShape === "line" && (
        <DimensionField
          label={t("objinfo.drawing.length")}
          value={Math.hypot(width, height)}
          onCommit={(v) => host.onSetDrawingLineLength(v)}
        />
      )}
      {drawingShape === "circle" && (
        <DimensionField
          label={t("objinfo.drawing.radius")}
          value={width / 2}
          onCommit={(v) => host.onSetDrawingCircleRadius(v)}
        />
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

      {/* Verjüngung (editierbar, 0..1) — löst eine Re-Extrusion (truck-WASM) aus. */}
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

      {/* Überstand + Dicke (Meter). */}
      {numField("objinfo.roof.overhang", roof.overhang, 0.05, (v) =>
        host.onSetRoofPatch({ overhang: Math.max(0, v) }),
      )}
      {numField("objinfo.roof.thickness", roof.thickness, 0.02, (v) =>
        host.onSetRoofPatch({ thickness: Math.max(0.01, v) }),
      )}

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

      {/* Editierbare Maße. */}
      <DimensionField
        label={t("objinfo.stair.width")}
        value={stair.width}
        onCommit={(v) => host.onSetStairWidth(v)}
      />
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
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.opening.section")}</div>

      {/* Tür-/Fenstertyp (Bibliothek) — je nach Art aus doorTypes bzw. windowTypes.
          Der ⚙-Knopf springt direkt in den Typeditor (Ressourcen-Fenster). */}
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
          onClick={() => host.onEditOpeningType(isDoor ? "door" : "window")}
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

      {/* Fläche + Volumen (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.area")}</span>
        <span className="objinfo-fval">{ceiling.area.toFixed(2)} m²</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.volume")}</span>
        <span className="objinfo-fval">{ceiling.volume.toFixed(2)} m³</span>
      </div>

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
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
}) {
  // Entwurf als String, damit Zwischenzustände (leer, „1.") tippbar sind.
  // `null` = kein aktiver Entwurf → zeige den Host-Wert.
  const [draft, setDraft] = useState<string | null>(null);

  const shown = draft ?? value.toFixed(3);

  function commit() {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (isFinite(v) && v >= min) onCommit(v);
  }

  return (
    <label className="objinfo-field">
      <span className="objinfo-flabel">{label}</span>
      <input
        className="objinfo-input"
        type="number"
        step={0.01}
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
      <span className="objinfo-unit">m</span>
    </label>
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
