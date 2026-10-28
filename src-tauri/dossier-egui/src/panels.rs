// Seitenpanels: Geschosse (aktives Geschoss, Sichtbarkeit im 3D), Eigenschaften des gewählten
// Bauteils (nur Anzeige) und Flächenbilanz/Kennzahlen aus dem Ansichtspaket.

use egui::{Color32, RichText};

use crate::app::{Selection, State};
use crate::bundle::PropValue;
use crate::i18n::{t, tr};

fn section(ui: &mut egui::Ui, title: &str) {
    ui.add_space(4.0);
    ui.label(RichText::new(title).small().strong().color(ui.visuals().weak_text_color()));
    ui.add_space(2.0);
}

fn fmt_m(v: f64) -> String {
    format!("{v:.2} m")
}
fn fmt_m2(v: f64) -> String {
    format!("{v:.1} m²")
}

pub fn levels(ui: &mut egui::Ui, st: &mut State) {
    let Some(doc) = st.doc.as_ref() else {
        ui.weak(t("levels.none"));
        return;
    };
    let mut changed_active = None;
    let mut changed_vis = false;
    section(ui, &t("levels.active"));
    // Oberstes Geschoss oben, wie in der TSX-App.
    for (i, l) in doc.bundle.levels.iter().enumerate().rev() {
        ui.horizontal(|ui| {
            let mut vis = st.visible3d.get(i).copied().unwrap_or(true);
            if ui.checkbox(&mut vis, "").on_hover_text(t("levels.visible_3d")).changed() {
                if let Some(v) = st.visible3d.get_mut(i) {
                    *v = vis;
                }
                changed_vis = true;
            }
            let active = st.active_level == i;
            let text = RichText::new(&l.name).strong();
            if ui.selectable_label(active, text).clicked() && !active {
                changed_active = Some(i);
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.weak(format!("{:+.2}", l.elevation));
            });
        });
    }
    if doc.bundle.context3d.is_some() {
        ui.separator();
        if ui.checkbox(&mut st.context_visible, t("levels.context")).changed() {
            changed_vis = true;
        }
    }
    let sketch_n = st.sketch.len();
    if sketch_n > 0 {
        ui.separator();
        ui.weak(format!("{}: {sketch_n}", t("sketch.count")));
    }
    if let Some(i) = changed_active {
        st.set_active_level(i);
    }
    if changed_vis {
        st.view3d.invalidate_model();
    }
}

fn prop_row(ui: &mut egui::Ui, key: &str, value: String) {
    ui.label(RichText::new(key).color(ui.visuals().weak_text_color()));
    ui.label(value);
    ui.end_row();
}

fn prop_value(key: &str, v: &PropValue) -> String {
    match v {
        PropValue::Num(n) => match key {
            "area" => fmt_m2(*n),
            "pitch" => format!("{n:.1}°"),
            "steps" => format!("{n:.0}"),
            _ => fmt_m(*n),
        },
        PropValue::Text(s) => tr(&format!("kind.{s}")).map(str::to_owned).unwrap_or_else(|| s.clone()),
    }
}

pub fn properties(ui: &mut egui::Ui, st: &mut State) {
    let Some(doc) = st.doc.as_ref() else {
        ui.weak(t("levels.none"));
        return;
    };
    match st.selection {
        None => {
            ui.add_space(6.0);
            ui.weak(t("props.none"));
        }
        Some(Selection::Element { level, index }) => {
            let Some(l) = doc.bundle.levels.get(level) else { return };
            let Some(e) = l.elements.get(index) else { return };
            let kind = tr(&format!("kind.{}", e.kind)).map(str::to_owned).unwrap_or_else(|| e.kind.clone());
            ui.add_space(4.0);
            ui.heading(&kind);
            if !e.label.is_empty() && e.label != e.kind && e.label != e.id {
                ui.label(&e.label);
            }
            ui.add_space(6.0);
            egui::Grid::new("props").num_columns(2).spacing([14.0, 6.0]).striped(true).show(ui, |ui| {
                prop_row(ui, &t("props.id"), e.id.clone());
                prop_row(ui, &t("props.level"), l.name.clone());
                for (k, v) in &e.props {
                    let label = tr(&format!("prop.{k}")).map(str::to_owned).unwrap_or_else(|| k.clone());
                    prop_row(ui, &label, prop_value(k, v));
                }
            });
            ui.add_space(10.0);
            ui.weak(t("props.readonly"));
        }
        Some(Selection::Sketch(i)) => {
            let Some(w) = st.sketch.get(i) else { return };
            ui.add_space(4.0);
            ui.heading(t("kind.sketch"));
            ui.add_space(6.0);
            egui::Grid::new("props-sketch").num_columns(2).spacing([14.0, 6.0]).striped(true).show(ui, |ui| {
                prop_row(ui, &t("prop.length"), fmt_m(crate::geom::seg_len(w.a, w.b) as f64));
                prop_row(ui, &t("prop.thickness"), fmt_m(w.thickness as f64));
                if let Some(l) = doc.bundle.levels.get(w.level) {
                    prop_row(ui, &t("props.level"), l.name.clone());
                }
            });
        }
    }
}

