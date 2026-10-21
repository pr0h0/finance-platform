import { Component, type ReactNode } from 'react';
import { Button, Notice } from '../components/ui/index.tsx';

/** Keeps the shell usable when one page throws. */
export class RouteError extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-start gap-3">
        <Notice tone="neg" role="alert" title="This page failed to load">
          {this.state.error.message}
        </Notice>
        <Button onClick={() => this.setState({ error: null })}>Try again</Button>
      </div>
    );
  }
}
