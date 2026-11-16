// [263] Overlay-Dialog „Kurzanleitung“ (Hilfe-Menü, Browser/Electron und natives Menü): der Inhalt von
// doc/KURZANLEITUNG.md, beim Build gebündelt (`?raw`, Bilder als Assets) — kein Netz. Die Anleitung ist deutsch
// (die Oberfläche übersetzt sie nicht); kein window.alert.

import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import guideMd from "../../doc/KURZANLEITUNG.md?raw";
import { t } from "../i18n";
import { setQuickGuideOpener } from "../state/helpMenuHook";
import { useModalFocus } from "./modalFocus";
import { parseMarkdown, type Block, type Inline } from "./miniMarkdown";

const IMAGES = import.meta.glob("../../doc/kurzanleitung/*.png", { query: "?url", import: "default", eager: true }) as Record<string, string>;

function imageUrl(src: string): string | undefined {
  return IMAGES[`../../doc/${src}`];
}

function inline(parts: Inline[]): ReactNode {
  return parts.map((p, i) => {
    switch (p.t) {
      case "b":
        return <strong key={i}>{p.s}</strong>;
      case "i":
        return <em key={i}>{p.s}</em>;
      case "code":
        return <code key={i}>{p.s}</code>;
      default:
        return <Fragment key={i}>{p.s}</Fragment>;
    }
  });
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "h":
      return b.level === 1 ? <h2 key={i}>{inline(b.inl)}</h2> : b.level === 2 ? <h3 key={i}>{inline(b.inl)}</h3> : <h4 key={i}>{inline(b.inl)}</h4>;
    case "p":
      return <p key={i}>{inline(b.inl)}</p>;
    case "quote":
      return <blockquote key={i}>{inline(b.inl)}</blockquote>;
    case "ul":
      return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>;
    case "ol":
      return <ol key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>;
    case "hr":
      return <hr key={i} />;
    case "img": {
      const url = imageUrl(b.src);
      return url ? <img key={i} src={url} alt={b.alt} loading="lazy" /> : null;
    }
  }
}

export const QuickGuideDialogHost = memo(function QuickGuideDialogHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setQuickGuideOpener(() => setOpen(true));
    return () => setQuickGuideOpener(null);
  }, []);
  const dialogRef = useModalFocus({ onEscape: () => setOpen(false) });
  const blocks = useMemo(() => (open ? parseMarkdown(guideMd) : []), [open]);
  if (!open) return null;
  return (
    <div className="imp-overlay" onClick={() => setOpen(false)}>
      <div
        ref={dialogRef}
        className="imp-dialog quick-guide"
        role="dialog"
        aria-modal="true"
        aria-label={t("help.guide.title")}
        data-testid="quick-guide"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("help.guide.title")}</span>
          <button className="imp-close" onClick={() => setOpen(false)} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body quick-guide-body" tabIndex={0}>
          {blocks.map(renderBlock)}
        </div>
      </div>
    </div>
  );
});
