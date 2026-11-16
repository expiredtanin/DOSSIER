# Cycles eingebaut [215] — Machbarkeit und Plan

Stand 16.11.2026 (Spike). Entscheid Maintainer 16.11.: Cycles kommt VOR 1.0 in die App, damit man Blender nicht braucht.
Dieses Dokument hält fest, was im Linux-Container gebaut und gemessen wurde und wie der Einbau aussieht.
**Stand 16.11. (Teil 2):** Bau in CI (`cycles.yml`), Mitliefern (Tauri, Electron) und die Laufzeit-Fassade stehen — s. Abschnitt 10.
Noch offen: XML-Schreiber im Kern, Dialog, Tonwert (s. 6. und 8.). Bauskripte: `scripts/cycles/` (`build-linux.sh` geprüft, `build-macos.sh` für CI geschrieben, ungeprüft),
Testszene: `scripts/cycles/spike-scene.py`. Das Austauschformat der Blender-Brücke ([211]) steht in `doc/RENDER-SZENE.md`.

## 1. Ergebnis in Kürze

- **Der Linux-CPU-Build gelingt**, ohne Blender-Vorbau-Bibliotheken: Cycles 5.3.0 (Tag `v5.3.0`, Apache-2.0) mit Embree und
  OIDN-Entrauscher, Programm `cycles` 7,3 MB gestrippt; mit den 21 mitzuliefernden Bibliotheken **111 MB entpackt, 58 MB
  als `tar.xz`**. Startet in 0,02 s (`--version`), bis zum ersten Sample einer kleinen Szene 0,7–0,8 s. Läuft von jedem Ort
  (RPATH `$ORIGIN/lib`), ohne `LD_LIBRARY_PATH`.
- **Das Bild stimmt**: Testhaus (Quader + Satteldach + Wiese), Nishita-Himmel mit Sonne, Principled BSDF, Box-projizierte
  Textur, OIDN-Entrauschen — angesehen (s. 4.).
- Das Standalone-Programm liest **Cycles-XML**; das schreibt der Kern direkt (kein glb-Umweg). Es hat aber **keine
  Tonwert-Abbildung** (PNG = lineares Licht in 8 Bit) und **keine Farbverwaltung ohne OCIO**: Dossier rechnet EXR → Bild selbst (s. 6.).
- **Empfehlung: Cycles als Endbild-Renderer bauen, den eigenen Pathtracer [212] als Vorschau behalten.** Aufwand grob **11–15 Tage**
  (s. 8.), davon der Mac-Teil (Metal) nur mit dem Maintainer-Mac prüfbar.
- Stolpersteine (alle gelöst, s. 2.): vorgebaute Blender-Bibliotheken 12–25 GB je Plattform (Repo-Grösse inkl. Historie),
  Ubuntus OpenImageIO zieht 430 MB (ffmpeg, GDAL, OpenCV …), Ubuntus OpenColorIO 2.1 ist zu alt und Cycles 5.3 hat OCIO fest
  verdrahtet, jbigkit (GPL-2) hängt an Ubuntus libtiff.

## 2. Bauweg Linux x86_64 (CPU)

```
scripts/cycles/build-linux.sh [Arbeitsordner]    # Standard ~/cycles-build; Ergebnis <Arbeitsordner>/dist/
```
Das Skript ist idempotent und wurde im Container einmal komplett durchlaufen (`SKIP_APT=1` ab dem zweiten Lauf):
**8 Minuten** bei 4 vCPU (`JOBS=3`; Cycles ≈ 5 min, OpenImageIO ≈ 3 min, libtiff < 1 min), Platzbedarf im Arbeitsordner **470 MB**
(Quellen 104 MB, Build 100 MB, dist 111 MB, OIDN 46 MB). Schritte:

1. **apt**: `build-essential cmake ninja-build git python3 patchelf libembree-dev libtbb-dev libopenexr-dev libpugixml-dev libpng-dev libjpeg-dev
   libtiff-dev zlib1g-dev libzstd-dev libfmt-dev libboost-{dev,filesystem,thread,system,iostreams,regex}-dev` (Ubuntu 24.04: Embree 4.3, TBB 2021.11, OpenEXR 3.1).
2. **Cycles-Quellen**: `git clone --depth 1 --branch v5.3.0 https://projects.blender.org/blender/cycles.git` (19 MB). Archiv-Downloads
   (`…/archive/*.tar.gz`) scheitern am Cloudflare-Test, `git clone` geht.
