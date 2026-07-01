// 3D-Material-Laufzeit: baut aus einem `ComponentMaterial` (Karten-URLs +
// physische Kachelgröße) ein gecachtes three.js `MeshStandardMaterial`. Die
// Texturen werden lazy über den `TextureLoader` geladen (asynchron; das
// Material erscheint sofort, die Karten „poppen" nach dem Laden ein) und je
// Karten-URL nur EINMAL dekodiert (geteilte Bilddaten). Die physische
// Skalierung läuft über `texture.repeat`: ExtrudeGeometry erzeugt die Seiten-
// wand-UVs bereits in WELT-Metern (U = Position entlang der Wand in Metern,
// V = Höhe in Metern). Eine Kachel soll `sizeM` Meter messen → `repeat = 1/sizeM`
// (uniform), unabhängig von der Flächengröße. Dadurch braucht es KEINE flächen-
// spezifischen Material-Instanzen — alle Wandflächen eines Bauteils teilen sich
// dasselbe Material; die Kacheln laufen über Flächengrenzen hinweg konsistent.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import * as THREE from "three";
import type { ComponentMaterial } from "../model/types";
import type { MaterialAsset } from "./library";

/** Default-Kachelgröße in Metern, falls `sizeM` fehlt. */
export const DEFAULT_TILE_SIZE_M = 1.0;

/**
 * Cache + Loader für PBR-Materialien. Lebt so lange wie der Viewport-Aufbau
 * (eine Instanz je Szenen-Aufbau) und gibt im `dispose()` alle Texturen und
 * Materialien frei. Bilddaten werden je URL geteilt (mehrere Bauteile, die
 * dieselbe Karte nutzen, dekodieren sie nur einmal); die je Material geklonten
 * Textur-Objekte tragen ihre eigene `repeat`-Transform.
 */
export class MaterialRuntime {
  private readonly loader = new THREE.TextureLoader();
  /** Geteilte Quell-Texturen je URL (Bilddaten-Quelle für Klone). */
  private readonly sources = new Map<string, THREE.Texture>();
  /** Klone je Quell-URL — werden beim Bild-Load gesammelt geflaggt. */
  private readonly clonesBySource = new Map<string, Set<THREE.Texture>>();
  /** Fertige Materialien je Cache-Schlüssel (stabile Signatur). */
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  /** Alle erzeugten Textur-Klone (für dispose). */
  private readonly textures = new Set<THREE.Texture>();

  /**
   * Lädt (oder liefert aus dem Cache) die Quell-Textur für `url`. Beim ersten
   * Aufruf wird asynchron geladen; sobald das Bild da ist, werden ALLE Klone
   * dieser Quelle als aktualisierungsbedürftig markiert (sonst zeigen sie kein
   * Bild bzw. der Renderer meldet „no image data"). `srgb` markiert die Farb-/
   * Albedo-Karte als sRGB (korrekte Farbe), alle anderen Karten sind Linear-Daten.
   */
  private source(url: string, srgb: boolean): THREE.Texture {
    const key = `${srgb ? "s" : "l"}|${url}`;
    let tex = this.sources.get(key);
    if (!tex) {
      tex = this.loader.load(url, () => {
        // Bild geladen → alle bereits erzeugten Klone neu hochladen lassen.
        for (const clone of this.clonesBySource.get(key) ?? []) {
          clone.needsUpdate = true;
        }
      });
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      this.sources.set(key, tex);
      this.clonesBySource.set(key, new Set());
    }
    return tex;
  }

