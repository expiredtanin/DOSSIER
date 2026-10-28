// Dock-Panel „BCF-Themen": Koordinations-Themen im BIM Collaboration Format (2.1/3.0) von Solibri,
// BIMcollab, Revit, ArchiCAD. Datei öffnen, Themenliste mit Status, Klick zeigt Beschreibung,
// Kommentare und Snapshot und wählt die betroffenen Bauteile im Modell aus (Zuordnung über die
// IFC-GlobalId, dieselbe Ableitung wie im IFC-Export: `io/bcfMatch.ts`). Kommentar hinzufügen,
// Status ändern, neues Thema aus der Auswahl, als .bcfzip speichern.
//
// Die Themen gehören nicht zum Projekt (eigene Datei, `bcfSession.ts`). Die Kamera eines Viewpoints
// wird angezeigt, aber noch nicht gesetzt: `Wasm3DViewport` hält seine Orbit-Kamera intern und bietet
// keine Setz-Funktion (s. TODO.md [BCF]).
//
// Bezeichner englisch, UI-Text deutsch/englisch über t().

import { useMemo, useRef } from "react";
import { t } from "../i18n";
import { usePanelHost } from "./host";
import { getState, useStore } from "../state/appStore";
import { saveBinaryFile } from "../native/saveFile";
import {
  BCF_STATUSES,
  addComment,
  addTopic,
  emptyBcf,
  newTopic,
  newViewpoint,
  parseBcf,
  setTopicStatus,
  writeBcf,
  type BcfCamera,
  type BcfFile,
  type BcfTopic,
  type BcfVersion,
} from "../io/bcf";
import {
  bcfSelectionSize,
  emptyBcfSelection,
  resolveGuids,
  selectionToGuids,
  viewpointGuids,
  type BcfSelection,
} from "../io/bcfMatch";
import { fileioLoaded, loadFileio } from "../engine/fileioWasm";
import { setBcfSession, useBcfSession } from "./bcfSession";

const AUTHOR_KEY = "dossier.bcf.author";

function readAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeAuthor(v: string): void {
  try {
    localStorage.setItem(AUTHOR_KEY, v);
  } catch {
    /* ohne Speicher: nur für diese Sitzung */
  }
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const h = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, "0");
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

/** Auswahl des Modells in die Kanäle des Stores übernehmen (ersetzt die bisherige Auswahl). */
function applySelection(sel: BcfSelection): void {
  const s = getState();
  s.clearSelection();
  s.setSelectedWallIds(sel.wallIds);
  s.setSelectedCeilingIds(sel.ceilingIds);
  s.setSelectedOpeningIds(sel.openingIds);
  s.setSelectedStairIds(sel.stairIds);
  s.setSelectedRoomIds(sel.roomIds);
  s.setSelectedExtrudedSolidIds(sel.extrudedSolidIds);
  s.setSelectedColumnIds(sel.columnIds);
  s.setSelectedRoofIds(sel.roofIds);
  s.setSelectedContextObjectIds(sel.contextObjectIds);
}

function currentSelection(): BcfSelection {
  const s = getState();
  return {
    ...emptyBcfSelection(),
    wallIds: s.selectedWallIds,
    ceilingIds: s.selectedCeilingIds,
    openingIds: s.selectedOpeningIds,
    stairIds: s.selectedStairIds,
    roomIds: s.selectedRoomIds,
    extrudedSolidIds: s.selectedExtrudedSolidIds,
    columnIds: s.selectedColumnIds,
    roofIds: s.selectedRoofIds,
    contextObjectIds: s.selectedContextObjectIds,
  };
}

const f1 = (n: number) => n.toLocaleString("de-CH", { maximumFractionDigits: 1 });

function cameraText(c: BcfCamera): string {
  const p = { x: f1(c.position[0]), y: f1(c.position[1]), z: f1(c.position[2]) };
  return c.kind === "orthogonal" ? t("bcf.camera.orthogonal", p) : t("bcf.camera.perspective", { ...p, fov: f1(c.fieldOfView) });
}