3. **OIDN 2.5.0** (Apache-2.0) aus Blenders Vorbau-Repo `lib-linux_x64`, nur drei `.so`-Dateien, Header und CMake-Dateien einzeln über die
   LFS-Media-URL (`…/media/branch/main/openimagedenoise/…`, zusammen 48 MB) statt des ganzen Repos (**25 GB**). `libOpenImageDenoise_core`
   (47 MB) enthält alle Netzgewichte; `…_device_cpu` (0,6 MB) lädt OIDN zur Laufzeit.
4. **libtiff 4.5.1 + OpenImageIO 2.4.17 aus den Ubuntu-Quellpaketen** (`archive.ubuntu.com`, `*.orig.tar.xz`), schlank: nur PNG/JPEG/TIFF/EXR,
   ohne ffmpeg, GDAL, OpenCV, WebP, RAW, HEIF, OCIO, Python, Werkzeuge. Grund: Ubuntus `libopenimageio-dev` hängt 264 Bibliotheken (**430 MB**,
   u. a. GDAL, ffmpeg, libx265, MySQL-Client) an das Programm — nicht auslieferbar. libtiff ohne jbig/lzma/webp/lerc/zstd, weil jbigkit GPL-2 ist.
5. **Cycles-Konfiguration**: `-DWITH_OCIO=OFF` (siehe Patch unten) `-DWITH_CYCLES_{OSL,USD,HYDRA_RENDER_DELEGATE,ALEMBIC,OPENVDB,NANOVDB,OPENSUBDIV,
   STANDALONE_GUI,DEVICE_CUDA,DEVICE_OPTIX,DEVICE_HIP}=OFF`, `EMBREE=ON`, `OPENIMAGEDENOISE=ON`, `WITH_LIBS_PRECOMPILED=OFF`.
6. **Auslieferordner**: `strip --strip-unneeded`, Bibliotheken aus `ldd` (ohne libc/libstdc++/libm …) nach `dist/lib`, RPATH `$ORIGIN/lib` bzw. `$ORIGIN`.

**Patch `scripts/cycles/patches/no-ocio.patch`** (59 Zeilen, 4 Dateien): Cycles 5.3 definiert `WITH_OCIO` unbedingt und verlangt eine neuere OpenColorIO (Ubuntus 2.1 reichte nicht: `hasAlias`, `apply`-Signatur);
der Patch macht es zu einer Option (`WITH_OCIO`, Standard AUS). Ohne OCIO bleiben die eingebauten Farbräume (sRGB, linear, Non-Color,
„auto“ = sRGB für 8-Bit-Dateien) — für Dossier genug, spart die 6 MB-Bibliothek samt Konfiguration. Folge: ein `colorspace="sRGB"` im XML
wird mit Warnung ignoriert (Textur dann linear!); der Schreiber setzt **nichts** (auto) bzw. `Non-Color` für Rauheit/Metall/Normale. Geprüft.

**Portabilität (offen):** gebaut auf Ubuntu 24.04 (glibc 2.39). Für AppImage auf älteren Distributionen im CI-Container mit älterem
Unterbau bauen (z. B. Ubuntu 22.04) und `libstdc++.so.6`/`libgcc_s.so.1` mitgeben. Dasselbe Skript, nur anderes Basis-Image — nicht geprüft.

## 3. Grösse, Abhängigkeiten, Lizenzen (für `NOTICE`, erst beim echten Einbau)

| Teil | Grösse (gestrippt) | Lizenz |
|---|---|---|
| `cycles` (Programm; Quelle enthält Nishita-/Hosek-Wilkie-Himmel, mikktspace, atomic_ops) | 7,3 MB | Apache-2.0 (+ BSD-3-Clause, MIT, Zlib in Teilen, SPDX-Kopfzeilen) |
| `libembree4` (Ubuntu-Build, alle Befehlssätze) | 40 MB | Apache-2.0 |
| `libOpenImageDenoise` + `_core` + `_device_cpu` 2.5.0 (Blender-Vorbau) | 47,6 MB | Apache-2.0 (enthält oneDNN, Apache-2.0, und trainierte Gewichte) |
| `libOpenImageIO` + `_Util` 2.4.17 (eigener schlanker Build) | 12,7 MB | BSD-3-Clause |
| OpenEXR, Imath, Iex, IlmThread, OpenEXRCore 3.1 | 4,9 MB | BSD-3-Clause |
| `libtbb` (oneTBB 2021) | 0,3 MB | Apache-2.0 |
| libpng16, libjpeg(-turbo), libtiff 4.5.1 (eigener Build), libz, libdeflate, libzstd, libpugixml, Boost filesystem/thread | je < 1 MB | libpng-Lizenz, IJG/BSD-3/Zlib, libtiff-Lizenz (BSD-artig), Zlib, MIT, BSD-3 (zstd, BSD-Variante der Doppellizenz), MIT, BSL-1.0 |
| **Summe** | **111 MB entpackt, 58 MB `tar.xz`** | alles permissiv, **kein GPL/LGPL** im Auslieferordner |

