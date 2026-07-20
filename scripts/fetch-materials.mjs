#!/usr/bin/env node
/**
 * fetch-materials.mjs — Copies mirrored materials from DOSSIER-LIBRARY into
 * public/assets/materials/ and regenerates src/materials/library.ts and
 * public/assets/materials/manifest.json.
 *
 * The 12 hand-authored starter entries in library.ts / manifest.json are
 * preserved (they appear first). Broad-set entries are appended/merged
 * (existing broad entries are replaced if the source has changed).
 *
 * Usage:
 *   node scripts/fetch-materials.mjs --library /home/karim/DOSSIER-LIBRARY
 *   node scripts/fetch-materials.mjs --library ../DOSSIER-LIBRARY --dry-run
 *
 * The --library flag (or DOSSIER_LIBRARY env var) points to the local mirror
 * root. When a git remote is set up, pass a local clone path here.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CAD_ROOT = join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let libraryPath = process.env.DOSSIER_LIBRARY ?? null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--library' || args[i] === '-l') && args[i + 1]) {
      libraryPath = args[++i];
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }
  if (!libraryPath) {
    console.error('Error: --library <path> is required (or set DOSSIER_LIBRARY env var)');
    process.exit(1);
  }
  return { libraryPath: resolve(libraryPath), dryRun };
}

// ── German category labels ────────────────────────────────────────────────────

const CATEGORY_GERMAN = {
  Bricks:        'Backstein',
  Concrete:      'Beton',
  Wood:          'Holz',
  WoodFloor:     'Holzboden',
  Plaster:       'Putz',
  Metal:         'Metall',
  Marble:        'Marmor',
  Rock:          'Naturstein',
  PavingStones:  'Pflasterstein',
  Tiles:         'Fliesen',
  Ground:        'Boden',
  Asphalt:       'Asphalt',
  Roof:          'Dach',
  Roofing:       'Dach',
  Plywood:       'Sperrholz',
  Fabric:        'Stoff',
  Gravel:        'Kies',
  Terrazzo:      'Terrazzo',
  OfficeCeiling: 'Bürodecke',
  Grass:         'Gras',
  // ambientCG displayCategory strings (as stored in index.json) — spaced /
  // substituted names that differ from the API category keys above.
  'Wood Floor':     'Holzboden',
  'Paving Stones':  'Pflasterstein',
  'Roofing Tiles':  'Dach',
  'Roofing':        'Dach',
  'Chipboard':      'Sperrholz',
  'Office Ceiling': 'Bürodecke',
};

/** German label with a numeric suffix to disambiguate within the same category. */
function germanLabel(category, indexWithinCategory) {
  const base = CATEGORY_GERMAN[category] ?? category;
  return `${base} ${indexWithinCategory + 1}`;
}

// ── Starter material IDs (must never be replaced/removed) ─────────────────────

const STARTER_IDS = new Set([
  'Concrete048', 'Plaster001', 'Wood095', 'WoodFloor051',
  'Bricks104', 'Tiles141', 'Marble012', 'PavingStones150',
  'Metal063', 'Gravel043', 'Grass005', 'Ground103',
]);

// ── Map files ─────────────────────────────────────────────────────────────────

