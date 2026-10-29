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

import { useEffect, useState } from "react";
import { t } from "../i18n";
import type {
  DoorType,
  FrameDetail,
  LayerReveal,
  FrameCornerJoin,
  Opening,
  OpeningKind,
  Project,
  SashDef,
  WindowType,
} from "../model/types";
import { getDoorType, getWindowType, sashesOfWindowType, glazingPanesOf } from "../model/types";
import { CorePreview, DoorFramePanel, FrameDetailPanel, RebatePanel, RevealPanel, ScopeSwitch } from "./OpeningDetailPanels";

/** P0-Kategorien der Sidebar, je nach Öffnungsart. */
type CatId =
  | "basis"
  | "groesse"
  | "rahmen"
  | "fluegel"
  | "sonnenschutz"
  | "tuerblatt"
  | "rahmendetail"
  | "anschlag"
  | "zarge"
  | "schichten";

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
        { id: "zarge", label: t("oed.cat.zarge") },
        { id: "rahmendetail", label: t("oed.cat.rahmendetail") },
        { id: "anschlag", label: t("oed.cat.anschlag") },
        { id: "schichten", label: t("oed.cat.schichten") },
        { id: "tuerblatt", label: t("oed.cat.tuerblatt") },
      ]
    : [
        { id: "basis", label: t("oed.cat.basis") },
        { id: "groesse", label: t("oed.cat.groesse") },
        { id: "rahmen", label: t("oed.cat.rahmen") },
        { id: "rahmendetail", label: t("oed.cat.rahmendetail") },
        { id: "anschlag", label: t("oed.cat.anschlag") },
        { id: "schichten", label: t("oed.cat.schichten") },
        { id: "fluegel", label: t("oed.cat.fluegel") },
        { id: "sonnenschutz", label: t("oed.cat.sonnenschutz") },
      ];
  const [cat, setCat] = useState<CatId>("basis");
  // [102]/[103]: Detail-Panels wirken auf den Typ (alle Öffnungen) oder nur auf diese Öffnung.
  const [scope, setScope] = useState<"type" | "opening">(opening?.frameDetail || opening?.layerReveals || opening?.doorFrame || opening?.doorFrameKind ? "opening" : "type");

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
  const ty = isDoor ? dt : wt;
  const onType = scope === "type" && !!ty;
  // Werte des gewählten Geltungsbereichs; „nur diese Öffnung" zeigt die Übersteuerung (leer = wie Typ).
  const frameDetail = onType ? ty?.frameDetail : opening.frameDetail;
  const setFrameDetail = (v: FrameDetail | undefined) => (onType ? (isDoor ? patchDt({ frameDetail: v }) : patchWt({ frameDetail: v })) : onPatchOpening({ frameDetail: v }));
  const typeReveals = isDoor ? dt?.layerReveals : wt?.layerReveals ?? (wt?.innerLayerRecess ? [{ layer: -1, mode: "zurueck" as const }] : undefined);
  const reveals = onType ? typeReveals : opening.layerReveals ?? typeReveals;
  const setReveals = (v: LayerReveal[] | undefined) =>
    onType ? (isDoor ? patchDt({ layerReveals: v }) : patchWt({ layerReveals: v, innerLayerRecess: undefined })) : onPatchOpening({ layerReveals: v });
  const overridden = !!(opening.frameDetail || opening.layerReveals || opening.doorFrame || opening.doorFrameKind);
  const scopeBar = (
    <ScopeSwitch
      scope={onType ? "type" : "opening"}
      onScope={setScope}
      overridden={overridden}
      onReset={() => onPatchOpening({ frameDetail: undefined, layerReveals: undefined, doorFrame: undefined, doorFrameKind: undefined })}
    />
  );

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
            {(cat === "rahmendetail" || cat === "anschlag" || cat === "zarge" || cat === "schichten") && scopeBar}
            {cat === "rahmendetail" && <FrameDetailPanel value={frameDetail} onChange={setFrameDetail} isDoor={isDoor} />}
            {cat === "anschlag" && <RebatePanel value={frameDetail} onChange={setFrameDetail} isDoor={isDoor} />}
            {cat === "zarge" && isDoor && (
              <DoorFramePanel
                kind={onType ? dt?.frameKind : opening.doorFrameKind}
                onKind={(k) => (onType ? patchDt({ frameKind: k }) : onPatchOpening({ doorFrameKind: k }))}
                value={onType ? dt?.doorFrame : opening.doorFrame}
                onChange={(v) => (onType ? patchDt({ doorFrame: v }) : onPatchOpening({ doorFrame: v }))}
              />
            )}
            {cat === "schichten" && <RevealPanel project={project} opening={opening} value={reveals} onChange={setReveals} />}
          </div>

          {/* 3. Live-Ansicht aus dem Kern: Grundriss, Schnitt, Ansicht. */}
          <div className="oed-preview">
            <div className="oed-preview-title">{t("oed.preview")}</div>
            <CorePreview project={project} openingId={opening.id} />
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
  { value: "hebeschiebe", label: t("oed.door.hebeschiebe") },
  { value: "pendel", label: t("oed.door.pendel") },
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
            { value: "mitte", label: t("oed.insetFace.mitte") },
          ]}
          onChange={(v) => patchWt({ insetFace: v })}
        />
        <NumField
          label={t("oed.f.insetFromFace")}
          value={wt.insetFromFace ?? 0}
          min={0}
          onCommit={(n) => patchWt({ insetFromFace: n })}
        />
        <SelField
          label={t("oed.f.sillLineFaces")}
          value={wt.sillLine?.faces ?? "off"}
          options={[
            { value: "off", label: t("oed.sillLine.off") },
            { value: "aussen", label: t("oed.insetFace.aussen") },
            { value: "innen", label: t("oed.insetFace.innen") },
            { value: "beide", label: t("oed.sillLine.beide") },
          ]}
          onChange={(v) =>
            patchWt({
              sillLine:
                v === "off"
                  ? undefined
                  : { faces: v as "aussen" | "innen" | "beide", view: wt.sillLine?.view ?? "auf" },
            })
          }
        />
        {wt.sillLine && (
          <SelField
            label={t("oed.f.sillLineView")}
            value={wt.sillLine.view}
            options={[
              { value: "auf", label: t("oed.sillLine.auf") },
              { value: "unter", label: t("oed.sillLine.unter") },
            ]}
            onChange={(v) => patchWt({ sillLine: { faces: wt.sillLine!.faces, view: v } })}
          />
        )}
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
        <SelField<FrameCornerJoin>
          label={t("oed.f.cornerJoin")}
          value={dt.frameCornerJoin ?? "vertikal"}
          options={cornerJoinOptions()}
          onChange={(v) => patchDt({ frameCornerJoin: v })}
        />
        <SelField
          label={t("oed.f.insetFace")}
          value={dt.insetFace ?? "aussen"}
          options={[
            { value: "aussen", label: t("oed.insetFace.aussen") },
            { value: "innen", label: t("oed.insetFace.innen") },
            { value: "mitte", label: t("oed.insetFace.mitte") },
          ]}
          onChange={(v) => patchDt({ insetFace: v })}
        />
        <NumField
          label={t("oed.f.insetFromFace")}
          value={dt.insetFromFace ?? 0}
          min={0}
          onCommit={(n) => patchDt({ insetFromFace: n })}
        />
        <NumField
          label={t("oed.f.rebateDepth")}
          value={dt.rebateDepth ?? 0}
          min={0}
          onCommit={(n) => patchDt({ rebateDepth: n || undefined })}
        />
        <NumField
          label={t("oed.f.lintelHeight")}
          value={dt.lintelHeight ?? 0}
          min={0}
          onCommit={(n) => patchDt({ lintelHeight: n || undefined })}
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
        <SelField<FrameCornerJoin>
          label={t("oed.f.cornerJoin")}
          value={wt.frameCornerJoin ?? "vertikal"}
          options={cornerJoinOptions()}
          onChange={(v) => patchWt({ frameCornerJoin: v })}
        />
        <NumField
          label={t("oed.f.rebateDepth")}
          value={wt.rebateDepth ?? 0}
          min={0}
          onCommit={(n) => patchWt({ rebateDepth: n || undefined })}
        />
        <NumField
          label={t("oed.f.lintelHeight")}
          value={wt.lintelHeight ?? 0}
          min={0}
          onCommit={(n) => patchWt({ lintelHeight: n || undefined })}
        />
        <SelField
          label={t("oed.f.sillBoard")}
          value={wt.sillBoard ?? "aussen"}
          options={[
            { value: "keine", label: t("resources.sillBoard.keine") },
            { value: "aussen", label: t("resources.sillBoard.aussen") },
            { value: "innen", label: t("resources.sillBoard.innen") },
            { value: "beide", label: t("resources.sillBoard.beide") },
          ]}
          onChange={(v) => patchWt({ sillBoard: v })}
        />
      </>
    );
  }
  return null;
}

