// Eigenständiger React-Root für das native Ebeneneinstellungs-Fenster (siehe
// layerSettingsWindow.ts für die Hauptfenster-Seite der Sync-Brücke). Von
// main.tsx gerendert, wenn die URL `?window=layer-settings` trägt.
//
// Dieselben Felder wie der bisherige `InlineEditor`-Popover in App.tsx
// (`editor?.kind === "layer"`): Name, Farbe, Linienstärke, Schraffur-Auswahl
// — siehe layerSettingsWindow.ts Kopfkommentar für den bewussten Scope-Schnitt
// gegenüber der Rhino-Vorlage.
//
// Bezeichner englisch, UI-Text über i18n (CONVENTIONS.md).

import { useEffect, useState } from "react";
import { EditorField } from "../ui/EditorField";
import type { LayerSettingsCommandHandlers, LayerSettingsSyncState } from "./layerSettingsWindow";
import { t } from "../i18n";

function initialCodeFromUrl(): string {
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

export function LayerSettingsWindowApp() {
  const [state, setState] = useState<LayerSettingsSyncState | null>(null);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      if (disposed) return;
      unlisten.push(
        await listen<LayerSettingsSyncState | null>("layer-settings-sync-state", (e) =>
          setState(e.payload),
        ),
      );
      // Beim Wechsel auf eine andere Ebene (erneutes Öffnen desselben
      // Fensters aus dem Kontextmenü) — nur der Titel/URL-Code als Hinweis;
      // der eigentliche State kommt weiterhin per Sync vom Hauptfenster.
      unlisten.push(await listen<string>("layer-settings-set-code", () => {}));
      await emitTo("main", "layer-settings-window-ready").catch(() => {});
    })();
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  const patch = (p: Partial<{ name: string; color: string; lw: number; hatch: string | undefined }>) => {
    if (!state) return;
    void import("@tauri-apps/api/event").then(({ emitTo }) =>
      emitTo("main", "layer-settings-command", {
        name: "onPatchCategory" as keyof LayerSettingsCommandHandlers,
        args: [state.code, p],
      }).catch(() => {}),
    );
  };

  const code = state?.code ?? initialCodeFromUrl();

  if (!state) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--ink-dim, #8a8a8a)",
          fontSize: 13,
        }}
      >
        {t("resources.loading")}
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        className="imp-head"
        data-tauri-drag-region
        style={{ paddingLeft: 88 }}
      >
        <span className="imp-head-title">
          {t("editor.layerTitle", { code })}
        </span>
      </header>
      <div className="imp-body" style={{ overflowY: "auto" }}>
        <section className="imp-section">
          <EditorField label={t("editor.name")}>
            <input
              type="text"
              value={state.name}
              autoFocus
              onChange={(e) => patch({ name: e.target.value })}
            />
          </EditorField>
          <EditorField label={t("editor.color")}>
            <input
              type="color"
              value={state.color}
              onChange={(e) => patch({ color: e.target.value })}
            />
          </EditorField>
          <EditorField label={t("editor.lineWeight")}>
            <span className="editor-num">
              <input
                type="number"
                step={0.01}
                min={0.01}
                value={state.lw}
                onChange={(e) => patch({ lw: Number(e.target.value) })}
              />
              <span className="editor-unit">{t("editor.unit.mm")}</span>
            </span>
          </EditorField>
          <EditorField label={t("editor.hatch")}>
            <span className="editor-hatch">
              <select
                value={state.hatchId ?? ""}
                onChange={(e) => patch({ hatch: e.target.value || undefined })}
              >
                <option value="">{t("resources.viewHatch.none")}</option>
                {state.hatches.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </span>
          </EditorField>
        </section>
      </div>
    </div>
  );
}
