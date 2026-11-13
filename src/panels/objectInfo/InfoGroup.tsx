// [189] Einklappbarer Abschnitt der Objekt-Info: Kopfzeile (Knopf mit Pfeil) und Inhalt. Die Abschnitts-
// Komponenten (`WallSection` …) bringen ihre eigene Kopf-Trennlinie mit; die erste blendet das CSS im Rumpf aus.

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { t } from "../../i18n";
import { INFO_GROUP_TITLE, type InfoGroupId } from "./groups";
import { clearInfoGroupFocus, getInfoGroupState, isInfoGroupOpen, subscribeInfoGroups, toggleInfoGroup } from "./infoGroupState";

export function InfoGroup({ id, children }: { id: InfoGroupId; children: ReactNode }) {
  const st = useSyncExternalStore(subscribeInfoGroups, getInfoGroupState, getInfoGroupState);
  const open = isInfoGroupOpen(st, id);
  const head = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (st.focus?.id !== id) return;
    head.current?.scrollIntoView?.({ block: "nearest" });
    head.current?.focus();
    clearInfoGroupFocus();
  }, [st.focus, id]);
  return (
    <section className="objinfo-group" data-group={id} data-open={open}>
      <button
        ref={head}
        type="button"
        className="objinfo-group-head"
        aria-expanded={open}
        title={t("objinfo.group.toggle")}
        onClick={() => toggleInfoGroup(id)}
      >
        <span className="objinfo-group-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        {t(INFO_GROUP_TITLE[id])}
      </button>
      {open && <div className="objinfo-group-body">{children}</div>}
    </section>
  );
}
