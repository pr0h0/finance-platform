import { Component, type ReactNode } from 'react';
import { useApp } from '../app/store.ts';
import { Button, Notice } from '../components/ui/index.tsx';
import { translate } from '../lib/i18n.ts';

/** Keeps the shell usable when one page throws. */
export class RouteError extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const lang = useApp.getState().prefs.language;
    const t = (k: string, en: string) => translate(lang, k, en);
    return (
      <div className="flex flex-col items-start gap-3">
        <Notice
          tone="neg"
          role="alert"
          title={t('shell.routeError.thisPageFailedTo', 'This page failed to load')}
        >
          {this.state.error.message}
        </Notice>
        <Button onClick={() => this.setState({ error: null })}>
          {t('shell.routeError.tryAgain', 'Try again')}
        </Button>
      </div>
    );
  }
}