Weniger geht: Embree weglassen (Cycles fällt auf seinen BVH2 zurück, langsamer; nicht gemessen) oder ein eigener schlanker Embree-Build (Blenders
statischer Build ist deutlich kleiner als Ubuntus 40 MB); OIDN mit nur den gebrauchten Netzen bauen. Realistisch **~60–70 MB entpackt**, ein Teil der Arbeit
in 8.

## 4. Testszene und Messwerte

`python3 scripts/cycles/spike-scene.py haus.xml`, dann `cycles --background --samples 64 --width 1280 --height 720 --output haus.exr haus.xml`.
Haus 10 × 8 × 3 m mit Satteldach (First 5,2 m) auf 120 × 120 m Wiese; Nishita-Himmel (Sonne 38° hoch), Hintergrundlicht für den Himmel, drei
Principled-BSDF-Materialien, Kamera 45° vertikal. Zusätzlich Box-projizierte Bildtextur (`image_texture projection="box"`) in der Wand — funktioniert ohne UVs,
wie der Blender-Leser aus [211] es braucht. Bilder angesehen (EXR → sRGB mit `oiiotool`): sonnenbeschienenes Haus, scharfer Schatten, weiche Himmelsaufhellung,
entrauscht ohne sichtbare Artefakte bei 32–64 Samples.

Gemessen im Container (4 vCPU Intel Xeon 2,1 GHz, **mit anderen Containern geteilt, Lastmittel zeitweise 8 auf 4 Kernen — Wandzeit schwankt um bis zu den Faktor 2**):

| | Wandzeit ruhig | Wandzeit unter Last | CPU-Zeit |
|---|---|---|---|
| Programmstart (`--version`) | 0,02 s | | |
| bis zum 1. Sample (Szene, Himmel, BVH; 64 × 36) | 0,7 s | 0,8 s | |
| 1280 × 720, 16 Samples, mit Entrauschen | 11 s | | 39 s |
| 1280 × 720, 64 Samples, ohne Entrauschen | 45 s | 59 s | 94–100 s |
| 1280 × 720, 64 Samples, **mit Entrauschen** | **29 s** | 51 s | 109 s |
| 1280 × 720, 256 Samples, ohne Entrauschen | 86 s | 176 s | 235–283 s |
| 1280 × 720, 256 Samples, mit Entrauschen | | 147 s | 313 s |

Entrauschen kostet bei 720p etwa 6–10 s auf 4 Kernen (CPU). Faustregel für die Planung: **≈ 1–1,7 CPU-Sekunden je Sample und Megapixel** (Mittel 1,4), also 1920 × 1080 mit
128 Samples ≈ 6 CPU-Minuten ≈ 1,5 Minuten auf 4 freien Kernen. Mac-Werte (Metal, M-Serie) **nicht gemessen**; Cycles-Metal ist erfahrungsgemäss 5–20 × schneller
als eine 4-Kern-CPU (Annahme, nicht belegt).

Beim Bau der Szene gelernt (steht auch im Kopf von `spike-scene.py`):
- `<transform matrix=…>`: 16 Zahlen **spaltenweise**; die Cycles-Kamera blickt entlang **+Z**, oben = +Y (Blender spiegelt beim Export Z). Falsch = Himmel/Boden-Salat.
- Der Himmel braucht ein **Hintergrundlicht** `<state shader="default_background"><light light_type="background" use_mis="true" map_resolution="1024"/></state>`; sonst
  trifft die Sonnenscheibe nur zufällig (Lichtpunkte, grosses Rauschen). `use_mis` ist bei Lichtern im XML standardmässig AUS.
- Himmel und Sonne sind physikalisch (weisse besonnte Fläche ≈ 45): **Belichtung** über `<film exposure=…>` (Blender-Leser: ≈ −4,9 EV bei 60°). Ausgabe als EXR; ein
  PNG des Standalone ist lineares Licht in 8 Bit (zu dunkel/hart) — die Tonwert-Abbildung gehört in Dossier.