const CANONICAL_MAPS = ['color', 'normal', 'roughness', 'displacement', 'ao', 'metalness'];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { libraryPath, dryRun } = parseArgs();

  const ambientcgDir = join(libraryPath, 'ambientcg');
  const indexPath = join(ambientcgDir, 'index.json');

  if (!existsSync(indexPath)) {
    console.error(`No index.json found at: ${indexPath}`);
    console.error('Run scripts/mirror-ambientcg.mjs in DOSSIER-LIBRARY first.');
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const mirroredAssets = index.assets ?? [];
  console.log(`DOSSIER-LIBRARY: ${mirroredAssets.length} assets in index`);
  if (dryRun) console.log('(dry-run mode — no files written)');

  // ── Copy texture files ────────────────────────────────────────────────────
  const destBase = join(CAD_ROOT, 'public', 'assets', 'materials');
  let copied = 0;
  let skipped = 0;
  const broadEntries = []; // { assetId, category, displayName, maps }

  // Track German label counters per category
  const categoryCounters = {};

  for (const asset of mirroredAssets) {
    const { assetId, category, displayName, maps: mapKinds } = asset;

    // Never overwrite starter materials
    if (STARTER_IDS.has(assetId)) {
      skipped++;
      continue;
    }

    const srcDir = join(ambientcgDir, assetId);
    const dstDir = join(destBase, assetId);

    if (!existsSync(srcDir)) {
      console.warn(`  [warn] Source missing: ${srcDir}`);
      continue;
    }

    if (!dryRun) {
      mkdirSync(dstDir, { recursive: true });
    }

    const resolvedMaps = {};
    for (const kind of CANONICAL_MAPS) {
      const srcFile = join(srcDir, `${kind}.jpg`);
      const dstFile = join(dstDir, `${kind}.jpg`);
      if (existsSync(srcFile)) {
        if (!dryRun) {
          copyFileSync(srcFile, dstFile);
        }
        resolvedMaps[kind] = `/assets/materials/${assetId}/${kind}.jpg`;
        copied++;
      }
    }

    if (Object.keys(resolvedMaps).length === 0) {
      console.warn(`  [warn] No maps found for ${assetId}`);
      continue;
    }

    // Build German label
    const catKey = category ?? 'Other';
    categoryCounters[catKey] = (categoryCounters[catKey] ?? 0);
    const label = germanLabel(catKey, categoryCounters[catKey]);
    categoryCounters[catKey]++;

    broadEntries.push({
      id: assetId,
      name: label,
      category: catKey,
      maps: resolvedMaps,
    });
  }

  console.log(`Copied ${copied} map files; ${skipped} starter materials unchanged`);
  console.log(`Broad set: ${broadEntries.length} materials`);

  // ── Regenerate library.ts ─────────────────────────────────────────────────
  const libraryPath_ = join(CAD_ROOT, 'src', 'materials', 'library.ts');
  const existingLibrary = readFileSync(libraryPath_, 'utf8');

  // Extract starter entries from the existing file (everything in MATERIAL_LIBRARY[])
  // We re-use the static text of the 12 starter entries verbatim.
  const starterEntriesMatch = existingLibrary.match(
    /export const MATERIAL_LIBRARY: MaterialAsset\[\] = \[([\s\S]*?)\];\s*\n\nexport default/
  );

  let starterBlock = '';
  if (starterEntriesMatch) {
    // Keep the existing starter block exactly as-is
    starterBlock = starterEntriesMatch[1];
  }

  // Build broad entries as TS object literals
  function mapsToTs(maps, indent) {
    const lines = Object.entries(maps).map(
      ([k, v]) => `${indent}  ${k}: "${v}",`
    );
    return `{\n${lines.join('\n')}\n${indent}}`;
  }

  const broadTs = broadEntries.map(e => {
    return `  {
    id: "${e.id}",
    name: "${e.name}",
    category: "${e.category}",
    maps: ${mapsToTs(e.maps, '    ')},
  }`;
  }).join(',\n');

  const separator = broadEntries.length > 0
    ? `\n\n  // ── Broad set (ambientCG 2K — populated by scripts/fetch-materials.mjs) ──\n  // Run "node scripts/fetch-materials.mjs --library <DOSSIER-LIBRARY-path>" to refresh.\n`
    : '';

  const newLibrary = `// Auto-generated built-in material library (ambientCG, CC0 1.0).
// Static asset paths under /public; loadable directly via three.js TextureLoader.
// Source data mirrors public/assets/materials/manifest.json.
// Broad set populated by: node scripts/fetch-materials.mjs --library <DOSSIER-LIBRARY-path>

export type MaterialMapKind =
  | 'color'
  | 'normal'
  | 'roughness'
  | 'metalness'
  | 'displacement'
  | 'ao';

export interface MaterialAsset {
  /** ambientCG asset id, e.g. 'Concrete048'. */
  id: string;
  /** Localized display name (German). */
  name: string;
  /** ambientCG category key, e.g. 'Concrete'. */
  category: string;
  /** Absolute public paths to the available texture maps. */
  maps: Partial<Record<MaterialMapKind, string>>;
}

export const MATERIAL_LIBRARY_SOURCE = "ambientCG (ambientcg.com)";
export const MATERIAL_LIBRARY_LICENSE = "CC0 1.0 Universal (Public Domain)";
export const MATERIAL_LIBRARY_RESOLUTION = "2K";

export const MATERIAL_LIBRARY: MaterialAsset[] = [${starterBlock}${separator}${broadEntries.length > 0 ? broadTs + ',\n' : ''}];

export default MATERIAL_LIBRARY;
`;

  if (!dryRun) {
    writeFileSync(libraryPath_, newLibrary, 'utf8');
    console.log(`Written: ${libraryPath_}`);
  } else {
    console.log(`[dry-run] Would write: ${libraryPath_}`);
  }

  // ── Regenerate manifest.json ──────────────────────────────────────────────
  const manifestPath = join(destBase, 'manifest.json');
  const existingManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // Keep starter entries from existing manifest
  const starterManifestEntries = existingManifest.materials.filter(
    m => STARTER_IDS.has(m.id)
  );

  const broadManifestEntries = broadEntries.map(e => ({
    id: e.id,
    name: e.name,
    category: e.category,
    maps: e.maps,
  }));

  const newManifest = {
    source: 'ambientCG (ambientcg.com)',
    license: 'CC0 1.0 Universal (Public Domain)',
    resolution: '2K',
    materials: [...starterManifestEntries, ...broadManifestEntries],
  };

  if (!dryRun) {
    writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + '\n', 'utf8');
    console.log(`Written: ${manifestPath}`);
  } else {
    console.log(`[dry-run] Would write: ${manifestPath}`);
  }

  console.log(`\nTotal in MATERIAL_LIBRARY: ${starterManifestEntries.length} starters + ${broadEntries.length} broad = ${starterManifestEntries.length + broadEntries.length}`);
  console.log('\nDone. Next: npx tsc -b && npm run build');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