/** Auswahl der Rahmen-Eckverbindung (s. `WindowType.frameCornerJoin`). */
function cornerJoinOptions(): { value: FrameCornerJoin; label: string }[] {
  return [
    { value: "vertikal", label: t("oed.cornerJoin.vertikal") },
    { value: "horizontal", label: t("oed.cornerJoin.horizontal") },
    { value: "gehrung", label: t("oed.cornerJoin.gehrung") },
  ];
}

/** Oberlicht-Einteilung ([95]): Anzahl Felder und Öffnungsart des ersten Felds. */
function transomFields(wt: WindowType): { count: number; opening: OpeningKind } {
  const fields = (wt.transomSashes ?? []).filter((s) => s.kind === "fluegel");
  return { count: Math.max(1, fields.length), opening: fields[0]?.opening ?? "fest" };
}

/** Gleichmässige Oberlicht-Einteilung: `count` Felder, dazwischen Pfosten; ein festes Feld = keine Liste. */
function transomSashes(count: number, opening: OpeningKind): SashDef[] | undefined {
  if (count <= 1 && opening === "fest") return undefined;
  const out: SashDef[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) out.push({ kind: "pfosten", postWidth: 0.06 });
    out.push({ kind: "fluegel", autoWidth: true, opening, hingeSide: i % 2 === 0 ? "left" : "right" });
  }
  return out;
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
      {(wt.transomHeight ?? 0) > 0 && (
        <>
          <NumField
            label={t("oed.f.transomFields")}
            value={transomFields(wt).count}
            step={1}
            min={1}
            onCommit={(n) => patchWt({ transomSashes: transomSashes(Math.max(1, Math.min(6, Math.round(n))), transomFields(wt).opening) })}
          />
          <SelField<OpeningKind>
            label={t("oed.f.transomOpening")}
            value={transomFields(wt).opening}
            options={[
              { value: "fest", label: t("oed.kind.fest") },
              { value: "kipp", label: t("oed.kind.kipp") },
              { value: "dreh", label: t("oed.kind.dreh") },
            ]}
            onChange={(v) => patchWt({ transomSashes: transomSashes(transomFields(wt).count, v) })}
          />
        </>
      )}
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
          <SelField
            label={t("oed.shading.mount")}
            value={sh.mount ?? "vorgesetzt"}
            options={[
              { value: "vorgesetzt", label: t("oed.shading.vorgesetzt") },
              { value: "sturz", label: t("oed.shading.sturz") },
            ]}
            onChange={(v) => set({ mount: v })}
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
