// dossier-egui — Dossier als native egui-App (Probe, s. README.md).
//
//   dossier-egui [datei.json | projekt.obp | --beispiel] [Optionen]
//
//   datei.json     Ansichtspaket (`dossier-cli projekt.obp bundle`), `model3d` oder `plan --format json`
//   projekt.obp    über die CLI (`node dist-cli/dossier-cli.mjs … bundle`), wenn Node und die CLI da sind
//   --beispiel     eingebautes Demo-Haus über die CLI (Standard ohne Datei)
//   --theme light|dark|system   --lang de|en   --size 1440x900
//   --screenshot aus.png [--tab 3d] [--select <id>] [--sketch-demo] [--areas]   Bild speichern und beenden

use std::path::PathBuf;

use egui::ThemePreference;

mod app;
mod bundle;
mod geom;
mod i18n;
mod loader;
mod offscreen;
mod panels;
mod plan_view;
mod theme;
mod view3d;

use app::{DossierApp, Scripted, Source, StartOptions};

fn main() -> eframe::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| -> Option<String> { args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned()) };
    let has = |name: &str| args.iter().any(|a| a == name);

    i18n::set_lang(match flag("--lang").as_deref() {
        Some(l) if l.starts_with("en") => i18n::Lang::En,
        Some(_) => i18n::Lang::De,
        None => i18n::lang_from_env(),
    });
    let theme = match flag("--theme").as_deref() {
        Some("light") => ThemePreference::Light,
        Some("dark") => ThemePreference::Dark,
        _ => ThemePreference::System,
    };
    let size = flag("--size")
        .and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse::<f32>().ok()?, h.parse::<f32>().ok()?))))
        .unwrap_or((1440.0, 900.0));

    // Erstes Argument ohne „--", das nicht Wert einer Option ist.
    let valued = ["--theme", "--lang", "--size", "--screenshot", "--tab", "--select"];
    let file = args
        .iter()
        .enumerate()
        .find(|(i, a)| !a.starts_with("--") && (*i == 0 || !valued.contains(&args[i - 1].as_str())))
        .map(|(_, a)| PathBuf::from(a));
    let source = match file {
        Some(p) => Some(Source::File(p)),
        None if has("--beispiel") || loader::find_cli().is_some() => Some(Source::Example),
        None => None,
    };

    let scripted = Scripted {
        screenshot: flag("--screenshot").map(PathBuf::from),
        focus_3d: flag("--tab").as_deref() == Some("3d"),
        focus_areas: has("--areas"),
        select: flag("--select"),
        sketch_demo: has("--sketch-demo"),
    };

    let mut wgpu_options = egui_wgpu::WgpuConfiguration::default();
    if let egui_wgpu::WgpuSetup::CreateNew(create) = &mut wgpu_options.wgpu_setup {
        // Die Engines brauchen mehr als die WebGL2-Grenzen, die egui für GL vorgibt:
        // Grenzen des Adapters übernehmen.
        create.device_descriptor = std::sync::Arc::new(|adapter: &wgpu::Adapter| wgpu::DeviceDescriptor {
            label: Some("dossier-egui"),
            required_features: wgpu::Features::empty(),
            required_limits: adapter.limits(),
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::Off,
        });
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Dossier")
            .with_inner_size([size.0, size.1])
            .with_min_inner_size([720.0, 480.0]),
        renderer: eframe::Renderer::Wgpu,
        wgpu_options,
        ..Default::default()
    };
    eframe::run_native(
        "Dossier",
        options,
        Box::new(move |cc| Ok(Box::new(DossierApp::new(cc, StartOptions { source, theme, scripted })))),
    )
}
