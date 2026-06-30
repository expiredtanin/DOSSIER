import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Sicherheitsnetz: fängt Render-Fehler ab, statt die Seite weiß zu lassen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(t("error.console"), error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <h1>{t("error.title")}</h1>
          <p>{t("error.body")}</p>
          <pre>{this.state.error.message}</pre>
          <button onClick={() => location.reload()}>{t("error.reload")}</button>
        </div>
      );
    }
    return this.props.children;
  }
}