- Entrauschen: `<integrator use_denoise="true"/>` (OIDN, Albedo + Normale), kein Kommandozeilenschalter.

## 5. Mac (arm64, Metal-GPU)

`scripts/cycles/build-macos.sh` ist ein **Entwurf, nicht ausgeführt** (kein Xcode/Metal im Container).
- **Voraussetzungen**: macOS ≥ 13 (Metal-RT ab Apple M3/macOS 14; auf M1/M2 läuft Metal ohne Hardware-RT), Xcode mit SDK ≥ 12 (die Metal-Header; kein Metal-Compiler beim Bau nötig),
  `brew install cmake ninja git git-lfs`.
- **Weg A (Skript)**: `make update` holt das Submodul `lib/macos_arm64` (Blenders vorgebaute Bibliotheken: OIIO, OCIO, Embree, OIDN, TBB, OpenEXR …) per git-lfs —
  der Ordner ist gross (Repo ≈ 12 GB inkl. Historie, ausgecheckt nach Schätzung 1,5–3 GB, einmalig). Danach `cmake -G Ninja … && cmake --build . --target install`. Der Patch `no-ocio` ist
  hier nicht nötig (Vorbau hat OCIO 2.4+); die Farbräume im XML bleiben trotzdem „auto“/Non-Color, damit Linux und Mac gleiche Bilder liefern.
- **Weg B (Homebrew)**: `brew install openimageio embree tbb pugixml open-image-denoise` geht schneller, zieht aber wie unter Linux ffmpeg/GDAL … und
  wechselt mit jeder Version; für Entwicklung ok, nicht für die Auslieferung.
- **Metal-Besonderheit**: Cycles übersetzt die GPU-Kernel **zur Laufzeit** aus den Quellen im Ordner `source/` neben dem Programm (`install/source/kernel/…`, 12 MB; mitgeliefert) und
  legt das Ergebnis im Benutzer-Cache ab. Der **erste GPU-Render dauert einige Minuten** („Loading render kernels (may take a few minutes the first time)“), danach lädt es sofort.
  Die App muss das erklären (Fortschrittszeile „GPU wird vorbereitet“), beim ersten Mal auf Wunsch CPU nehmen (`--device CPU`) und den Cache-Ordner beschreibbar machen.
- **Grösse (Schätzung)**: Programm ≈ 10 MB, Bibliotheken ≈ 60–90 MB (OIDN mit Metal-Gerät, Embree arm64, OIIO) + `source/` 12 MB: **≈ 80–110 MB entpackt, 35–50 MB im DMG** — deutlich unter der Schätzung „100–200 MB“ aus dem TODO.
- **Signieren/Notarisieren**: jede Mach-O-Datei (Programm, `lib/*.dylib`) mit der Developer-ID der App signieren (`--options runtime --timestamp`); Bibliotheken per `install_name_tool`
  auf `@rpath` bzw. `@executable_path/lib`. Das Metal-Kompilieren zur Laufzeit braucht keine besondere Berechtigung. Zeitaufwand erfahrungsgemäss ½–1 Tag beim ersten Mal.
- **Zeit**: Bau auf Apple Silicon ≈ 10–20 Minuten (Schätzung).

## 6. Einbindung in die App

**Programm mitliefern**
- **Tauri (macOS)**: `bundle.externalBin: ["binaries/cycles"]` (Datei `binaries/cycles-aarch64-apple-darwin`, Sidecar-Namenskonvention) und `bundle.resources` für `lib/*` und
  `source/**`; Start über `app.shell().sidecar("cycles")` bzw. wie `blender_start` ([211], `src-tauri/src/blender.rs`: Jobs, Ereignisse, `blender_cancel`) — dieselbe Job-Verwaltung,
  nur der Programmpfad ist ein anderer. Die Bibliotheken liegen neben dem Programm (RPATH).
- **Electron (Linux)**: `extraResources` in `scripts/electron-pack.cjs` (Ordner `cycles/` mit `cycles`, `lib/`), Pfad zur Laufzeit aus `process.resourcesPath`; Start wie `blender:*` in
  `scripts/electron-blender.cjs`. AppImage: Ordner bleibt im Image (+ 58 MB).