export function BcfPanel() {
  const host = usePanelHost();
  const notify = useStore((s) => s.notify);
  const session = useBcfSession();
  const inputRef = useRef<HTMLInputElement>(null);
  const authorRef = useRef<HTMLInputElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { file, selectedGuid } = session;
  const topic = file?.topics.find((x) => x.guid === selectedGuid) ?? null;

  const author = () => authorRef.current?.value.trim() || "Dossier";
  const now = () => new Date().toISOString();
  const update = (next: BcfFile) => setBcfSession({ file: next, dirty: true });

  const openFile = async (f: File) => {
    try {
      const parsed = await parseBcf(new Uint8Array(await f.arrayBuffer()));
      setBcfSession({ file: parsed, fileName: f.name, dirty: false, selectedGuid: null, version: parsed.version === "3.0" ? "3.0" : "2.1" });
    } catch (e) {
      notify(t("bcf.openFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  const selectTopic = (tp: BcfTopic) => {
    setBcfSession({ selectedGuid: tp.guid });
    const guids = [...new Set(tp.viewpoints.flatMap(viewpointGuids))];
    if (guids.length === 0) return;
    // GlobalIds brauchen das Format-Modul (Rust-Hash); nach dem Öffnen ist es geladen.
    void loadFileio().then(() => {
      const { selection } = resolveGuids(host.project, guids);
      const found = bcfSelectionSize(selection);
      applySelection(selection);
      notify(t("bcf.components", { found, total: guids.length }), found > 0 ? "info" : "warning");
    });
  };

  const save = async () => {
    if (!file) return;
    try {
      const bytes = await writeBcf(file, session.version);
      const name = session.fileName.replace(/\.(bcf|bcfzip|zip)$/i, "") || host.project.name || "themen";
      if (await saveBinaryFile(bytes, `${name}.bcfzip`, "application/zip")) {
        setBcfSession({ dirty: false, fileName: `${name}.bcfzip` });
        notify(t("bcf.saved"), "info");
      }
    } catch (e) {
      notify(t("bcf.saveFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
    }
  };

  const createFromSelection = async () => {
    const sel = currentSelection();
    if (bcfSelectionSize(sel) === 0) {
      notify(t("bcf.needSelection"), "warning");
      return;
    }
    await loadFileio();
    const guids = selectionToGuids(host.project, sel);
    const topicGuid = uuid();
    const tp = newTopic({
      guid: topicGuid,
      title: t("bcf.defaultTitle"),
      author: author(),
      now: now(),
      viewpoints: guids.length > 0 ? [newViewpoint(uuid(), guids)] : [],
    });
    const base = file ?? emptyBcf(host.project.id, host.project.name ?? "");
    setBcfSession({ file: addTopic(base, tp), dirty: true, selectedGuid: topicGuid });
  };

  const submitComment = () => {
    const el = commentRef.current;
    if (!file || !topic || !el || el.value.trim() === "") return;
    update(addComment(file, topic.guid, { guid: uuid(), date: now(), author: author(), comment: el.value.trim(), viewpointGuid: "", modifiedDate: "", modifiedAuthor: "" }));
    el.value = "";
  };

  const retitle = (title: string) => {
    if (!file || !topic) return;
    update({ ...file, topics: file.topics.map((x) => (x.guid === topic.guid ? { ...x, title, modifiedDate: now(), modifiedAuthor: author() } : x)) });
  };

  const snapshot = topic?.viewpoints.find((v) => v.snapshot)?.snapshot;
  const camera = topic?.viewpoints.find((v) => v.camera)?.camera ?? null;
  const topicGuids = topic ? [...new Set(topic.viewpoints.flatMap(viewpointGuids))] : [];
  const project = host.project;
  const foundCount = useMemo(
    () => (topicGuids.length > 0 && fileioLoaded() ? bcfSelectionSize(resolveGuids(project, topicGuids).selection) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, topic],
  );

  return (
    <div className="bcf-panel">
      <div className="bcf-bar">
        <button type="button" className="bcf-btn" onClick={() => inputRef.current?.click()}>{t("bcf.open")}</button>
        <button type="button" className="bcf-btn" onClick={() => setBcfSession({ file: emptyBcf(host.project.id, host.project.name ?? ""), fileName: "", dirty: false, selectedGuid: null })}>{t("bcf.new")}</button>
        <button type="button" className="bcf-btn" disabled={!file} onClick={() => void save()}>{t("bcf.save")}{session.dirty ? " •" : ""}</button>
        <input ref={inputRef} type="file" accept=".bcf,.bcfzip,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); }} />
      </div>
      <div className="bcf-bar">
        <label className="bcf-field">
          <span>{t("bcf.author")}</span>
          <input ref={authorRef} type="text" defaultValue={readAuthor()} placeholder={t("bcf.author.placeholder")} onChange={(e) => writeAuthor(e.target.value)} />
        </label>
        <label className="bcf-field bcf-field-narrow">
          <span>{t("bcf.format")}</span>
          <select value={session.version} onChange={(e) => setBcfSession({ version: e.target.value as BcfVersion })}>
            <option value="2.1">BCF 2.1</option>
            <option value="3.0">BCF 3.0</option>
          </select>
        </label>
      </div>
      <button type="button" className="bcf-btn" title={t("bcf.newFromSelection.hint")} onClick={() => void createFromSelection()}>{t("bcf.newFromSelection")}</button>

      {!file && <div className="bcf-empty">{t("bcf.empty")}</div>}
      {file && <div className="bcf-info">{t("bcf.fileInfo", { name: session.fileName || "–", version: file.version, n: file.topics.length })}</div>}
      {file && file.topics.length === 0 && <div className="bcf-empty">{t("bcf.noTopics")}</div>}

      <ul className="bcf-list">
        {file?.topics.map((tp) => (
          <li key={tp.guid}>
            <button type="button" className={`bcf-topic${tp.guid === selectedGuid ? " is-active" : ""}`} onClick={() => selectTopic(tp)}>
              <span className={`bcf-status bcf-status-${tp.topicStatus.toLowerCase().replace(/\s+/g, "-")}`}>{tp.topicStatus}</span>
              <span className="bcf-topic-title">{tp.title}</span>
              {tp.comments.length > 0 && <span className="bcf-count">{tp.comments.length}</span>}
            </button>
          </li>
        ))}
      </ul>

      {file && topic && (
        <div className="bcf-detail">
          <input className="bcf-title" type="text" value={topic.title} onChange={(e) => retitle(e.target.value)} aria-label={t("bcf.defaultTitle")} />
          <div className="bcf-grid">
            <label className="bcf-field">
              <span>{t("bcf.status")}</span>
              <select value={topic.topicStatus} onChange={(e) => update(setTopicStatus(file, topic.guid, e.target.value, author(), now()))}>
                {[...new Set<string>([...BCF_STATUSES, topic.topicStatus])].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {topic.topicType && <div className="bcf-kv"><span>{t("bcf.type")}</span>{topic.topicType}</div>}
            {topic.priority && <div className="bcf-kv"><span>{t("bcf.priority")}</span>{topic.priority}</div>}
            {topic.assignedTo && <div className="bcf-kv"><span>{t("bcf.assignedTo")}</span>{topic.assignedTo}</div>}
            {topic.dueDate && <div className="bcf-kv"><span>{t("bcf.dueDate")}</span>{topic.dueDate.slice(0, 10)}</div>}
            {topic.labels.length > 0 && <div className="bcf-kv"><span>{t("bcf.labels")}</span>{topic.labels.join(", ")}</div>}
          </div>
          {topic.description && <div className="bcf-desc">{topic.description}</div>}
          {snapshot && <img className="bcf-snapshot" alt="" src={`data:image/png;base64,${snapshot}`} />}
          {camera && <div className="bcf-info"><b>{t("bcf.camera")}:</b> {cameraText(camera)}</div>}
          <div className="bcf-bar">
            <div className="bcf-info bcf-grow">{topicGuids.length > 0 ? t("bcf.components", { found: foundCount, total: topicGuids.length }) : t("bcf.components.none")}</div>
            {topicGuids.length > 0 && <button type="button" className="bcf-btn" onClick={() => selectTopic(topic)}>{t("bcf.selectElements")}</button>}
          </div>
          <div className="bcf-sub">{t("bcf.comments")}</div>
          {topic.comments.map((c) => (
            <div className="bcf-comment" key={c.guid}>
              <div className="bcf-comment-head">{c.author} · {c.date.slice(0, 16).replace("T", " ")}</div>
              <div>{c.comment}</div>
            </div>
          ))}
          <textarea ref={commentRef} className="bcf-input" rows={2} placeholder={t("bcf.commentPlaceholder")} />
          <button type="button" className="bcf-btn" onClick={submitComment}>{t("bcf.addComment")}</button>
        </div>
      )}
    </div>
  );
}