pub fn areas(ui: &mut egui::Ui, st: &mut State) {
    let Some(doc) = st.doc.as_ref() else {
        ui.weak(t("levels.none"));
        return;
    };
    let Some(k) = doc.bundle.kennzahlen.as_ref() else {
        ui.weak(t("areas.none"));
        return;
    };
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        section(ui, &t("areas.building"));
        egui::Grid::new("kz").num_columns(2).spacing([14.0, 6.0]).striped(true).show(ui, |ui| {
            prop_row(ui, &t("areas.gf"), fmt_m2(k.gf));
            prop_row(ui, &t("areas.agf"), fmt_m2(k.agf));
            prop_row(ui, &t("areas.footprint"), fmt_m2(k.footprint));
            if k.gv > 0.0 {
                prop_row(ui, &t("areas.gv"), format!("{:.0} m³", k.gv));
            }
            prop_row(ui, &t("areas.az"), k.az.map(|v| format!("{v:.2}")).unwrap_or_else(|| "—".into()));
            prop_row(ui, &t("areas.uez"), k.uez.map(|v| format!("{v:.2}")).unwrap_or_else(|| "—".into()));
        });

        section(ui, &t("areas.per_level"));
        egui::Grid::new("kz-levels").num_columns(4).spacing([14.0, 6.0]).striped(true).show(ui, |ui| {
            let weak = ui.visuals().weak_text_color();
            ui.label("");
            ui.label(RichText::new("GF").color(weak));
            ui.label(RichText::new("aGF").color(weak));
            ui.label(RichText::new(t("areas.rooms")).color(weak));
            ui.end_row();
            for l in k.levels.iter().rev() {
                ui.label(&l.name);
                ui.label(fmt_m2(l.gf));
                ui.label(fmt_m2(l.agf));
                ui.label(l.rooms.to_string());
                ui.end_row();
            }
        });

        if let Some(p) = doc.bundle.raumprogramm.as_ref() {
            section(ui, &t("areas.program"));
            if p.rows.is_empty() {
                ui.weak(t("areas.program_empty"));
            } else {
                egui::Grid::new("prog").num_columns(4).spacing([12.0, 6.0]).striped(true).show(ui, |ui| {
                    let weak = ui.visuals().weak_text_color();
                    ui.label("");
                    ui.label(RichText::new(t("areas.target")).color(weak));
                    ui.label(RichText::new(t("areas.actual")).color(weak));
                    ui.label("");
                    ui.end_row();
                    for r in &p.rows {
                        ui.label(&r.name);
                        ui.label(format!("{} × {}", r.target_count, fmt_m2(r.target_area)));
                        ui.label(format!("{} × {}", r.count, fmt_m2(r.area)));
                        let (col, txt) = match r.status.as_str() {
                            "ok" => (Color32::from_rgb(0x2e, 0x9d, 0x55), t("status.ok")),
                            // Status-Texte kommen deutsch aus `checkRoomProgram` (ProgramStatus).
                            "fehlt" => (Color32::from_rgb(0xd0, 0x3b, 0x3b), t("status.missing")),
                            "zu klein" => (Color32::from_rgb(0xd9, 0x8a, 0x1c), t("status.under")),
                            "zu gross" => (Color32::from_rgb(0xd9, 0x8a, 0x1c), t("status.over")),
                            "zu wenige" => (Color32::from_rgb(0xd9, 0x8a, 0x1c), t("status.too_few")),
                            "zu viele" => (Color32::from_rgb(0xd9, 0x8a, 0x1c), t("status.too_many")),
                            s => (ui.visuals().text_color(), s.to_string()),
                        };
                        ui.label(RichText::new(txt).color(col));
                        ui.end_row();
                    }
                });
            }
            if !p.extra.is_empty() {
                section(ui, &t("areas.extra"));
                egui::Grid::new("prog-extra").num_columns(2).spacing([14.0, 6.0]).striped(true).show(ui, |ui| {
                    for r in &p.extra {
                        ui.label(&r.name);
                        ui.label(fmt_m2(r.area));
                        ui.end_row();
                    }
                });
            }
        }
    });
}
