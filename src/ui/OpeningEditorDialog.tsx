// Reicher Fenster-/Tür-Einstellungsdialog (VW „Fenster bearbeiten"-Muster,
// Studie docs/design/window-editor-vectorworks-study.md). Drei Zonen:
//  1. Kategorie-Sidebar links,
//  2. Parameter-Panel Mitte,
//  3. Live-2D-Ansicht (Elevation) rechts — direkt aus den aktuellen Werten
//     gezeichnet (Rahmen/Flügel/Öffnungslinien/Verglasung/Rollladenkasten).
// Oben eine Stil-Leiste: Stil wählen · „Als Stil speichern…" · zurücksetzen.
//
// Der Dialog editiert TYP-Parameter (der referenzierte WindowType/DoorType =
// wiederverwendbarer Stil, wirkt auf alle Instanzen) UND INSTANZ-Parameter
// (Grösse/Position dieser Öffnung). Bezeichner englisch, UI-Text deutsch.

import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import type {
  DoorType,
  Opening,
  OpeningKind,
  Project,
  SashDef,
  WindowType,
} from "../model/types";
import { getDoorType, getWindowType, sashesOfWindowType, glazingPanesOf } from "../model/types";

/** P0-Kategorien der Sidebar, je nach Öffnungsart. */
type CatId =
  | "basis"
  | "groesse"
  | "rahmen"
  | "fluegel"
  | "sonnenschutz"
  | "tuerblatt";

export interface OpeningEditorDialogProps {
  openingId: string;
  project: Project;
  /** Typ-Feld (aktueller Stil) ändern — wirkt auf alle Instanzen des Stils. */
  onPatchWindowType: (typeId: string, patch: Partial<WindowType>) => void;
  onPatchDoorType: (typeId: string, patch: Partial<DoorType>) => void;
  /** Instanz-Feld dieser Öffnung ändern. */
  onPatchOpening: (patch: Partial<Opening>) => void;
  /** Öffnung einem anderen Stil zuweisen ("" = keiner). */
  onSetOpeningType: (typeId: string) => void;
  /** Aktuellen Stil als NEUEN benannten Stil ablegen und der Öffnung zuweisen. */
  onSaveAsStyle: (name: string) => void;
  onClose: () => void;
}