- Reihenfolge im Dialog „Rendering…“: **Dossier (Cycles, eingebaut)** · Blender (Option, [211]); Blender-Brücke bleibt für „In Blender öffnen“ ([228]).

**Szene aus dem Kern direkt als Cycles-XML schreiben** (statt `model.glb` + `scene.json` + Python):
- Rust-Modul im Kern (`src-tauri/core/src/export/cycles_xml.rs`, Bindung über die Kern-Fassade wie die übrigen Exporte), Eingabe dieselben Netze wie der GLB-Export [201]
  (Dreiecke je Bauteil, glatte Normalen als Attribut `N`, kein UV nötig) und dieselbe `RenderScene`-Beschreibung (`doc/RENDER-SZENE.md`: Kamera, Sonne, Material-Tabelle, Rollen).
  `<mesh P= nverts= verts= N=>` je Material, ein `<shader>` je Dossier-Material.
- **Materialien**: Principled BSDF (Farbe sRGB → linear, Rauheit, Metall, IOR); Glas = Transmission 1, IOR 1,5, Schattenstrahlen durchlässig (wie [211]); Bildkarten
  als `image_texture projection="box" projection_blend=0.2` mit `mapping`-Skalierung `1/sizeM` aus Objektkoordinaten (geprüft); Rauheit/Metall `Non-Color`; Normalenkarten bleiben ohne Tangentenrahmen unbenutzt
  wie in [211] (Rauheit/Bump, [229]). Texturen als relative Pfade neben der XML-Datei.
- **Kamera**: `<transform matrix>` (spaltenweise, +Z) aus `cameraToView` / gespeicherter Kamera ([213]); Perspektive mit `fov` (vertikal, Bogenmass) bzw. `orthographic` mit `viewplane`; `camera width/height`.
- **Sonne/Himmel**: Azimut/Höhe aus dem Sonnenstand (`sun.azimuth/elevation`, Datum und Ort wie in [211]) → `sun_elevation`, `sun_rotation` des Nishita-Knotens (Drehsinn und Nullpunkt gegen den Blender-Leser prüfen: Cycles zählt die Rotation um +Z, im Test lag 150° gegenüber dem Betrachter auf der Sonnenseite),
  Hintergrundlicht wie oben, Belichtung (Blender-Leser: automatisch nach Sonnenhöhe), Nacht (Sonne unter dem Horizont) wie in [212] offen. Klasse „Rendering/Sonne“ nach [180] bleibt Modell-Sache, nichts Sichtbares im Plan.
- **Prüfung**: Rust-Test mit Snapshot der XML einer Musterszene; Render der Testszene mit dem eingebauten Programm als e2e (nur wo das Programm liegt, sonst `fixme`).

**Fortschritt, Abbruch, Ausgabe**
- Das Programm schreibt Fortschritt mit Wagenrücklauf (`\r`) auf stdout: `Progress 06.25   Sample 1/16` (Zeilen mit „Updating …“, „Loading render kernels …“, „Loading denoising kernels …“,
  „Writing image …“, „Finished Rendering.“). Der Job liest bis `\r` oder `\n` und zieht `Progress (\d+\.\d+)` — genau die Marken, die der Blender-Leser aus [211] schon als `Sample x/y` meldet; die Anzeige im Dialog bleibt gleich.
- **Abbruch** = Prozess beenden (SIGTERM/`kill`), wie `blender_cancel`; kein Aufräumen nötig (Arbeitsordner im Temp-Ordner).
- **Ausgabe**: `--output x.exr` (Gleitkomma); danach rechnet der Kern **Belichtung + Tonwert-Abbildung + sRGB → PNG** (Rust, im Kern, neben dem Bild-Export [223]) und liefert das PNG wie heute ins Layout. Der Blender-Leser nutzt AgX;
  ein Look wie dort braucht entweder AgX-Tabelle (MIT, klein) im Kern oder einen einfacheren Filmic-artigen Verlauf — Entscheid im Einbau, beide Wege kommen ohne OCIO aus.
- **Vorgabe der Arbeitsweise**: zuerst das unveränderte `cycles`-Programm. Ein eigenes dünnes Vorderteil (C++, ~300 Zeilen gegen `libcycles_*`: JSON-Fortschritt, Abbruch über stdin, Bereichs-Render, Gerätewahl, direkt PNG/EXR) nur, wenn die Textausgabe oder fehlende Schalter stören. Offen: ob das Standalone auf dem Mac mit `--device` zuverlässig die GPU wählt (Blender tut es über die Voreinstellungen).

