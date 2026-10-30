// Tab „Schraffuren" (Hatches) — Muster/Maßstab/Winkel/Farbe + Linienstil,
// wahlweise Vektor-Muster oder Bild-Textur. Master-Detail-Layout wie die
// übrigen Ressourcen-Tabs (siehe {@link HatchDetail}).

import { useState } from "react";
import type { HatchPattern, HatchStyle, LineStyle, Project } from "../../model/types";
import { parsePat } from "../../io/patParser";
import { HatchSwatch } from "../hatchPreview";
import { MotifEditor } from "../MotifEditor";
import { t } from "../../i18n";
import {
  ColorField,
  DeleteButton,
  FieldRow,
  FileImportButton,
  ImagePickButton,
  NumberField,
  Segmented,
  SelectField,
} from "./fields";

/** Schraffur-Muster mit i18n-Key für die Beschriftung. */
const PATTERN_OPTIONS: { value: HatchPattern; labelKey: string }[] = [
  { value: "none", labelKey: "pattern.none" },
  { value: "solid", labelKey: "pattern.solid" },
  { value: "insulation", labelKey: "pattern.insulation" },
  { value: "diagonal", labelKey: "pattern.diagonal" },
  { value: "crosshatch", labelKey: "pattern.crosshatch" },
  { value: "custom", labelKey: "pattern.custom" },
];

/**
 * Default-Motiv beim Umschalten auf „Custom": dieselbe Dreieckszelle wie beim
 * Linien-Custom-Motiv (`LinesTab.tsx`) — konsistenter Startpunkt, der Nutzer
 * passt sie im MotifEditor an.
 */
const DEFAULT_MOTIF: NonNullable<HatchStyle["motif"]> = {
  points: [
    { x: 0, y: 0 },
    { x: 1, y: 1.5 },
    { x: 2, y: 0 },
    { x: 3, y: -1.5 },
    { x: 4, y: 0 },
  ],
  length: 4,
};

