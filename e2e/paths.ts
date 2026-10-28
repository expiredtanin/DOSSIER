import { resolve } from "node:path";

/** Beispielprojekt als .obp (von globalSetup per CLI erzeugt; Ordner ist gitignoriert). */
export const BEISPIEL_OBP = resolve(".tmp-e2e/beispiel.obp");
/** Kleine DXF (4 Linien, Rechteck 10 × 8 m). */
export const KLEIN_DXF = resolve("e2e/fixtures/klein.dxf");
