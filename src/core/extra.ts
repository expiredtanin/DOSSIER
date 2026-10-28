// Von Hand gepflegter Teil der Fassade: Kern-Einstiege, die nicht (nur) die Hülle braucht — Datei-
// Format, Exporte, WASM-Quelle. Genutzt von `dossier-cli` (src/cli), das NUR `src/core` importiert.

export { parseProjectFile, serializeProject, PROJECT_FORMAT_VERSION } from "../io/projectFormat";
export { exportIfcSpf } from "../export/exportIfc";
export { buildPlanDxf } from "../export/exportDxf";
export { buildPlanDwg } from "../export/exportDxf";
export { buildPlanDxfBinary } from "../export/exportDxf";
export { loadFileio } from "../engine/fileioWasm";
export { readIfc, ifcToImportedMeshes } from "../io/ifcImport";
export { readIfcElements, ifcElementsToProject } from "../io/ifcElements";
export { parseBcf, writeBcf, bcfInfo } from "../io/bcf";
export { projectGeoOrigin } from "../model/geoRebase";
export { ensureContextCategories } from "../model/contextCategories";
export { projectToWorldCoords } from "../model/geoRebase";
export { exportScheduleCsv } from "../export/exportSchedule";
export { exportObj, exportStl, exportGlb, exportGltf } from "../export/exportMesh";
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
export { parseDxf } from "../io/dxfParser";
export { contoursToDrawings, textsToDrawings, planImportCategories, distinctImportLayers } from "../io/dxfToDrawings";
export { emptyProject } from "../model/sampleProject";
export { readPointCloud, readPointCloudFlat, isPointCloudFile, DEFAULT_MAX_POINTS } from "../io/pointCloud";
export type { PointCloudData, PointCloudOptions, PointCloudReport } from "../io/pointCloud";
export { readPdfVectorPage, pdfPageToImport, pdfPageInfo, pdfMetersPerPt, isPdfFile, PDF_SCALES } from "../io/pdfVector";
export type { PdfVectorPage, PdfVectorPath, PdfVectorText } from "../io/pdfVector";
