// Tab „Materialien" (PBR-Bibliothek durchsuchen) — Eigenständiger Tab, der die
// eingebaute Materialbibliothek (MATERIAL_LIBRARY) als Kachel-Grid mit
// gerenderter PBR-Kugel-Vorschau zeigt — Name/Kategorie als Badge, Suche +
// Kategorie-Chips kombinierbar. Die Zuweisung an ein konkretes Bauteil bleibt
// der bestehende Weg (Spalte „Material" der Bauteil-Tabelle → MaterialPicker
// in {@link ComponentsTab}); dieser Tab dient dem Durchsuchen/Vergleichen der
// Bibliothek, Klick auf eine Kachel markiert sie (aktiv, wie `mat-tile.active`
// im Picker) und zeigt Name/Kategorie in der Statuszeile.

import { useEffect, useRef, useState } from "react";
import { MATERIAL_LIBRARY } from "../../materials/library";
import type { MaterialAsset } from "../../materials/library";
import { requestMaterialPreview, cancelMaterialPreview } from "../../materials/spherePreview";
import { t } from "../../i18n";
import { EmptyState } from "./fields";

/**
 * Alle in der Bibliothek vorkommenden Kategorien, alphabetisch. Das Manifest
 * schreibt Kategorien uneinheitlich („PavingStones" neben „Paving Stones") —
 * für Chips und Filter zählt der normalisierte Schlüssel (ohne Leerzeichen,
 * case-insensitiv); angezeigt wird die zuerst gesehene Schreibweise.
 */
const categoryKey = (c: string) => c.replace(/\s+/g, "").toLowerCase();
const MATERIAL_CATEGORIES: string[] = (() => {
  const byKey = new Map<string, string>();
  for (const a of MATERIAL_LIBRARY) {
    const k = categoryKey(a.category);
    if (!byKey.has(k)) byKey.set(k, a.category);
  }
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
})();

/**
 * Eine Bibliotheks-Kachel: rendert erst eine PBR-Kugel-Vorschau, sobald sie
 * tatsächlich sichtbar ist (IntersectionObserver) — bei ~90 Materialien sonst
 * unnötige GPU-Arbeit für Kacheln außerhalb des Sichtfensters. Der eigentliche
 * Render läuft ohnehin seriell über einen einzigen geteilten WebGL-Kontext
 * (spherePreview.ts), die Sichtbarkeitsprüfung drosselt zusätzlich die
 * Warteschlange auf das gerade Interessante.
 */
function MaterialLibraryTile({
  asset,
  active,
  onSelect,
}: {
  asset: MaterialAsset;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handleReady = (url: string) => setPreviewUrl(url);
    const cached = requestMaterialPreview(asset, handleReady);
    if (cached) setPreviewUrl(cached);
    return () => cancelMaterialPreview(asset, handleReady);
  }, [visible, asset]);

  return (
    <button
      ref={ref}
      className={`mat-tile${active ? " active" : ""}`}
      title={`${asset.name} — ${asset.category}`}
      onClick={onSelect}
    >
      <span className="mat-sphere">
        {previewUrl && <img src={previewUrl} alt="" draggable={false} />}
      </span>
      <span className="mat-tile-name">{asset.name}</span>
      <span className="mat-tile-badge">{asset.category}</span>
    </button>
  );
}

export function MaterialsTab() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = MATERIAL_LIBRARY.filter((asset) => {
    if (category && categoryKey(asset.category) !== categoryKey(category)) return false;
    const q = query.trim().toLowerCase();
    if (q && !asset.name.toLowerCase().includes(q) && !asset.id.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
  const selected = MATERIAL_LIBRARY.find((a) => a.id === selectedId);

  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.materials.hint")}</div>

      <div className="mat-lib-filterbar">
        <input
          type="text"
          className="res-input mat-search"
          value={query}
          placeholder={t("resources.materials.searchPlaceholder")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div
          className="mat-lib-chips"
          role="group"
          aria-label={t("resources.materials.categoryLabel")}
        >
          <button
            className={`mat-chip${category === null ? " active" : ""}`}
            onClick={() => setCategory(null)}
          >
            {t("resources.materials.categoryAll")}
          </button>
          {MATERIAL_CATEGORIES.map((c) => (
            <button
              key={c}
              className={`mat-chip${category === c ? " active" : ""}`}
              onClick={() => setCategory((cur) => (cur === c ? null : c))}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div className="mat-lib-selected">
          {t("resources.materials.selected", {
            name: selected.name,
            category: selected.category,
          })}
        </div>
      )}

      <div className="mat-grid mat-lib-grid">
        {filtered.map((asset) => (
          <MaterialLibraryTile
            key={asset.id}
            asset={asset}
            active={selectedId === asset.id}
            onSelect={() => setSelectedId((cur) => (cur === asset.id ? null : asset.id))}
          />
        ))}
      </div>
      {filtered.length === 0 && <EmptyState text={t("resources.materials.empty")} />}

      <div className="mat-browse-foot">
        <span className="mat-browse-status">
          {t("resources.materials.count", {
            shown: filtered.length,
            total: MATERIAL_LIBRARY.length,
          })}
        </span>
      </div>
    </div>
  );
}