  /**
   * Eine Material-Karte: klont die Quell-Textur (teilt deren Bilddaten via
   * `.image`/`.source`, kein erneutes Dekodieren), setzt RepeatWrapping und
   * `repeat = 1/sizeM` (physische Kachelung). Der Klon wird für dispose gemerkt.
   */
  private map(url: string, srgb: boolean, sizeM: number): THREE.Texture {
    const key = `${srgb ? "s" : "l"}|${url}`;
    const src = this.source(url, srgb);
    const tex = src.clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    const r = 1 / Math.max(sizeM, 0.001);
    tex.repeat.set(r, r);
    // Ist das Bild bereits geladen, sofort flaggen; sonst übernimmt das der
    // Source-onLoad (s. source()), der alle Klone dieser Quelle aktualisiert.
    // (three.js gibt für asynchron geladene Klone vor dem Bild-Load eine
    // harmlose „no image data"-Konsolenmeldung aus — die Karten erscheinen
    // korrekt, sobald das Bild da ist.)
    if (src.image) tex.needsUpdate = true;
    this.clonesBySource.get(key)?.add(tex);
    this.textures.add(tex);
    return tex;
  }

  /** Stabile Cache-Signatur eines Materials (alle Karten-URLs + Größe). */
  private static keyOf(m: ComponentMaterial): string {
    return [
      m.color ?? "",
      m.normal ?? "",
      m.roughness ?? "",
      m.metalness ?? "",
      m.displacement ?? "",
      m.ao ?? "",
      m.sizeM ?? DEFAULT_TILE_SIZE_M,
    ].join("|");
  }

  /**
   * Liefert das (gecachte) `MeshStandardMaterial` für ein `ComponentMaterial`
   * oder null, wenn keinerlei Karte gesetzt ist (dann gilt das matte Default-
   * Verhalten). Das Material gilt für ALLE Flächen des Bauteils (geteilte
   * Kachel-Skalierung), da die UVs in Welt-Metern liegen.
   */
  get(m: ComponentMaterial | undefined): THREE.MeshStandardMaterial | null {
    if (!m) return null;
    const hasAnyMap =
      m.color || m.normal || m.roughness || m.metalness || m.displacement || m.ao;
    if (!hasAnyMap) return null;

    const key = MaterialRuntime.keyOf(m);
    const cached = this.materials.get(key);
    if (cached) return cached;

    const sizeM = m.sizeM ?? DEFAULT_TILE_SIZE_M;
    const mat = new THREE.MeshStandardMaterial({
      // Weiß als Albedo-Basis, damit die Farb-Karte unverfälscht erscheint;
      // ohne Farb-Karte ein neutrales Hellgrau (sichtbares Volumen).
      color: m.color ? 0xffffff : 0xcccccc,
      roughness: 1,
      metalness: m.metalness ? 1 : 0,
    });
    if (m.color) mat.map = this.map(m.color, true, sizeM);
    if (m.normal) mat.normalMap = this.map(m.normal, false, sizeM);
    if (m.roughness) mat.roughnessMap = this.map(m.roughness, false, sizeM);
    if (m.metalness) mat.metalnessMap = this.map(m.metalness, false, sizeM);
    if (m.ao) mat.aoMap = this.map(m.ao, false, sizeM);
    if (m.displacement) {
      mat.displacementMap = this.map(m.displacement, false, sizeM);
      // Sehr dezent — eine echte Verschiebung braucht Tessellation; hier nur ein
      // Hauch, damit die Silhouette nicht aufreißt (Tiefe kommt aus normalMap).
      mat.displacementScale = 0.01;
    }
    mat.needsUpdate = true;

    this.materials.set(key, mat);
    return mat;
  }

  /** Gibt alle Texturen und Materialien frei. */
  dispose(): void {
    for (const tex of this.sources.values()) tex.dispose();
    this.sources.clear();
    for (const tex of this.textures) tex.dispose();
    this.textures.clear();
    this.clonesBySource.clear();
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
  }
}

/** Baut aus einem Bibliotheks-Asset ein `ComponentMaterial` (Karten + Größe). */
export function materialFromAsset(
  asset: MaterialAsset,
  sizeM = DEFAULT_TILE_SIZE_M,
): ComponentMaterial {
  return {
    libraryId: asset.id,
    color: asset.maps.color,
    normal: asset.maps.normal,
    roughness: asset.maps.roughness,
    metalness: asset.maps.metalness,
    displacement: asset.maps.displacement,
    ao: asset.maps.ao,
    sizeM,
  };
}