**Entrauscher (OIDN)**: **ja.** Apache-2.0, 48 MB (davon 47 MB Gewichte), CPU-Gerät reicht (Metal-Gerät auf dem Mac optional); im XML ein Schalter, Albedo/Normale als Hilfsbilder kommen von Cycles selbst.
Entrauschte 64 Samples (29 s) sehen besser aus als rohe 256 (86 s). Standard: an; für „Rohbild“ aus.

## 7. Vergleich mit Alternativen

| | Cycles eingebaut (hier) | Eigener Pathtracer [212] zum Endbild ausbauen | Blender-Brücke [211] (bleibt) |
|---|---|---|---|
| Bildqualität | Produktionsstand (Nishita-Himmel, Principled BSDF, Glas, MIS, OIDN) | Vorschau-Güte; für Endbilder fehlen u. a. Texturen/Kacheln, Nishita-Parität, ordentlich entrauschen (OIDN ist C++; im Browser nur Eigenbau), Lichtbaum, Glas-Feinheiten | wie Cycles |
| läuft im Browser | nein (Programm) | ja (WebGPU) | nein |
| Ohne Fremdinstallation | ja | ja | nein (Blender nötig) |
| App-Grösse | + 35–60 MB (komprimiert) | + 0 | + 0 |
| Pflege | Bauskripte, Cycles-Version nachziehen, Mac-CI | Dossier-Code, wächst mit | Skript für Blender-Versionen |
| Aufwand bis Endbild-Qualität | **11–15 Tage** (s. 8.) | **~25–40 Tage**, Qualitätsrisiko bleibt | schon da |

**Empfehlung**: Cycles einbauen (der Weg mit dem kleinsten Risiko und der besten Bildqualität), [212] als schnelle Vorschau im Viewport und im Browser weiterführen, Blender-Brücke als Option für Leute,
die ohnehin Blender haben und für [228]. Den Pathtracer **nicht** zum Endbild-Renderer ausbauen.

## 8. Aufwand (Tage, grob; „M“ = nur mit dem Maintainer-Mac prüfbar)

1. Bauskripte in CI, Linux-Paket im AppImage, Portabilität (älterer Unterbau), Version festlegen: **2**
2. Mac-Build (Metal, `source/`, Cache, Signieren/Notarisieren, Tauri-Sidecar): **3** (M)
3. Kern: XML-Schreiber (Netze, Materialien, Texturen, Glas, Kamera, Sonne/Himmel, Belichtung) mit Tests: **4–5**
4. Job-Verwaltung (Start, Fortschritt, Abbruch) auf das neue Programm, Dialog, CLI `dossier-cli … cycles`: **1–2**
5. Nachbearbeitung im Kern (EXR lesen, Tonwert, PNG, Layout), Entrauschen-Schalter: **1–2**
6. Feinschliff: Fehlerfälle (kein Speicher, Szene leer), erster-Start-Hinweis Metal, Pfade, e2e, Handbuch, `NOTICE`: **1–2**

Summe **12–16 Tage**, davon **≈ 5 Tage Mac-abhängig**. Verkleinern der Auslieferung (eigener Embree, OIDN-Teilmenge) ist ein späterer Zusatz von 1–2 Tagen.

## 9. Offen / nicht geprüft

- Der Mac-Build (nichts davon ausgeführt), Metal-Renderzeiten und die Kernel-Übersetzungszeit beim ersten Start.
- Älterer Linux-Unterbau (glibc), Windows (laut TODO nicht in 1.0).
- Embree-Wirkung (an/aus) und ein kleinerer Embree/OIDN-Build.
- Rendern grosser Modelle (Millionen Dreiecke): XML-Lesen und Speicher nicht gemessen; ggf. `<mesh>`-Dateien binär über ein eigenes Vorderteil.
- Tonwert-Look gegen den Blender-Leser (AgX) und Sonnen-Drehsinn gegen `render_dossier.py`.
- Hosts im Cloud-Container: gesperrt war `github.com` (alle Pfade, auch `codeload`, `api.github.com`, Release-Downloads; `raw.githubusercontent.com` und `pypi.org` gingen); gebraucht wurden nur
  `projects.blender.org` (Quellen, OIDN-LFS) und `archive.ubuntu.com` (OIIO-/libtiff-Quellen, apt).

## 10. Bau, CI und Auslieferung (Teil 2, 16.11.)