export function OpeningEditorDialog({
  openingId,
  project,
  onPatchWindowType,
  onPatchDoorType,
  onPatchOpening,
  onSetOpeningType,
  onSaveAsStyle,
  onClose,
}: OpeningEditorDialogProps) {
  const opening = (project.openings ?? []).find((o) => o.id === openingId);
  const isDoor = opening?.kind === "door";
  const wt = opening && !isDoor ? getWindowType(project, opening) : undefined;
  const dt = opening && isDoor ? getDoorType(project, opening) : undefined;

  const cats: { id: CatId; label: string }[] = isDoor
    ? [
        { id: "basis", label: t("oed.cat.basis") },
        { id: "groesse", label: t("oed.cat.groesse") },
        { id: "rahmen", label: t("oed.cat.rahmen") },
        { id: "tuerblatt", label: t("oed.cat.tuerblatt") },
      ]
    : [
        { id: "basis", label: t("oed.cat.basis") },
        { id: "groesse", label: t("oed.cat.groesse") },
        { id: "rahmen", label: t("oed.cat.rahmen") },
        { id: "fluegel", label: t("oed.cat.fluegel") },
        { id: "sonnenschutz", label: t("oed.cat.sonnenschutz") },
      ];
  const [cat, setCat] = useState<CatId>("basis");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!opening) {
    // Öffnung verschwand (Undo/Löschen während offen) → Dialog schliesst sich.
    return null;
  }

  const typeList = isDoor ? project.doorTypes ?? [] : project.windowTypes ?? [];
  const styleName =
    (isDoor ? dt?.name : wt?.name) ?? t("objinfo.type.none");

  const patchWt = (patch: Partial<WindowType>) => {
    if (wt) onPatchWindowType(wt.id, patch);
  };
  const patchDt = (patch: Partial<DoorType>) => {
    if (dt) onPatchDoorType(dt.id, patch);
  };

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="oed-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t(isDoor ? "oed.title.door" : "oed.title.window")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">
            {t(isDoor ? "oed.title.door" : "oed.title.window")}
          </span>
          <button className="imp-close" onClick={onClose} aria-label={t("export.close")}>
            ×
          </button>
        </header>

        {/* Stil-Leiste: Stil wählen · als Stil speichern · zurücksetzen. */}
        <div className="oed-stylebar">
          <span className="oed-style-label">{t("oed.style")}</span>
          <select
            className="oed-select oed-style-select"
            value={opening.typeId ?? ""}
            onChange={(e) => onSetOpeningType(e.target.value)}
          >
            <option value="">{t("objinfo.type.none")}</option>
            {typeList.map((ty) => (
              <option key={ty.id} value={ty.id}>
                {ty.name}
              </option>
            ))}
          </select>
          <div className="oed-stylebar-spacer" />
          <button
            type="button"
            className="oed-btn"
            title={t("oed.saveStyle.hint")}
            onClick={() => {
              const name = window.prompt(
                t("oed.saveStyle.prompt"),
                `${styleName} ${t("oed.saveStyle.copySuffix")}`,
              );
              if (name && name.trim()) onSaveAsStyle(name.trim());
            }}
          >
            {t("oed.saveStyle")}
          </button>
        </div>

        <div className="oed-main">
          {/* 1. Kategorie-Sidebar. */}
          <nav className="oed-sidebar" aria-label={t("oed.categories")}>
            {cats.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`oed-cat${cat === c.id ? " active" : ""}`}
                onClick={() => setCat(c.id)}
              >
                {c.label}
              </button>
            ))}
          </nav>

          {/* 2. Parameter-Panel. */}
          <div className="oed-panel">
            {!wt && !dt && (
              <div className="oed-hint oed-hint-warn">{t("oed.noStyle")}</div>
            )}
            {cat === "basis" && (
              <BasisPanel
                isDoor={isDoor}
                wt={wt}
                dt={dt}
                patchWt={patchWt}
                patchDt={patchDt}
              />
            )}
            {cat === "groesse" && (
              <GroessePanel opening={opening} isDoor={isDoor} onPatchOpening={onPatchOpening} />
            )}
            {cat === "rahmen" && (
              <RahmenPanel isDoor={isDoor} wt={wt} dt={dt} patchWt={patchWt} patchDt={patchDt} />
            )}
            {cat === "fluegel" && wt && <FluegelPanel wt={wt} patchWt={patchWt} />}
            {cat === "sonnenschutz" && wt && <SonnenschutzPanel wt={wt} patchWt={patchWt} />}
            {cat === "tuerblatt" && dt && <TuerblattPanel dt={dt} patchDt={patchDt} />}
          </div>

          {/* 3. Live-Ansicht (Elevation). */}
          <div className="oed-preview">
            <div className="oed-preview-title">{t("oed.preview")}</div>
            <ElevationPreview opening={opening} wt={wt} dt={dt} />
          </div>
        </div>

        <footer className="imp-foot">
          <button className="imp-btn primary" onClick={onClose}>
            {t("export.close")}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Parameter-Panels ────────────────────────────────────────────────────────

/** Kleines beschriftetes Zahlenfeld (Meter), lokal gepuffert. */
function NumField({
  label,
  value,
  step = 0.01,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="oed-field">
      <span className="oed-flabel">{label}</span>
      <input
        className="oed-input"
        type="number"
        step={step}
        min={min}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
        }}
      />
    </label>
  );
}

