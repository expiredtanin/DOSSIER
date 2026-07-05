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
import { formatM } from "../model/types";
import type {
  SiaCategory,
  StairShape,
  VerticalAnchor,
  WallReferenceLine,
} from "../model/types";
import { SIA_CATEGORIES, siaLabelFull } from "../geometry/roomArea";
import { Dropdown } from "../ui/Dropdown";
import { usePanelHost } from "./host";
import type {
  CeilingInfo,
  OpeningInfo,
  RoomInfo,
  StairInfo,
  WallInfo,
} from "../state/selectionInfo";

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

  // ── Leerzustand ───────────────────────────────────────────────────────────
  if (sel === null) {
    return (
      <div className="objinfo-panel">
        <div className="objinfo-empty">{t("objinfo.empty")}</div>
      </div>
    );
  }

  const { bbox } = sel;
  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;

  // X/Y des gewählten Bezugspunkts (Modell-Meter). Read-only: Der Kontrakt
  // bietet keinen Positions-Setter, daher wird hier kein Verschieben gefaket.
  const px = bbox.minX + anchor.fx * width;
  const py = bbox.minY + anchor.fy * height;

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
      {/* Kopfzeile: Typ + Kategorie. Die element-spezifischen Attribut-Abschnitte
          (Wand/Decke/Öffnung/Treppe/Raum) liegen jetzt im Attribute-Panel;
          ObjectInfo trägt nur noch Bezugspunkt + Masse. */}
      <div className="objinfo-head">
        <span className="objinfo-kind">{t(`objinfo.kind.${sel.kind}`)}</span>
        <span className="objinfo-cat">{sel.categoryCode}</span>
      </div>

      <div className="objinfo-sep" />

      {/* Bezugspunkt-Würfel (3×3). */}
      <div className="objinfo-section-label">{t("objinfo.refpoint")}</div>
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

      {/* X / Y des gewählten Bezugspunkts (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.x")}</span>
        <span className="objinfo-fval">{formatM(px)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.y")}</span>
        <span className="objinfo-fval">{formatM(py)}</span>
      </div>
      {/* Z ehrlich: Das Modell ist 2D pro Ebene; es gibt keine Z am Element.
          Daher „—" statt einer gefakten 0, mit kurzem Hinweis im Titel. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.z")}</span>
        <span className="objinfo-fval objinfo-muted" title={t("objinfo.zHint")}>
          —
        </span>
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

// ── Treppen-Attribut-Abschnitt ───────────────────────────────────────────────
// Grundform (gerade/L/Wendel), Laufbreite, Stufenanzahl, Steighöhe (+ abgeleitete
// Steigungshöhe/Auftrittstiefe), Laufrichtung; Referenzgeschoss + UK/OK read-only.
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

      {/* Art-Segment Fenster/Tür. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.kind")}</span>
        <div className="objinfo-segment">
          <button
            type="button"
            className={"objinfo-seg-btn" + (!isDoor ? " active" : "")}
            onClick={() => host.onSetOpeningKind("window")}
          >
            {t("objinfo.opening.kind.window")}
          </button>
          <button
            type="button"
            className={"objinfo-seg-btn" + (isDoor ? " active" : "")}
            onClick={() => host.onSetOpeningKind("door")}
          >
            {t("objinfo.opening.kind.door")}
          </button>
        </div>
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
              label: t("objinfo.wall.presetLabel", {
                name: ct.name,
                thickness: ct.thickness.toFixed(2),
              }),
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

      {/* Fläche (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.area")}</span>
        <span className="objinfo-fval">{ceiling.area.toFixed(2)} m²</span>
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

      {/* UK = OK − Dicke (abgeleitet, read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.ceiling.bottom")}</span>
        <span className="objinfo-fval">{formatM(ceiling.zBottom)}</span>
      </div>
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

      {/* Referenzlinie (wo die Achse über die Dicke liegt) — früher im ObjectInfo-
          Kopf, jetzt hier bei den Wand-Attributen. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.wall.refLine")}</span>
        <Dropdown
          value={wall.referenceLine}
          onChange={(v) => host.onSetWallReferenceLine(v as WallReferenceLine)}
          options={[
            { value: "left", label: t("objinfo.wall.refLine.left") },
            { value: "center", label: t("objinfo.wall.refLine.center") },
            { value: "right", label: t("objinfo.wall.refLine.right") },
          ]}
          title={t("objinfo.wall.refLine")}
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
              label: t("objinfo.wall.presetLabel", {
                name: wt.name,
                thickness: wt.thickness.toFixed(2),
              }),
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

      {/* UK & OK getrennt: je „an Geschoss gebunden" ODER „eigene Höhe". */}
      <VerticalAnchorRow
        label={t("objinfo.wall.bottom")}
        anchor={wall.bottom}
        defaultZ={wall.zBottom}
        floors={wall.floors}
        defaultFloorId={wall.floorId}
        onChange={(a) => host.onSetWallBottom(a)}
      />
      <VerticalAnchorRow
        label={t("objinfo.wall.top")}
        anchor={wall.top}
        defaultZ={wall.zTop}
        floors={wall.floors}
        defaultFloorId={wall.floorAbove?.id ?? wall.floorId}
        onChange={(a) => host.onSetWallTop(a)}
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
      {mode === "floor" ? (
        <div className="objinfo-field objinfo-subfield">
          <Dropdown
            value={anchor?.mode === "floor" ? anchor.floorId : defaultFloorId}
            onChange={(id) => onChange({ mode: "floor", floorId: id })}
            options={floors.map((f) => ({ value: f.id, label: f.name }))}
            title={label}
            width={150}
          />
        </div>
      ) : (
        <div className="objinfo-subfield">
          <DimensionField
            label={t("objinfo.z")}
            value={anchor?.mode === "custom" ? anchor.z : defaultZ}
            min={-Infinity}
            onCommit={(z) => onChange({ mode: "custom", z })}
          />
        </div>
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