/** Detail-Panel EINER Schraffur (rechte Seite des Master-Detail-Layouts). */
function HatchDetail({
  hatch,
  lineStyles,
  onPatch,
  onDelete,
}: {
  hatch: HatchStyle;
  lineStyles: LineStyle[];
  onPatch: (patch: Partial<HatchStyle>) => void;
  onDelete: () => void;
}) {
  const NONE = "__none__";
  const lineOptions = [
    { value: NONE, label: t("resources.lineStyle.none") },
    ...lineStyles.map((l) => ({ value: l.id, label: l.name })),
  ];
  const kind = hatch.kind ?? "vector";
  const lines = hatch.lines ?? "parallel";

  /**
   * Wechselt den Typ; beim ERSTEN Umschalten auf „Bild"/„Verlauf" Default-
   * Parameter setzen (danach bleiben eigene Werte beim Hin- und Herschalten
   * erhalten, wie bei „Custom"-Motiven).
   */
  const setKind = (k: "vector" | "image" | "gradient") => {
    if (k === "image" && !hatch.image) {
      onPatch({ kind: k, image: { src: "", scaleX: 1, scaleY: 1, rotation: 0 } });
    } else if (k === "gradient" && !hatch.gradient) {
      onPatch({ kind: k, gradient: { color1: "#d9d9d9", color2: "#8c8c8c", angle: 0, type: "linear" } });
    } else {
      onPatch({ kind: k });
    }
  };

  /** Merge-Patch für die Verlauf-Parameter (behält bestehende Werte). */
  const patchGradient = (part: Partial<NonNullable<HatchStyle["gradient"]>>) => {
    const cur = hatch.gradient ?? { color1: "#d9d9d9", color2: "#8c8c8c", angle: 0, type: "linear" as const };
    onPatch({ gradient: { ...cur, ...part } });
  };

  /** Wechselt das Muster; beim erstmaligen Umschalten auf „Custom" ein Default-Motiv setzen. */
  const setPattern = (pattern: HatchPattern) => {
    if (pattern === "custom" && !hatch.motif) {
      onPatch({ pattern, motif: DEFAULT_MOTIF });
    } else {
      onPatch({ pattern });
    }
  };

  /** Merge-Patch für die Bild-Parameter (behält bestehende Werte). */
  const patchImage = (part: Partial<NonNullable<HatchStyle["image"]>>) => {
    const cur = hatch.image ?? { src: "", scaleX: 1, scaleY: 1, rotation: 0 };
    onPatch({ image: { ...cur, ...part } });
  };

  /** Datei → Data-URL (readAsDataURL) → image.src. */
  const loadImage = (file: File | null) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => patchImage({ src: String(r.result ?? "") });
    r.readAsDataURL(file);
  };

  // ── Random-Vektor-Schraffur (Kies/Splitt) ───────────────────────────────────
  // Dichte + Längenspanne + „Neu würfeln". Der Seed wird beim Klick gesetzt (KEIN
  // Math.random() zur Renderzeit — die Streuung selbst ist deterministisch per
  // Seed). Länge min/max in mm; bis der Nutzer sie berührt, bleibt der Default.
  const lenMin = hatch.lengthMin ?? 1;
  const lenMax = hatch.lengthMax ?? 3;
  const reroll = () => onPatch({ seed: Math.floor(Math.random() * 0x7fffffff) });

  return (
    <div className="res-md-detail-inner">
      <div className="res-md-head">
        <input
          className="res-input res-md-rename"
          value={hatch.name}
          placeholder={t("resources.hatches.placeholder")}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <DeleteButton
          onClick={onDelete}
          title={t("resources.delete.hatch", { name: hatch.name })}
        />
      </div>

      <div className="res-md-preview">
        <HatchSwatch hatch={hatch} size={128} />
      </div>

      <div className="res-fields">
        <FieldRow label={t("resources.field.type")}>
          <Segmented
            value={kind}
            onChange={setKind}
            options={[
              { value: "vector", label: t("resources.hatchKind.vector") },
              { value: "image", label: t("resources.hatchKind.image") },
              { value: "gradient", label: t("resources.hatchKind.gradient") },
            ]}
          />
        </FieldRow>

        {kind === "vector" ? (
          <>
            <FieldRow label={t("resources.field.lines")}>
              <Segmented
                value={lines}
                onChange={(v) => onPatch({ lines: v })}
                options={[
                  { value: "parallel", label: t("resources.lines.parallel") },
                  { value: "random", label: t("resources.lines.random") },
                ]}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.pattern")}>
              <SelectField
                value={hatch.pattern}
                onChange={setPattern}
                options={PATTERN_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.labelKey),
                }))}
              />
            </FieldRow>
            {hatch.pattern === "custom" && (
              <FieldRow label={t("resources.field.motif")}>
                <MotifEditor
                  points={hatch.motif?.points ?? DEFAULT_MOTIF.points}
                  length={hatch.motif?.length ?? DEFAULT_MOTIF.length}
                  onChange={(points, length) => onPatch({ motif: { points, length } })}
                />
              </FieldRow>
            )}
            <FieldRow label={t("resources.col.scale")}>
              <NumberField
                value={hatch.scale}
                onChange={(scale) => onPatch({ scale })}
                step={0.1}
                min={0.01}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.angle")}>
              <NumberField
                value={hatch.angle}
                onChange={(angle) => onPatch({ angle })}
                step={5}
              />
            </FieldRow>
            <FieldRow
              label={t("resources.col.relativeToWall")}
              hint={t("resources.col.relativeToWall.hint")}
            >
              <input
                type="checkbox"
                checked={!!hatch.relativeToWall}
                onChange={(e) => onPatch({ relativeToWall: e.target.checked })}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.lineStyle")}>
              <SelectField
                value={hatch.lineStyleId ?? NONE}
                onChange={(v) => onPatch({ lineStyleId: v === NONE ? undefined : v })}
                options={lineOptions}
              />
            </FieldRow>
            <FieldRow label={t("resources.col.hatchLineWeight")} hint={t("resources.col.hatchLineWeight.hint")}>
              <NumberField
                value={hatch.lineWeight ?? 0.13}
                onChange={(w) => onPatch({ lineWeight: Math.max(0.01, w) })}
                step={0.01}
                min={0.01}
              />
            </FieldRow>
            {lines === "random" && (
              <>
                <FieldRow label={t("resources.field.density")}>
                  <NumberField
                    value={hatch.density ?? 1}
                    onChange={(density) => onPatch({ density })}
                    step={0.1}
                    min={0.1}
                  />
                </FieldRow>
                <FieldRow label={t("resources.field.lengthMin")}>
                  <NumberField
                    value={lenMin}
                    onChange={(v) => onPatch({ lengthMin: v, lengthMax: hatch.lengthMax ?? lenMax })}
                    step={0.5}
                    min={0}
                  />
                </FieldRow>
                <FieldRow label={t("resources.field.lengthMax")}>
                  <NumberField
                    value={lenMax}
                    onChange={(v) => onPatch({ lengthMax: v, lengthMin: hatch.lengthMin ?? lenMin })}
                    step={0.5}
                    min={0}
                  />
                </FieldRow>
                <FieldRow label={t("resources.random.reroll")}>
                  <button type="button" className="res-seg-btn" onClick={reroll}>
                    {t("resources.random.reroll")}
                  </button>
                </FieldRow>
              </>
            )}
          </>
        ) : kind === "image" ? (
          <>
            <FieldRow label={t("resources.field.image")}>
              <ImagePickButton onFile={loadImage} />
            </FieldRow>
            <FieldRow label={t("resources.field.scaleX")}>
              <NumberField
                value={hatch.image?.scaleX ?? 1}
                onChange={(scaleX) => patchImage({ scaleX })}
                step={0.1}
                min={0.05}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.scaleY")}>
              <NumberField
                value={hatch.image?.scaleY ?? 1}
                onChange={(scaleY) => patchImage({ scaleY })}
                step={0.1}
                min={0.05}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.rotation")}>
              <NumberField
                value={hatch.image?.rotation ?? 0}
                onChange={(rotation) => patchImage({ rotation })}
                step={5}
              />
            </FieldRow>
          </>
        ) : (
          <>
            <FieldRow label={t("resources.field.gradientType")}>
              <Segmented
                value={hatch.gradient?.type ?? "linear"}
                onChange={(v) => patchGradient({ type: v })}
                options={[
                  { value: "linear", label: t("resources.gradientType.linear") },
                  { value: "radial", label: t("resources.gradientType.radial") },
                ]}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.gradientColor1")}>
              <ColorField
                color={hatch.gradient?.color1 ?? "#d9d9d9"}
                onChange={(color1) => patchGradient({ color1 })}
              />
            </FieldRow>
            <FieldRow label={t("resources.field.gradientColor2")}>
              <ColorField
                color={hatch.gradient?.color2 ?? "#8c8c8c"}
                onChange={(color2) => patchGradient({ color2 })}
              />
            </FieldRow>
            {(hatch.gradient?.type ?? "linear") === "linear" && (
              <FieldRow label={t("resources.col.angle")}>
                <NumberField
                  value={hatch.gradient?.angle ?? 0}
                  onChange={(angle) => patchGradient({ angle })}
                  step={5}
                />
              </FieldRow>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * .pat-Text → id-lose Schraffuren. Unser Modell kennt nur feste Muster; daher
 * approximieren wir: ≥2 Linienfamilien → Kreuzschraffur, sonst Diagonal, mit dem
 * Winkel der ersten Familie. (Vollwertiges custom-Pattern später.)
 */
function patToHatches(text: string): Omit<HatchStyle, "id">[] {
  return parsePat(text).map((p) => ({
    name: p.name,
    pattern: (p.families.length >= 2 ? "crosshatch" : "diagonal") as HatchPattern,
    scale: 1,
    angle: p.families[0]?.angle ?? 45,
    color: "#1a1a1a",
    // Volllinie (Muster); die Stärke trägt die Schraffur ([110]).
    lineWeight: 0.13,
  }));
}

export function HatchesTab({
  project,
  onPatchHatch,
  onAddHatch,
  onDeleteHatch,
  onImportHatches,
}: {
  project: Project;
  onPatchHatch: (id: string, patch: Partial<HatchStyle>) => void;
  onAddHatch: () => void;
  onDeleteHatch: (id: string) => void;
  onImportHatches: (hatches: Omit<HatchStyle, "id">[]) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hatches = project.hatches;
  // Auswahl gegen die Liste validieren (nach Delete/Add stabil bleiben).
  const selected = hatches.find((h) => h.id === selectedId) ?? hatches[0];

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.hatches.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {hatches.map((h) => (
            <button
              key={h.id}
              className={`res-md-row${selected?.id === h.id ? " active" : ""}`}
              onClick={() => setSelectedId(h.id)}
            >
              <span className="res-md-row-thumb">
                <HatchSwatch hatch={h} size={30} />
              </span>
              <span className="res-md-row-name">{h.name}</span>
            </button>
          ))}
          {hatches.length === 0 && (
            <div className="res-md-empty">{t("resources.hatches.empty")}</div>
          )}
          <div className="res-md-listfoot">
            <button className="res-add" onClick={() => onAddHatch()}>
              <span className="res-add-plus">+</span> {t("resources.add")}
            </button>
            <FileImportButton
              accept=".pat,text/plain"
              label={t("resources.import.pat")}
              onText={(text) => onImportHatches(patToHatches(text))}
            />
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <HatchDetail
              key={selected.id}
              hatch={selected}
              lineStyles={project.lineStyles}
              onPatch={(patch) => onPatchHatch(selected.id, patch)}
              onDelete={() => onDeleteHatch(selected.id)}
            />
          ) : (
            <div className="res-md-empty">{t("resources.hatches.empty")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
