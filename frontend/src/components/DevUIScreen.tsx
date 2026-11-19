// Dev-only component matrix shell (QA-X-31 / design QA appendix F).
//
// Reachability: `App.tsx` mounts this only for `#/dev/ui` when the build is a
// development build or the authenticated user is an admin. The route is not
// part of `NavState`, has no navigation entry, and renders fixed fixtures only
// (no API call, no user data, no writes) — see `ComponentMatrix.tsx`.
import { ComponentMatrix } from './ComponentMatrix';

export function DevUIScreen() {
  const accessLabel = import.meta.env.DEV ? 'development build' : 'administrator';
  const accessNote = import.meta.env.DEV
    ? 'Visible in development builds. Production falls back to the normal app.'
    : 'Visible to authenticated administrators only.';

  return (
    <div
      data-testid="dev-ui-screen"
      className="min-h-screen w-full bg-app text-fg-primary"
    >
      <header className="border-b border-line-subtle bg-surface/40">
        <div className="mx-auto max-w-page px-4 py-5 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-micro font-medium text-brand-300">DEV ONLY · QA-X-31</p>
              <h1
                data-page-title
                className="mt-1 text-page font-semibold tracking-tight text-fg-primary"
              >
                UI component matrix
              </h1>
              <p className="mt-1 max-w-reading text-caption leading-relaxed text-fg-secondary">
                Shared-component catalog for QA-X-31: Button, Dialog, Tabs,
                Segmented, Badge, Card/ListRow and StateView. Fixed fixtures
                only — no API calls, no user data, no writes.
              </p>
            </div>

            <nav
              aria-label="Dev UI exits"
              className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-caption"
            >
              <a
                href="#/today"
                className="rounded-control text-brand-300 underline-offset-4 hover:underline"
              >
                App · Today
              </a>
              <a
                href="#/welcome"
                className="rounded-control text-fg-secondary underline-offset-4 hover:text-fg-primary hover:underline"
              >
                Welcome
              </a>
            </nav>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-micro sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-fg-muted">Route</dt>
              <dd className="truncate font-medium text-fg-strong">#/dev/ui</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-fg-muted">Access</dt>
              <dd className="truncate font-medium text-fg-strong">{accessLabel}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-fg-muted">Evidence</dt>
              <dd className="font-medium text-fg-strong">375 / 1440</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-fg-muted">Fixtures</dt>
              <dd className="font-medium text-fg-strong">static</dd>
            </div>
          </dl>
        </div>
      </header>

      <main className="mx-auto max-w-page px-4 pb-20 pt-8 sm:px-6">
        <ComponentMatrix />

        <footer className="mt-12 border-t border-line-subtle pt-4 text-micro leading-relaxed text-fg-muted">
          QA-X-31 · Appendix F. This route is not linked from product navigation
          and is not part of the app&apos;s route model. {accessNote}
        </footer>
      </main>
    </div>
  );
}

export default DevUIScreen;
