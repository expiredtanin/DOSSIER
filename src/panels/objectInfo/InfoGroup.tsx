// [189] Einklappbarer Abschnitt der Objekt-Info: Kopfzeile (Knopf mit Pfeil) und Inhalt. Die Abschnitts-
// Komponenten (`WallSection` …) bringen ihre eigene Kopf-Trennlinie mit; die erste blendet das CSS im Rumpf aus.

import { useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { INFO_GROUP_TITLE, type InfoGroupId } from "./groups";
import { clearInfoGroupFocus, getInfoGroupState, isInfoGroupOpen, subscribeInfoGroups, toggleInfoGroup } from "./infoGroupState";

type GroupState = ReturnType<typeof getInfoGroupState>;

/** Zustand der Abschnitte (offen/zu, Fokus-Anfrage) für [`infoGroupFrame`]. */
export function useInfoGroupState(): GroupState {
  return useSyncExternalStore(subscribeInfoGroups, getInfoGroupState, getInfoGroupState);
}

/**
 * Abschnitt als blosses Markup, ohne eigene Komponente: Das Panel liest den Zustand einmal ([`useInfoGroupState`])
 * und rahmt damit mehrere Abschnitte, ohne dass je Abschnitt ein Komponenten-Render bei jeder Änderung des Inhalts
 * anfällt ([121], Render-Zählung). Die Fokus-Anfrage löst der Ref des Kopfknopfs ein.
 */
export function infoGroupFrame(st: GroupState, id: InfoGroupId, children: ReactNode): ReactNode {
  const open = isInfoGroupOpen(st, id);
  return (
    <section key={id} className="objinfo-group" data-group={id} data-open={open}>
      <button
        ref={(el) => {
          if (!el || st.focus?.id !== id) return;
          el.scrollIntoView?.({ block: "nearest" });
          el.focus();
          clearInfoGroupFocus();
        }}
        type="button"
        className="objinfo-group-head"
        aria-expanded={open}
        aria-controls={open ? `objinfo-group-${id}` : undefined}
        title={t("objinfo.group.toggle")}
        onClick={() => toggleInfoGroup(id)}
      >
        <span className="objinfo-group-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {t(INFO_GROUP_TITLE[id])}
      </button>
      {open && (
        <div className="objinfo-group-body" id={`objinfo-group-${id}`}>
          {children}
        </div>
      )}
    </section>
  );
}

export function InfoGroup({ id, children }: { id: InfoGroupId; children: ReactNode }) {
  const st = useInfoGroupState();
  return infoGroupFrame(st, id, children);
}