**Ablauf.** `.github/workflows/cycles.yml` (manuell und bei Änderung von `scripts/cycles/**`) baut Cycles je Plattform und legt
`cycles-<os>-<arch>-<version>.tar.xz` (+ `.sha256`) ab: als Artefakt des Laufs und als Asset am Gitea-Release `cycles-<version>` auf
`git.openbureau.ch/karim/dossier` (Vorabversion, aber veröffentlicht, damit ohne Token ladbar; Secret `GITEA_TOKEN`, sonst nur Artefakt).
GitHub ist nur Bau-Rechner. Die Version steht an einer Stelle: `scripts/cycles/VERSION` (Tag `v<version>` der Cycles-Quellen, Paketname,
Gitea-Release). `release.yml` ruft vor dem App-Bau `scripts/cycles/get.sh <os> <arch>` auf: zuerst der Gitea-Anhang (`fetch.mjs`, mit
Prüfsumme), bei 404 das Artefakt des letzten erfolgreichen `cycles.yml`-Laufs (`gh run download`); Ergebnis `build/cycles/` (gitignoriert).
Neue Cycles-Version = `VERSION` ändern, `cycles.yml` laufen lassen, dann Release.

| Datei | Zweck |
|---|---|
| `scripts/cycles/build-linux.sh` | Linux x86_64 CPU (geprüft), seit Teil 2 mit Lizenztexten (`licenses/`) und `VERSION` im Paket |
| `scripts/cycles/build-macos.sh` | macOS arm64 (Metal + CPU), Blender-Vorbau (`make update`, git-lfs): sammelt Nicht-System-Dylibs über `otool -L` ein, setzt `@rpath`/RPATH, Ad-hoc-Signatur, `source/` (Metal-Kernel), Lizenzen. **Nicht ausgeführt** |
| `scripts/cycles/smoke.sh` | Rauchtest nach dem Bau: 4 Samples Testszene (CPU) → PNG + `Sample 4/4` (auf Linux gelaufen: 1 s) |
| `scripts/cycles/pack.sh` | `tar.xz` + `.sha256`, Wurzel im Archiv `cycles/` |
| `scripts/cycles/upload-gitea.mjs`, `fetch.mjs`, `get.sh`, `cycles-lib.cjs` | Ablage am Gitea-Release, Laden/Entpacken, Rückfall auf das Artefakt, Namensschema (Test `src/native/cyclesPackage.test.ts`) |
| `scripts/cycles/THIRD-PARTY.txt` | Bestandteile und Lizenzen, kommt als `licenses/README.txt` ins Paket; `NOTICE` führt dieselbe Liste |

**Paketaufbau** (`cycles/`): `cycles` (Programm), `lib/` (Bibliotheken, RPATH `$ORIGIN/lib` bzw. `@executable_path/lib`), `licenses/`
(Cycles-LICENSE, Apache-2.0, `*-license.txt` der Cycles-Teile, `debian/<paket>.copyright`, OpenImageIO, libtiff), `VERSION`; macOS zusätzlich `source/`
(Metal-Kernel-Quellen). Cycles liest `source/` über die Umgebungsvariable **`CYCLES_KERNEL_PATH`** (`src/util/path.cpp`); die App setzt sie beim Start
auf den mitgelieferten Ordner, `source/` muss also nicht neben dem Programm liegen.

**Linux/Electron.** `electron-builder.yml` führt `scripts/electron-cycles.cjs` in `files`; `scripts/electron-pack.cjs` trägt den Paketordner als
`extraResources` (`from` → `cycles/`) ein: `--cycles=ORDNER`, sonst Umgebungsvariable `DOSSIER_CYCLES_DIR` (lokaler Ordner statt CI-Download, z. B. `dist/` von
`build-linux.sh`), sonst `build/cycles`; ohne alles entsteht ein Paket ohne Cycles (Warnung), mit `DOSSIER_REQUIRE_CYCLES=1` (Release-CI) ein Fehler.
Im AppImage liegt es unter `resources/cycles/` (aussen vor dem asar, ausführbar). Der Hauptprozess (`electron-cycles.cjs`) startet nur
`<resources>/cycles/cycles` — ohne Shell, `cwd` = Arbeitsordner, Argumente geprüft (feste Schalterliste `--background --quiet --samples --width --height --tile-size
--threads --device --log-level --output`, Wertebereiche, genau eine `*.xml`, Dateien nur unter `$TMP/dossier-render/…`). Preload: `window.dossierCycles`
(`where`, `prepare`, `start`, `cancel`, `readFile`, `onLine`, `onExit`). Im ungepackten Lauf: `DOSSIER_CYCLES_DIR` oder `build/cycles`; im gepackten gibt es keine Umlenkung.

