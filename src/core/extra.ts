// Von Hand gepflegter Teil der Fassade: Kern-Einstiege, die nicht (nur) die Hülle braucht — Datei-
// Format, Exporte, WASM-Quelle. Genutzt von `dossier-cli` (src/cli), das NUR `src/core` importiert.

export { parseProjectFile, serializeProject, PROJECT_FORMAT_VERSION } from "../io/projectFormat";
export { exportIfcSpf } from "../export/exportIfc";
export { buildPlanDxf } from "../export/exportDxf";
export { buildPlanDwg } from "../export/exportDxf";
export { loadFileio } from "../engine/fileioWasm";
export { readIfc, ifcToImportedMeshes } from "../io/ifcImport";
export { projectGeoOrigin } from "../model/geoRebase";
export { ensureContextCategories } from "../model/contextCategories";
export { projectToWorldCoords } from "../model/geoRebase";
export { exportScheduleCsv } from "../export/exportSchedule";
export { exportObj, exportStl } from "../export/exportMesh";
export { exportProjectStep } from "../export/exportStep";
export { planToSvgString } from "../export/planToSvgString";
export { setWasmBytesProvider } from "../engine/wasmSource";
export { initCore, coreReady } from "../engine/coreWasm";
export { applyOps, diffToOps, validateProject, validateOps } from "./ops";
export type { CoreOp } from "./ops";
export type { Project, DrawingLevel } from "../model/types";
export { computeKennzahlen, checkRoomProgram, solidVolume } from "../analysis/kennzahlen";
export type { Kennzahlen, ProgramCheck } from "../analysis/kennzahlen";
export { sunPosition, shadowPolygons, shadowOfPrism, projectLatLon } from "../analysis/sun";
export type { SunPosition } from "../analysis/sun";
export { checkSiteRules, allowedArea, multiPolygonArea, buildingFootprint, modelTop } from "../analysis/siteRules";
export type { SiteCheck } from "../analysis/siteRules";
export { encodeRenderScene } from "../plan/renderSceneBin";
export { sampleProject } from "../model/sampleProject";
