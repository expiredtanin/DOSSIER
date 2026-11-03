import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";
import { coreReady, isCoreRestartError } from "../engine/coreWasm";

/** Kern-Neustarts ([118]), nach denen der Baum von selbst neu aufgebaut wird; mehr in kurzer Zeit = Fehlerseite. */
const CORE_RETRIES = 3;
const CORE_RETRY_WINDOW_MS = 30_000;

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  /** Kern-Neustart abwarten statt Fehlerseite ([118]). */
  waiting?: boolean;
}

/** Sicherheitsnetz: fängt Render-Fehler ab, statt die Seite weiß zu lassen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private coreRetries: number[] = [];

  static getDerivedStateFromError(error: Error): State {
    return { error, waiting: isCoreRestartError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(t("error.console"), error, info);
    if (!isCoreRestartError(error)) return;
    // Kern-Panic beim Rendern ([118]): der Kern startet neu und öffnet das Projekt wieder; danach den
    // Baum neu aufbauen (der Store mit dem Projekt bleibt) statt die Fehlerseite zu zeigen — ausser
    // der Panic kommt in kurzer Zeit immer wieder (dann Fehlerseite, keine Schleife).
    const now = Date.now();
    this.coreRetries = this.coreRetries.filter((at) => at + CORE_RETRY_WINDOW_MS > now);
    if (this.coreRetries.length >= CORE_RETRIES) {
      this.setState({ waiting: false });
      return;
    }
    this.coreRetries.push(now);
    void coreReady().then(() => this.setState({ error: null, waiting: false }));
  }

  render(): ReactNode {
    if (this.state.error && this.state.waiting) return <div className="error-screen">{t("core.restarting")}</div>;
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
