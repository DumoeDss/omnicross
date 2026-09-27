/**
 * ErrorBoundary — the last line of defense for the webview.
 *
 * The shell mounts the whole dashboard as one React root with no route-level
 * isolation, so an uncaught render error used to unmount the tree and leave a
 * blank window (the "clicked 图像 and the entire UI disappeared" field reports:
 * `undefined.map` on the Images page took the app down for every user without
 * a Codex account). This boundary keeps the window alive with an honest
 * fallback + reload instead.
 *
 * Class component on purpose — React still exposes error boundaries only
 * through the legacy API. The wrapper below is what callers import so the
 * fallback copy can go through useTranslation like the rest of the UI.
 */

import { AlertTriangle } from 'lucide-react';
import React from 'react';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/shared/state/LocaleContext';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: (error: unknown, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] uncaught render error', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: undefined });
  };

  render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}

export function AppErrorBoundary({ children }: { children: React.ReactNode }) {
  const t = useTranslation();
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div className="flex h-screen w-screen items-center justify-center bg-background p-6 text-foreground">
          <div className="w-full max-w-md space-y-4 rounded-xl border border-destructive/40 bg-surface-0 p-6">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <h1 className="text-base font-semibold">{t('errorBoundary.title')}</h1>
            </div>
            <p className="text-sm text-muted-foreground">{t('errorBoundary.description')}</p>
            <pre className="max-h-40 overflow-auto rounded-md bg-surface-2/60 p-3 text-xs text-muted-foreground">
              {error instanceof Error ? error.message : String(error)}
            </pre>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
                {t('errorBoundary.reload')}
              </Button>
              <Button size="sm" onClick={reset}>
                {t('errorBoundary.retry')}
              </Button>
            </div>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
