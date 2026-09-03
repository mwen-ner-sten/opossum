import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error?: Error;
}

/** Keeps a rendering fault in one workspace from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="boot-screen" role="alert">
        <h1>OPOSSUM hit a display error</h1>
        <p>Monitoring continues in the background. Reload the window to recover the interface.</p>
        <pre className="error-detail">{this.state.error.message}</pre>
        <button className="button primary" onClick={() => location.reload()}>
          Reload window
        </button>
      </main>
    );
  }
}