**macOS/Tauri.** `src-tauri/tauri.cycles.conf.json` (Überlagerung, damit `cargo`/`tauri dev` ohne Cycles bauen): `bundle.externalBin: ["binaries/cycles"]` und
`bundle.resources` für `lib/`, `source/`, `licenses/` → `Contents/Resources/cycles/…`. `scripts/cycles/tauri-prepare.mjs` legt das arm64-Programm als
`src-tauri/binaries/cycles-{aarch64,x86_64,universal}-apple-darwin` ab (die Release-App ist universal; x86_64/universal sind nur Kopien, damit der Bau durchläuft);
`scripts/tauri-native.mjs` hängt die Überlagerung an `tauri build`, sobald die Sidecars da sind. Das Programm hat zwei RPATHs: `@executable_path/lib` (Paket) und
`@executable_path/../Resources/cycles/lib` (App). Laufzeit: Rust-Befehle `cycles_where` (Sidecar neben dem App-Programm; auf Intel-Macs `None`), `cycles_job_dir`,
`cycles_start`, `cycles_cancel` in `src-tauri/src/lib.rs`, Logik und Argumentprüfung in `src-tauri/src/cycles.rs` (std-only, `rustc --test`), Start über
`blender::start_program` (gemeinsame Job-Verwaltung mit der Blender-Brücke), Ereignisse `cycles://line` / `cycles://exit`.

**Fassade** `src/native/cyclesRuntime.ts` (gleiche Signaturen für beide): `cyclesAvailable()`, `prepareCyclesScene(files)` → Arbeitsordner, `runCycles(sceneDir, args, onProgress, signal)`
→ `{code, cancelled, lines}` (Fortschritt `Progress … Sample n/N`, `\r`-getrennt; `signal` beendet den Prozess), `readCyclesFile(path)`, `parseCyclesProgress(line)`. Browser: `false`.
Der Aufrufer (Dialog „Rendering“, später) schreibt `szene.xml` + Texturen, ruft z. B. `["--background","--samples","64","--output","bild.png","szene.xml"]` und liest `bild.png`.

**Grösse** (Linux, gemessen 16.11.): AppImage ohne Cycles 193 944 150 Byte (185 MiB), mit dem Spike-Paket (111 MB entpackt) 264 189 246 Byte (252 MiB): **+ 70,2 MB** (SquashFS-Kompression im Image; das Paket liegt
entpackt in `resources/cycles/`, nichts wird beim Start entpackt). macOS-Zahlen: offen.

**Geprüft (16.11., Linux-Container):** vitest (`src/native/cyclesRuntime|electronCycles|cyclesPackage.test.ts`: Fortschritt, Abbruch, Argumentprüfung, Ordnerwahl, Prozessstart mit Ersatzprogramm,
Workflow-Aufbau), `rustc --test` für `cycles.rs` und `blender.rs`, `smoke.sh` gegen das Spike-Paket, **echtes AppImage** (mit dem Spike-Paket gebaut): `npm run test:linux-app` — `cyclesAvailable()` true,
`runCycles` rendert `e2e/fixtures/cycles-haus.xml` (320 × 180, 8 Samples, OIDN) zu einem PNG mit Fortschritt `Sample 8/8`, Abbruch beendet den Prozess (kein Rest), fremde Argumente werden abgewiesen.
Workflows nur mit `yaml.safe_load` auf Syntax geprüft.
**Nicht geprüft:** beide GitHub-Workflows (laufen im Container nicht, `github.com` gesperrt), `build-macos.sh` und alles auf dem Mac (Bau, `make update`, Dylib-Einsammeln, RPATHs, Metal-Kernel,
`cycles_*`-Befehle: die Tauri-App ist im Container nicht übersetzbar, es fehlt webkit2gtk — nur die std-Teile liefen als Test), Tauri-Resources-Syntax (Verzeichnis → Verzeichnis), Signieren/Notarisieren der Mach-O-Dateien
unter `Resources/cycles/lib` und des Sidecars, universale App mit arm64-Sidecar, `build-linux.sh` Schritt (7) (Lizenzen) nur in Teilen (dpkg-Zuordnung geprüft, kein ganzer Bau), Portabilität auf ältere glibc.
