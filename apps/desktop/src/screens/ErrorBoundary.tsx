import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Icon } from '@aura/ui';

interface Props { children: ReactNode; fallback?: ReactNode; onError?: (error: Error) => void }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="mx-auto max-w-lg px-8 py-20 text-center">
        <Icon name="cpu" size={32} className="mx-auto text-text-subtle" />
        <h2 className="mt-4 text-[18px] font-semibold text-text">Unable to load AI Settings</h2>
        <p className="mt-2 text-[13px] text-text-muted">
          Something went wrong while rendering this page. This is usually a temporary issue.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button variant="secondary" icon="close" onClick={() => this.setState({ error: null })}>Retry</Button>
        </div>
        {this.state.error && (
          <details className="mt-6 text-left">
            <summary className="cursor-pointer text-[12px] text-text-subtle">Error details</summary>
            <pre className="mt-2 overflow-auto rounded-xl bg-surface-active p-4 text-[11px] text-text-muted">{this.state.error.message}</pre>
          </details>
        )}
      </div>
    );
  }
}
