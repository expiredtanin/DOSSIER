// Offscreen-Ziel für die Engines: eine wgpu-Textur auf DEMSELBEN Device wie egui (eframe teilt
// es über `egui_wgpu::RenderState`), bei egui als „native" Textur registriert. Die Engine rendert
// mit ihrem eigenen Render-Pass hinein (MSAA-Auflösung inklusive), egui zeigt sie als Bild —
// keine Kopie über die CPU, kein zweites Device.
//
// Farbräume: render2d schreibt Farbwerte unverändert (für Rgba8Unorm gemacht, s. render2d
// `headless::COLOR_FORMAT`), egui erwartet beim Abtasten lineare Werte. Deshalb rendert der
// Grundriss in eine Rgba8Unorm-Textur und egui tastet sie über eine Rgba8UnormSrgb-Sicht ab
// (`view_formats`). render3d rendert direkt nach Rgba8UnormSrgb (wie `render_png`).

pub struct Offscreen {
    texture: wgpu::Texture,
    /// Sicht, in die die Engine rendert.
    pub render_view: wgpu::TextureView,
    pub size: [u32; 2],
    pub tex_id: egui::TextureId,
}

impl Offscreen {
    /// Legt das Ziel an bzw. passt es an `size` (Gerätepixel) an. Gibt true zurück, wenn neu.
    pub fn ensure(
        slot: &mut Option<Offscreen>,
        rs: &egui_wgpu::RenderState,
        size: [u32; 2],
        render_format: wgpu::TextureFormat,
        sample_format: wgpu::TextureFormat,
        label: &str,
    ) -> bool {
        let max = rs.device.limits().max_texture_dimension_2d;
        let size = [size[0].clamp(1, max), size[1].clamp(1, max)];
        if slot.as_ref().is_some_and(|o| o.size == size) {
            return false;
        }
        let view_formats: &[wgpu::TextureFormat] = if sample_format != render_format { &[sample_format] } else { &[] };
        let texture = rs.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: render_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats,
        });
        let render_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let sample_view = texture.create_view(&wgpu::TextureViewDescriptor { format: Some(sample_format), ..Default::default() });
        let mut renderer = rs.renderer.write();
        let tex_id = match slot.take() {
            Some(old) => {
                renderer.update_egui_texture_from_wgpu_texture(&rs.device, &sample_view, wgpu::FilterMode::Linear, old.tex_id);
                old.texture.destroy();
                old.tex_id
            }
            None => renderer.register_native_texture(&rs.device, &sample_view, wgpu::FilterMode::Linear),
        };
        *slot = Some(Offscreen { texture, render_view, size, tex_id });
        true
    }
}

/// Gerätepixel für ein Rechteck in Punkten.
pub fn device_size(rect: egui::Rect, ppp: f32) -> [u32; 2] {
    [((rect.width() * ppp).round().max(1.0)) as u32, ((rect.height() * ppp).round().max(1.0)) as u32]
}
