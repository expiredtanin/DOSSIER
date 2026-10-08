// Eine Popover-Swatch-Zelle — geteilt von `PenColorField.tsx` (Stift-Raster)
// und `FreeColorPicker.tsx` (freie Palette/RAL-Raster), damit beide nicht
// gegenseitig voneinander importieren müssen.

export function Swatch({
  color,
  active,
  title,
  label,
  onClick,
}: {
  color: string;
  active: boolean;
  title: string;
  label?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`pen-color-cell${active ? " active" : ""}`}
      style={{ background: color }}
      title={title}
      onClick={onClick}
    >
      {label && <span className="pen-color-cell-num">{label}</span>}
    </button>
  );
}