/** Beschriftetes Dropdown. */
function SelField<V extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
}) {
  return (
    <label className="oed-field">
      <span className="oed-flabel">{label}</span>
      <select
        className="oed-select"
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const OPENING_KIND_OPTS = (): { value: OpeningKind; label: string }[] => [
  { value: "dreh", label: t("oed.kind.dreh") },
  { value: "kipp", label: t("oed.kind.kipp") },
  { value: "drehkipp", label: t("oed.kind.drehkipp") },
  { value: "fest", label: t("oed.kind.fest") },
  { value: "schiebe", label: t("oed.kind.schiebe") },
];

type DoorKind = DoorType["kind"];
const DOOR_KIND_OPTS = (): { value: DoorKind; label: string }[] => [
  { value: "dreh", label: t("oed.kind.dreh") },
  { value: "schiebe", label: t("oed.kind.schiebe") },
  { value: "wandoeffnung", label: t("oed.door.wandoeffnung") },
];

function BasisPanel({
  isDoor,
  wt,
  dt,
  patchWt,
  patchDt,
}: {
  isDoor: boolean;
  wt?: WindowType;
  dt?: DoorType;
  patchWt: (p: Partial<WindowType>) => void;
  patchDt: (p: Partial<DoorType>) => void;
}) {
  if (isDoor && dt) {
    return (
      <SelField
        label={t("oed.f.kind")}
        value={dt.kind}
        options={DOOR_KIND_OPTS()}
        onChange={(v) => patchDt({ kind: v })}
      />
    );
  }
  if (wt) {
    return (
      <>
        <SelField
          label={t("oed.f.kind")}
          value={wt.kind}
          options={OPENING_KIND_OPTS()}
          onChange={(v) => patchWt({ kind: v })}
        />
        <SelField
          label={t("oed.f.glazing")}
          value={String(glazingPanesOf(wt)) as "1" | "2" | "3"}
          options={[
            { value: "1", label: t("oed.glazing.1") },
            { value: "2", label: t("oed.glazing.2") },
            { value: "3", label: t("oed.glazing.3") },
          ]}
          onChange={(v) => patchWt({ glazingPanes: Number(v) as 1 | 2 | 3 })}
        />
        <SelField
          label={t("oed.f.insetFace")}
          value={wt.insetFace ?? "aussen"}
          options={[
            { value: "aussen", label: t("oed.insetFace.aussen") },
            { value: "innen", label: t("oed.insetFace.innen") },
          ]}
          onChange={(v) => patchWt({ insetFace: v })}
        />
        <NumField
          label={t("oed.f.insetFromFace")}
          value={wt.insetFromFace ?? 0}
          min={0}
          onCommit={(n) => patchWt({ insetFromFace: n })}
        />
      </>
    );
  }
  return null;
}

function GroessePanel({
  opening,
  isDoor,
  onPatchOpening,
}: {
  opening: Opening;
  isDoor: boolean;
  onPatchOpening: (p: Partial<Opening>) => void;
}) {
  return (
    <>
      <NumField
        label={t("oed.f.width")}
        value={opening.width}
        min={0.1}
        onCommit={(n) => onPatchOpening({ width: n })}
      />
      <NumField
        label={t("oed.f.height")}
        value={opening.height}
        min={0.1}
        onCommit={(n) => onPatchOpening({ height: n })}
      />
      {!isDoor && (
        <NumField
          label={t("oed.f.sillHeight")}
          value={opening.sillHeight}
          min={0}
          onCommit={(n) => onPatchOpening({ sillHeight: n })}
        />
      )}
      <NumField
        label={t("oed.f.position")}
        value={opening.position}
        min={0}
        onCommit={(n) => onPatchOpening({ position: n })}
      />
    </>
  );
}

function RahmenPanel({
  isDoor,
  wt,
  dt,
  patchWt,
  patchDt,
}: {
  isDoor: boolean;
  wt?: WindowType;
  dt?: DoorType;
  patchWt: (p: Partial<WindowType>) => void;
  patchDt: (p: Partial<DoorType>) => void;
}) {
  if (isDoor && dt) {
    return (
      <>
        <NumField
          label={t("oed.f.frameThickness")}
          value={dt.frameThickness}
          min={0}
          onCommit={(n) => patchDt({ frameThickness: n })}
        />
        <NumField
          label={t("oed.f.frameWidth")}
          value={dt.frameWidth ?? 0.06}
          min={0}
          onCommit={(n) => patchDt({ frameWidth: n })}
        />
      </>
    );
  }
  if (wt) {
    return (
      <>
        <NumField
          label={t("oed.f.frameThickness")}
          value={wt.frameThickness}
          min={0}
          onCommit={(n) => patchWt({ frameThickness: n })}
        />
        <NumField
          label={t("oed.f.frameDepth")}
          value={wt.frameDepth ?? 0}
          min={0}
          onCommit={(n) => patchWt({ frameDepth: n || undefined })}
        />
        <NumField
          label={t("oed.f.frameWidth")}
          value={wt.frameWidth ?? 0.06}
          min={0}
          onCommit={(n) => patchWt({ frameWidth: n })}
        />
      </>
    );
  }
  return null;
}

/** Flügeleinteilung: Tabelle mit Flügel/Pfosten, Öffnungsart + Anschlag je Zeile. */
function FluegelPanel({
  wt,
  patchWt,
}: {
  wt: WindowType;
  patchWt: (p: Partial<WindowType>) => void;
}) {
  const sashes = sashesOfWindowType(wt);
  const setSashes = (next: SashDef[]) =>
    patchWt({ sashes: next, wingCount: next.filter((s) => s.kind === "fluegel").length || 1 });
  const update = (i: number, patch: Partial<SashDef>) =>
    setSashes(sashes.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const addSash = (kind: SashDef["kind"]) =>
    setSashes([
      ...sashes,
      kind === "fluegel"
        ? { kind, autoWidth: true, opening: "dreh", hingeSide: "left" }
        : { kind, postWidth: 0.06 },
    ]);
  const remove = (i: number) => setSashes(sashes.filter((_, k) => k !== i));

  return (
    <>
      <div className="oed-hint">{t("oed.fluegel.hint")}</div>
      {/* Oberlicht (festes Feld über einem Kämpfer) + Kämpfer-/Sprossen-Zeilen. */}
      <NumField
        label={t("oed.f.transomHeight")}
        value={wt.transomHeight ?? 0}
        min={0}
        onCommit={(n) => patchWt({ transomHeight: n || undefined })}
      />
      <NumField
        label={t("oed.f.mullionRows")}
        value={wt.mullionRows ?? 1}
        step={1}
        min={1}
        onCommit={(n) => patchWt({ mullionRows: Math.max(1, Math.round(n)) })}
      />
      <NumField
        label={t("oed.f.mullionCols")}
        value={wt.mullionCols ?? 1}
        step={1}
        min={1}
        onCommit={(n) => patchWt({ mullionCols: Math.max(1, Math.round(n)) })}
      />
      <table className="oed-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t("oed.fluegel.col.kind")}</th>
            <th>{t("oed.fluegel.col.opening")}</th>
            <th>{t("oed.fluegel.col.hinge")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sashes.map((s, i) => (
            <tr key={i}>
              <td className="oed-td-num">{i + 1}</td>
              <td>
                <select
                  className="oed-select oed-select-sm"
                  value={s.kind}
                  onChange={(e) =>
                    update(i, { kind: e.target.value as SashDef["kind"] })
                  }
                >
                  <option value="fluegel">{t("oed.fluegel.type.fluegel")}</option>
                  <option value="pfosten">{t("oed.fluegel.type.pfosten")}</option>
                </select>
              </td>
              <td>
                {s.kind === "fluegel" ? (
                  <select
                    className="oed-select oed-select-sm"
                    value={s.opening ?? "dreh"}
                    onChange={(e) =>
                      update(i, { opening: e.target.value as OpeningKind })
                    }
                  >
                    {OPENING_KIND_OPTS().map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="oed-td-dash">–</span>
                )}
              </td>
              <td>
                {s.kind === "fluegel" && s.opening !== "fest" ? (
                  <select
                    className="oed-select oed-select-sm"
                    value={s.hingeSide ?? "left"}
                    onChange={(e) =>
                      update(i, { hingeSide: e.target.value as "left" | "right" })
                    }
                  >
                    <option value="left">{t("oed.hinge.left")}</option>
                    <option value="right">{t("oed.hinge.right")}</option>
                  </select>
                ) : (
                  <span className="oed-td-dash">–</span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="oed-rowbtn"
                  title={t("oed.fluegel.remove")}
                  onClick={() => remove(i)}
                  disabled={sashes.length <= 1}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="oed-rowactions">
        <button type="button" className="oed-btn" onClick={() => addSash("fluegel")}>
          + {t("oed.fluegel.type.fluegel")}
        </button>
        <button type="button" className="oed-btn" onClick={() => addSash("pfosten")}>
          + {t("oed.fluegel.type.pfosten")}
        </button>
      </div>
    </>
  );
}

function SonnenschutzPanel({
  wt,
  patchWt,
}: {
  wt: WindowType;
  patchWt: (p: Partial<WindowType>) => void;
}) {
  const sh = wt.shading;
  const box = sh?.box ?? { width: 0, height: 0.24, depth: 0.2 };
  const set = (patch: Partial<NonNullable<WindowType["shading"]>>) =>
    patchWt({
      shading: {
        create: sh?.create ?? false,
        kind: sh?.kind ?? "rollladen",
        box,
        ...patch,
      },
    });
  return (
    <>
      <label className="oed-check">
        <input
          type="checkbox"
          checked={sh?.create ?? false}
          onChange={(e) => set({ create: e.target.checked })}
        />
        <span>{t("oed.shading.create")}</span>
      </label>
      {sh?.create && (
        <>
          <SelField
            label={t("oed.shading.kind")}
            value={sh.kind}
            options={[
              { value: "rollladen", label: t("oed.shading.rollladen") },
              { value: "raffstore", label: t("oed.shading.raffstore") },
              { value: "markise", label: t("oed.shading.markise") },
            ]}
            onChange={(v) =>
              set({ kind: v as NonNullable<WindowType["shading"]>["kind"] })
            }
          />
          <NumField
            label={t("oed.shading.boxHeight")}
            value={box.height}
            min={0}
            onCommit={(n) => set({ box: { ...box, height: n } })}
          />
          <NumField
            label={t("oed.shading.boxDepth")}
            value={box.depth}
            min={0}
            onCommit={(n) => set({ box: { ...box, depth: n } })}
          />
        </>
      )}
    </>
  );
}

function TuerblattPanel({
  dt,
  patchDt,
}: {
  dt: DoorType;
  patchDt: (p: Partial<DoorType>) => void;
}) {
  return (
    <>
      <SelField
        label={t("oed.door.leafCount")}
        value={String(dt.leafCount) as "1" | "2"}
        options={[
          { value: "1", label: t("oed.door.leaf1") },
          { value: "2", label: t("oed.door.leaf2") },
        ]}
        onChange={(v) => patchDt({ leafCount: Number(v) as 1 | 2 })}
      />
      <SelField
        label={t("oed.door.leafStyle")}
        value={dt.leafStyle}
        options={[
          { value: "glatt", label: t("oed.door.glatt") },
          { value: "kassette", label: t("oed.door.kassette") },
          { value: "glas", label: t("oed.door.glas") },
        ]}
        onChange={(v) => patchDt({ leafStyle: v as DoorType["leafStyle"] })}
      />
    </>
  );
}

// ── Live-Ansicht (Elevation, SVG) ───────────────────────────────────────────

/**
 * Frontal-Ansicht der Öffnung aus den aktuellen Werten: Rahmen, Flügel/Pfosten
 * (mit Öffnungslinien je Flügel), Verglasungshinweis und Rollladenkasten. Rein
 * aus den Modellwerten gezeichnet — kein Renderer-Roundtrip, deterministisch.
 */
function ElevationPreview({
  opening,
  wt,
  dt,
}: {
  opening: Opening;
  wt?: WindowType;
  dt?: DoorType;
}) {
  const geom = useMemo(() => {
    const w = Math.max(0.1, opening.width);
    const h = Math.max(0.1, opening.height);
    const pad = 24;
    const boxH = (!dt && wt?.shading?.create ? wt.shading.box.height : 0) || 0;
    // Zeichenfläche auf ~260×300 skalieren, Seitenverhältnis erhalten.
    const availW = 220;
    const availH = 260;
    const totalH = h + boxH;
    const scale = Math.min(availW / w, availH / totalH);
    const px = (m: number) => m * scale;
    return { w, h, boxH, pad, scale, px, totalH };
  }, [opening.width, opening.height, wt, dt]);

  const { w, h, boxH, pad, px } = geom;
  const svgW = px(w) + pad * 2;
  const svgH = px(h + boxH) + pad * 2;
  const frameW = px((!dt ? wt?.frameWidth : dt?.frameWidth) ?? 0.06);
  const originY = pad + px(boxH);

  // Flügel-/Pfostenaufteilung: gleichmässig (autoWidth) bzw. feste Breiten.
  const sashes = !dt && wt ? sashesOfWindowType(wt) : [];
  const fixedTotal = sashes.reduce(
    (a, s) => a + (s.kind === "pfosten" ? s.postWidth ?? 0.06 : s.autoWidth ? 0 : s.width ?? 0),
    0,
  );
  const autoCount = sashes.filter((s) => s.kind === "fluegel" && (s.autoWidth ?? true)).length;
  const autoW = autoCount > 0 ? Math.max(0.05, (w - fixedTotal) / autoCount) : 0;
  const panes = !dt && wt ? glazingPanesOf(wt) : 1;

  // Segmentbreiten (Meter) je Sash.
  const segW = sashes.map((s) =>
    s.kind === "pfosten"
      ? s.postWidth ?? 0.06
      : s.autoWidth ?? true
      ? autoW
      : s.width ?? autoW,
  );

  const strokeMain = "var(--ink)";
  const strokeMuted = "var(--muted)";
  const glass = "rgba(120,180,220,0.18)";

  let cursor = 0;
  const segEls: JSX.Element[] = [];
  sashes.forEach((s, i) => {
    const x0 = pad + px(cursor);
    const wSeg = px(segW[i]);
    cursor += segW[i];
    if (s.kind === "pfosten") {
      segEls.push(
        <rect
          key={`p${i}`}
          x={x0}
          y={originY}
          width={wSeg}
          height={px(h)}
          fill={strokeMuted}
          opacity={0.5}
        />,
      );
      return;
    }
    // Flügelrahmen + Glas + Öffnungslinien.
    const gx = x0 + frameW * 0.4;
    const gy = originY + frameW * 0.4;
    const gw = Math.max(1, wSeg - frameW * 0.8);
    const gh = Math.max(1, px(h) - frameW * 0.8);
    segEls.push(
      <g key={`f${i}`}>
        <rect x={x0} y={originY} width={wSeg} height={px(h)} fill="none" stroke={strokeMain} />
        <rect x={gx} y={gy} width={gw} height={gh} fill={glass} stroke={strokeMuted} />
        {/* Verglasung: zusätzliche parallele Glaslinien = Scheibenzahl − 1. */}
        {Array.from({ length: Math.max(0, panes - 1) }, (_, k) => (
          <line
            key={k}
            x1={gx + (gw * (k + 1)) / panes}
            y1={gy}
            x2={gx + (gw * (k + 1)) / panes}
            y2={gy + gh}
            stroke={strokeMuted}
            strokeWidth={0.5}
          />
        ))}
        {/* Öffnungslinien (Dreieck) je nach Anschlag; nicht bei fest. */}
        {s.opening !== "fest" &&
          (s.hingeSide === "right" ? (
            <polyline
              points={`${gx + gw},${gy} ${gx},${gy + gh / 2} ${gx + gw},${gy + gh}`}
              fill="none"
              stroke={strokeMuted}
              strokeWidth={0.75}
            />
          ) : (
            <polyline
              points={`${gx},${gy} ${gx + gw},${gy + gh / 2} ${gx},${gy + gh}`}
              fill="none"
              stroke={strokeMuted}
              strokeWidth={0.75}
            />
          ))}
      </g>,
    );
  });

  return (
    <svg
      className="oed-elev"
      viewBox={`0 0 ${svgW} ${svgH}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t("oed.preview")}
    >
      {/* Rollladenkasten über der Öffnung (nur Fenster mit shading.create). */}
      {boxH > 0 && (
        <rect
          x={pad}
          y={pad}
          width={px(w)}
          height={px(boxH)}
          fill="none"
          stroke={strokeMuted}
          strokeDasharray="4 3"
        />
      )}
      {/* Blendrahmen (Aussenkontur). */}
      <rect
        x={pad}
        y={originY}
        width={px(w)}
        height={px(h)}
        fill="none"
        stroke={strokeMain}
        strokeWidth={1.5}
      />
      {/* Für Türen: einfaches Türblatt statt Flügelraster. */}
      {dt ? (
        <>
          <rect
            x={pad + frameW}
            y={originY + frameW}
            width={Math.max(1, px(w) - frameW * 2)}
            height={Math.max(1, px(h) - frameW)}
            fill={dt.leafStyle === "glas" ? glass : "none"}
            stroke={strokeMuted}
          />
          {dt.leafCount === 2 && (
            <line
              x1={pad + px(w) / 2}
              y1={originY + frameW}
              x2={pad + px(w) / 2}
              y2={originY + px(h)}
              stroke={strokeMuted}
            />
          )}
        </>
      ) : (
        <>
          {segEls}
          {/* Oberlicht-Kämpfer (waagrechte Linie transomHeight unter der OK). */}
          {!dt && wt && (wt.transomHeight ?? 0) > 0 && (
            <line
              x1={pad}
              y1={originY + px(wt.transomHeight ?? 0)}
              x2={pad + px(w)}
              y2={originY + px(wt.transomHeight ?? 0)}
              stroke={strokeMain}
            />
          )}
          {/* Kämpfer-/Sprossen-Zeilen (mullionRows − 1 waagrechte Teiler im
              Hauptfeld unterhalb eines etwaigen Oberlichts). */}
          {!dt &&
            wt &&
            (() => {
              const rows = Math.max(1, Math.round(wt.mullionRows ?? 1));
              if (rows <= 1) return null;
              const top = originY + px(wt.transomHeight ?? 0);
              const fieldH = px(h) - px(wt.transomHeight ?? 0);
              return Array.from({ length: rows - 1 }, (_, k) => (
                <line
                  key={k}
                  x1={pad}
                  y1={top + (fieldH * (k + 1)) / rows}
                  x2={pad + px(w)}
                  y2={top + (fieldH * (k + 1)) / rows}
                  stroke={strokeMuted}
                  strokeWidth={0.75}
                />
              ));
            })()}
          {/* Sprossen-Spalten (mullionCols − 1 vertikale Teiler im
              Hauptfeld unterhalb eines etwaigen Oberlichts). */}
          {!dt &&
            wt &&
            (() => {
              const cols = Math.max(1, Math.round(wt.mullionCols ?? 1));
              if (cols <= 1) return null;
              const top = originY + px(wt.transomHeight ?? 0);
              const fieldH = px(h) - px(wt.transomHeight ?? 0);
              const fieldW = px(w);
              return Array.from({ length: cols - 1 }, (_, k) => (
                <line
                  key={k}
                  x1={pad + (fieldW * (k + 1)) / cols}
                  y1={top}
                  x2={pad + (fieldW * (k + 1)) / cols}
                  y2={top + fieldH}
                  stroke={strokeMuted}
                  strokeWidth={0.75}
                />
              ));
            })()}
        </>
      )}
    </svg>
  );
}
