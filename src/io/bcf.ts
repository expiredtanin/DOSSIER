// BCF (BIM Collaboration Format) 2.1/3.0: dünne TS-Fassade über das Rust-Modul `bcf.rs`
// (`src-tauri/fileio`, pkgFileIo). Rust liest/schreibt die .bcfzip, an der Grenze steht JSON
// (Text, Kamera, Komponenten-GUIDs; Snapshots als Base64). Die Themen gehören NICHT ins Projekt:
// sie leben in einer eigenen Datei (s. `panels/BcfPanel.tsx`).
//
// Reine Hilfen (`addComment`, `setTopicStatus`, `newTopic` …) ändern nichts am Eingang, sondern
// liefern Kopien; Zeit und Guid kommen vom Aufrufer (Tests deterministisch).

import { loadFileio } from "../engine/fileioWasm";

export type BcfVersion = "2.1" | "3.0";
export type Vec3 = [number, number, number];

export interface BcfComponent {
  /** 22-stellige IFC-GlobalId. */
  ifcGuid: string;
  originatingSystem: string;
  authoringToolId: string;
}

export interface BcfCamera {
  kind: "perspective" | "orthogonal";
  position: Vec3;
  direction: Vec3;
  up: Vec3;
  /** Vertikaler Öffnungswinkel in Grad (perspektivisch). */
  fieldOfView: number;
  viewToWorldScale: number;
  aspectRatio: number;
}

export interface BcfClippingPlane {
  location: Vec3;
  direction: Vec3;
}

export interface BcfViewpoint {
  guid: string;
  file: string;
  snapshotFile: string;
  /** Snapshot (PNG/JPEG) als Base64, leer = keiner. */
  snapshot: string;
  camera: BcfCamera | null;
  selection: BcfComponent[];
  /** true = alles sichtbar ausser `exceptions`; false = alles unsichtbar ausser `exceptions`. */
  defaultVisibility: boolean;
  exceptions: BcfComponent[];
  clippingPlanes: BcfClippingPlane[];
}

export interface BcfComment {
  guid: string;
  date: string;
  author: string;
  comment: string;
  viewpointGuid: string;
  modifiedDate: string;
  modifiedAuthor: string;
}

export interface BcfHeaderFile {
  ifcProject: string;
  ifcSpatialStructureElement: string;
  isExternal: boolean;
  filename: string;
  date: string;
  reference: string;
}

export interface BcfTopic {
  guid: string;
  topicType: string;
  topicStatus: string;
  title: string;
  priority: string;
  creationDate: string;
  creationAuthor: string;
  modifiedDate: string;
  modifiedAuthor: string;
  dueDate: string;
  assignedTo: string;
  stage: string;
  description: string;
  labels: string[];
  headerFiles: BcfHeaderFile[];
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
}

export interface BcfFile {
  version: string;
  projectId: string;
  projectName: string;
  topics: BcfTopic[];
}

function message(e: unknown, fallback: string): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : fallback;
}

/** .bcfzip lesen. Wirft bei Unsinn (kein ZIP, kein BCF) mit lesbarer Meldung. */
export async function parseBcf(bytes: Uint8Array): Promise<BcfFile> {
  const m = await loadFileio();
  try {
    return JSON.parse(m.bcf_read(bytes)) as BcfFile;
  } catch (e) {
    throw new Error(message(e, "BCF nicht lesbar"));
  }
}

/** .bcfzip der gewünschten Version erzeugen. */
export async function writeBcf(file: BcfFile, version: BcfVersion = "2.1"): Promise<Uint8Array> {
  const m = await loadFileio();
  try {
    return m.bcf_write(JSON.stringify(file), version);
  } catch (e) {
    throw new Error(message(e, "BCF nicht schreibbar"));
  }
}

/** Übliche Status-Werte (BCF lässt eigene Werte über extensions zu). */
export const BCF_STATUSES = ["Open", "In Progress", "Resolved", "Closed"] as const;

export function emptyBcf(projectId = "", projectName = ""): BcfFile {
  return { version: "2.1", projectId, projectName, topics: [] };
}

/** Neues Thema (Guid/Zeit vom Aufrufer). */
export function newTopic(init: {
  guid: string;
  title: string;
  author: string;
  now: string;
  description?: string;
  viewpoints?: BcfViewpoint[];
}): BcfTopic {
  return {
    guid: init.guid,
    topicType: "Issue",
    topicStatus: "Open",
    title: init.title,
    priority: "",
    creationDate: init.now,
    creationAuthor: init.author,
    modifiedDate: "",
    modifiedAuthor: "",
    dueDate: "",
    assignedTo: "",
    stage: "",
    description: init.description ?? "",
    labels: [],
    headerFiles: [],
    comments: [],
    viewpoints: init.viewpoints ?? [],
  };
}

/** Viewpoint aus einer Komponenten-Auswahl (Kamera optional). */
export function newViewpoint(guid: string, ifcGuids: string[], camera: BcfCamera | null = null, system = "Dossier"): BcfViewpoint {
  return {
    guid,
    file: "",
    snapshotFile: "",
    snapshot: "",
    camera,
    selection: ifcGuids.map((ifcGuid) => ({ ifcGuid, originatingSystem: system, authoringToolId: "" })),
    defaultVisibility: true,
    exceptions: [],
    clippingPlanes: [],
  };
}

function mapTopic(file: BcfFile, guid: string, fn: (t: BcfTopic) => BcfTopic): BcfFile {
  return { ...file, topics: file.topics.map((t) => (t.guid === guid ? fn(t) : t)) };
}

export function addTopic(file: BcfFile, topic: BcfTopic): BcfFile {
  return { ...file, topics: [...file.topics, topic] };
}

export function setTopicStatus(file: BcfFile, guid: string, status: string, author: string, now: string): BcfFile {
  return mapTopic(file, guid, (t) => ({ ...t, topicStatus: status, modifiedDate: now, modifiedAuthor: author }));
}

export function addComment(file: BcfFile, guid: string, comment: BcfComment): BcfFile {
  return mapTopic(file, guid, (t) => ({
    ...t,
    comments: [...t.comments, comment],
    modifiedDate: comment.date,
    modifiedAuthor: comment.author,
  }));
}

/** Zusammenfassung für `dossier-cli bcf-info`: Themen als JSON-taugliches Objekt, ohne Snapshot-Bytes. */
export function bcfInfo(file: BcfFile): unknown {
  return {
    version: file.version,
    project: { id: file.projectId, name: file.projectName },
    topicCount: file.topics.length,
    topics: file.topics.map((t) => ({
      guid: t.guid,
      title: t.title,
      type: t.topicType,
      status: t.topicStatus,
      priority: t.priority,
      assignedTo: t.assignedTo,
      dueDate: t.dueDate,
      creationDate: t.creationDate,
      creationAuthor: t.creationAuthor,
      description: t.description,
      labels: t.labels,
      comments: t.comments.map((c) => ({ guid: c.guid, date: c.date, author: c.author, comment: c.comment })),
      viewpoints: t.viewpoints.map((v) => ({
        guid: v.guid,
        camera: v.camera,
        selected: v.selection.map((c) => c.ifcGuid),
        defaultVisibility: v.defaultVisibility,
        exceptions: v.exceptions.map((c) => c.ifcGuid),
        clippingPlanes: v.clippingPlanes.length,
        hasSnapshot: v.snapshot.length > 0,
      })),
    })),
  };
}
