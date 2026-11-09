// Abschnitt „Baum" der Objekt-Info ([165] aus `ObjectInfoPanel.tsx`) samt den Auswahllisten für Form, Status
// und Laub. Gerufen von `ObjectInfoPanel`.

import type { TreeShape, TreeStatus, TreeFoliage, Tree } from "../../model/types";
import { usePanelHost } from "../host";
import { useStore } from "../../state/appStore";
import { t } from "../../i18n";
import { patchItem } from "../../core";
import { Dropdown } from "../../ui/Dropdown";
import type { TranslationKey } from "../../i18n";
import { DimensionField } from "./fields";

// ── Editierbares Maßfeld ─────────────────────────────────────────────────────
// Kontrolliert über den vom Host gelieferten Wert, hält aber während des
// Tippens einen lokalen Entwurf. Commit auf blur/Enter; Escape verwirft.
// Nach erfolgreichem Resize liefert der Host eine neue bbox → neuer `value` →
// das Feld zeigt automatisch die aktualisierte Größe. `min` erlaubt negative
// Werte (z. B. absolute Z-Höhen unter 0).
// ── Baum ([149]) ─────────────────────────────────────────────────────────────
// Lage (Stammmitte), Masse, Form, Bestand, Laub/Nadel und Art des ersten gewählten Baums; jede Änderung
// ein Undo-Schritt (Kern prüft die Op). Bei mehreren gewählten Bäumen wirken Form/Bestand/Laub auf alle.
const TREE_SHAPES: TreeShape[] = ["round", "oval", "columnar", "conical"];

const TREE_STATUS: TreeStatus[] = ["existing", "new", "remove"];

const TREE_FOLIAGE: TreeFoliage[] = ["deciduous", "conifer"];


export function TreeSection({ ids }: { ids: readonly string[] }) {
  const host = usePanelHost();
  const applyChange = useStore((s) => s.applyChange);
  const trees = (host.project.trees ?? []).filter((x) => ids.includes(x.id));
  const tree = trees[0];
  if (!tree) return <div className="objinfo-panel"><div className="objinfo-empty">{t("objinfo.empty")}</div></div>;
  const locked = !!tree.locked;
  const set = (patch: Partial<Tree>, all = false) =>
    applyChange((p) => (all ? trees : [tree]).filter((x) => !x.locked).flatMap((x) => patchItem(p, "trees", x.id, patch)));
  const level = host.project.drawingLevels.find((l) => l.id === tree.floorId);
  return (
    <div className="objinfo-panel objinfo-tree">
      <div className="objinfo-head">
        <span className="objinfo-kind">{trees.length > 1 ? t("objinfo.tree.many", { n: trees.length }) : t("objinfo.kind.tree")}</span>
      </div>
      <div className="objinfo-section-label">{t("objinfo.tree.section")}</div>
      <label className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.tree.species")}</span>
        <input
          className="objinfo-text"
          type="text"
          defaultValue={tree.species ?? ""}
          key={`sp-${tree.id}-${tree.species ?? ""}`}
          disabled={locked}
          placeholder={t("objinfo.tree.speciesHint")}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (tree.species ?? "")) set({ species: v || undefined });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.tree.showLabel")}</span>
        <input
          type="checkbox"
          checked={tree.showLabel === true}
          disabled={locked}
          onChange={(e) => set({ showLabel: e.target.checked }, true)}
          title={t("objinfo.tree.showLabelHint")}
          data-testid="tree-show-label"
        />
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.tree.status")}</span>
        <Dropdown
          value={tree.status}
          onChange={(v) => set({ status: v as TreeStatus }, true)}
          options={TREE_STATUS.map((v) => ({ value: v, label: t(`objinfo.tree.status.${v}` as TranslationKey) }))}
          title={t("objinfo.tree.status")}
          width={130}
        />
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.tree.shape")}</span>
        <Dropdown
          value={tree.shape}
          onChange={(v) => set({ shape: v as TreeShape }, true)}
          options={TREE_SHAPES.map((v) => ({ value: v, label: t(`objinfo.tree.shape.${v}` as TranslationKey) }))}
          title={t("objinfo.tree.shape")}
          width={130}
        />
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.tree.foliage")}</span>
        <Dropdown
          value={tree.foliage}
          onChange={(v) => set({ foliage: v as TreeFoliage }, true)}
          options={TREE_FOLIAGE.map((v) => ({ value: v, label: t(`objinfo.tree.foliage.${v}` as TranslationKey) }))}
          title={t("objinfo.tree.foliage")}
          width={130}
        />
      </div>
      <DimensionField label={t("objinfo.tree.height")} value={tree.height} min={0.5} onCommit={(v) => set({ height: v, crownBase: Math.min(tree.crownBase, 0.9 * v) })} />
      <DimensionField label={t("objinfo.tree.crownDiameter")} value={tree.crownDiameter} min={0.2} onCommit={(v) => set({ crownDiameter: v })} />
      <DimensionField label={t("objinfo.tree.crownBase")} value={tree.crownBase} onCommit={(v) => set({ crownBase: Math.min(v, 0.9 * tree.height) })} />
      <DimensionField label={t("objinfo.tree.trunkDiameter")} value={tree.trunkDiameter} min={0.02} onCommit={(v) => set({ trunkDiameter: v })} />
      <DimensionField label="X" value={tree.position.x} min={-Infinity} onCommit={(v) => set({ position: { x: v, y: tree.position.y } })} />
      <DimensionField label="Y" value={tree.position.y} min={-Infinity} onCommit={(v) => set({ position: { x: tree.position.x, y: v } })} />
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.floor")}</span>
        <span className="objinfo-fval">{level?.name ?? tree.floorId}</span>
      </div>
      {locked && <div className="objinfo-muted">{t("objinfo.tree.locked")}</div>}
    </div>
  );
}
