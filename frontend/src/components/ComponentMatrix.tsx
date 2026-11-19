// Dev-only component matrix (QA-X-31 / design QA appendix F).
//
// Every section is a fixed fixture: no API calls, no user data, no writes.
// This is a catalog of the shared components in `./ui`, not a product screen —
// it has no navigation entry and is never mounted by the normal app flow.
// `DevUIScreen` owns the page shell; this file owns the sections.
import { useEffect, useState, type ReactNode } from 'react';
import {
  BookOpenCheck,
  Check,
  Clock,
  GraduationCap,
  Inbox,
  Plus,
  Sparkles,
  Star,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { Button, IconButton } from './ui/Button';
import { Badge, CountBadge, Dot, type BadgeTone } from './ui/Badge';
import { Card, IconTile } from './ui/Card';
import { ListRow } from './ui/ListRow';
import { Tabs, tabPanelProps, type TabItem } from './ui/Tabs';
import { Segmented } from './ui/Segmented';
import { Dialog } from './ui/Dialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import {
  EmptyState,
  ErrorPanel,
  LoadingState,
  RefreshingState,
  Skeleton,
} from './ui/StateView';
import type { ButtonSize, ButtonTone } from './ui/Button';

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  const titleId = `dev-ui-${id}-title`;
  return (
    <section
      data-testid={`dev-ui-${id}`}
      aria-labelledby={titleId}
      className="min-w-0 scroll-mt-6"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          id={titleId}
          className="text-section font-semibold tracking-tight text-fg-primary"
        >
          {title}
        </h2>
        {hint && (
          <p className="min-w-0 text-caption leading-relaxed text-fg-secondary">{hint}</p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function DemoRow({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-micro font-medium text-fg-muted">{label}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      {note && <p className="mt-1.5 text-micro leading-relaxed text-fg-secondary">{note}</p>}
    </div>
  );
}

function Counter({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number;
}) {
  return (
    <output data-testid={testId} className="text-caption text-fg-secondary" aria-live="polite">
      {label}: {value}
    </output>
  );
}

const BUTTON_SIZES: readonly ButtonSize[] = ['sm', 'md', 'lg', 'xl'];
const BUTTON_TONES: readonly ButtonTone[] = ['brand', 'success', 'warning', 'danger'];
const BADGE_TONES: readonly BadgeTone[] = [
  'neutral',
  'brand',
  'success',
  'warning',
  'danger',
  'highlight',
];

/* ── 1 · Button / IconButton ─────────────────────────────────────────────── */

function ButtonSection() {
  const [clicks, setClicks] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setLoading(false), 1200);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return (
    <Section
      id="button"
      title="Button / IconButton"
      hint="C1 · primary/secondary/tinted/ghost/destructive/icon · sm 32 / md 36 / lg 40 / xl 48"
    >
      <div className="space-y-4">
        <DemoRow label="Sizes · primary">
          {BUTTON_SIZES.map((size) => (
            <Button
              key={size}
              variant="primary"
              size={size}
              onClick={() => setClicks((value) => value + 1)}
            >
              Primary {size}
            </Button>
          ))}
        </DemoRow>

        <DemoRow label="Sizes · secondary">
          {BUTTON_SIZES.map((size) => (
            <Button key={size} variant="secondary" size={size}>
              Secondary {size}
            </Button>
          ))}
        </DemoRow>

        <DemoRow label="Tinted tones (tinted must carry a tone)">
          {BUTTON_TONES.map((tone) => (
            <Button key={tone} variant="tinted" tone={tone}>
              {tone}
            </Button>
          ))}
        </DemoRow>

        <DemoRow label="Ghost / destructive / icon">
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive" iconLeft={<Trash2 />}>
            Delete
          </Button>
          <IconButton ariaLabel="Add fixture item" onClick={() => setClicks((value) => value + 1)}>
            <Plus />
          </IconButton>
          <IconButton ariaLabel="Mark fixture complete" size="sm">
            <Check />
          </IconButton>
          <IconButton ariaLabel="Remove fixture item" size="lg">
            <X />
          </IconButton>
        </DemoRow>

        <DemoRow
          label="States · disabled / loading / full width"
          note="Loading keeps the label and blocks repeat clicks; disabled is semantic, not only visual."
        >
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button
            variant="secondary"
            loading={loading}
            onClick={() => setLoading(true)}
            testId="dev-ui-button-loading"
          >
            {loading ? 'Working…' : 'Load for 1.2s'}
          </Button>
          <div className="w-full sm:max-w-xs">
            <Button variant="secondary" fullWidth>
              Full width
            </Button>
          </div>
        </DemoRow>

        <div className="flex flex-wrap items-center gap-3">
          <Counter testId="dev-ui-button-clicks" label="Button clicks" value={clicks} />
          <span className="text-micro text-fg-muted">
            Focus ring: Tab through the row; Enter/Space activates.
          </span>
        </div>
      </div>
    </Section>
  );
}

/* ── 2 · Badge / CountBadge / Dot ────────────────────────────────────────── */

function BadgeSection() {
  return (
    <Section
      id="badge"
      title="Badge / CountBadge / Dot"
      hint="C7 · five semantic tones + highlight · 0 is never rendered · 99+ formatting"
    >
      <div className="space-y-4">
        <DemoRow label="Badge tones">
          {BADGE_TONES.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
          <Badge tone="brand" icon={<Star />}>
            Saved
          </Badge>
        </DemoRow>

        <DemoRow
          label="CountBadge · 0 / 8 / 128 / 10000"
          note="The count badge at 0 renders nothing (the empty slot on the left)."
        >
          <span data-testid="dev-ui-badge-zero">
            <CountBadge count={0} ariaLabel="Zero items" />
          </span>
          <CountBadge count={8} ariaLabel="Eight items" />
          <CountBadge count={128} ariaLabel="128 items" />
          <CountBadge count={10000} ariaLabel="10,000 items" size="sm" />
        </DemoRow>

        <DemoRow label="Dot · color never carries meaning alone">
          {BADGE_TONES.map((tone) => (
            <span key={tone} className="inline-flex items-center gap-1.5 text-caption text-fg-secondary">
              <Dot tone={tone} label={`${tone} status`} />
              {tone}
            </span>
          ))}
        </DemoRow>
      </div>
    </Section>
  );
}

/* ── 3 · Card / IconTile ─────────────────────────────────────────────────── */

function CardSection() {
  const [clicks, setClicks] = useState(0);

  return (
    <Section
      id="card"
      title="Card / IconTile"
      hint="C2 · card / panel / stat / interactive / loading · tile 36/40/48"
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Card
            icon={Sparkles}
            iconTone="brand"
            title="Card"
            description="Default surface, 16px radius."
            footer={<Badge tone="neutral">16px</Badge>}
          >
            <p className="text-caption leading-relaxed text-fg-secondary">
              Body copy uses the shared card padding and token colors.
            </p>
          </Card>

          <Card
            variant="panel"
            title="Panel"
            description="Page-level master panel, 24px radius."
            footer={<Badge tone="brand">panel</Badge>}
          >
            <p className="text-caption leading-relaxed text-fg-secondary">
              One panel per page in product UI; this matrix is a catalog.
            </p>
          </Card>

          <Card variant="stat" title="12 min" description="Stat tile">
            <p className="text-micro text-fg-muted">Compact metric surface.</p>
          </Card>

          <Card
            variant="interactive"
            icon={BookOpenCheck}
            title="Interactive card"
            description="Renders a real button; Enter/Space activates."
            onClick={() => setClicks((value) => value + 1)}
            ariaLabel="Interactive card fixture"
            testId="dev-ui-card-interactive"
          >
            <p className="text-caption leading-relaxed text-fg-secondary">
              Hover and focus use the shared interactive recipe.
            </p>
          </Card>

          <Card title="Loading card" loading>
            <p className="text-caption text-fg-secondary">Replaced by skeleton lines.</p>
          </Card>
        </div>

        <DemoRow label="IconTile sizes and tones">
          <IconTile icon={BookOpenCheck} size="sm" />
          <IconTile icon={Clock} size="md" tone="brand" />
          <IconTile icon={GraduationCap} size="lg" tone="success" />
          <IconTile icon={UserRound} size="md" tone="warning" />
          <IconTile icon={Star} size="md" tone="danger" />
        </DemoRow>

        <Counter testId="dev-ui-card-clicks" label="Interactive card clicks" value={clicks} />
      </div>
    </Section>
  );
}

/* ── 4 · ListRow ─────────────────────────────────────────────────────────── */

function ListRowSection() {
  const [rowClicks, setRowClicks] = useState(0);
  const [trailingClicks, setTrailingClicks] = useState(0);

  return (
    <Section
      id="listrow"
      title="ListRow"
      hint="C2 · static / clickable / anchor / trailing action; selected+disabled are caller concerns"
    >
      <div className="space-y-2">
        <ListRow
          leading={<IconTile icon={BookOpenCheck} size="sm" />}
          title="Static row"
          subtitle="No action; not in the tab order."
          meta="meta line · 11px"
        />

        <ListRow
          leading={<IconTile icon={Clock} tone="brand" />}
          title="Clickable row"
          subtitle="role=button; Enter/Space activates."
          meta="Click or press Enter"
          trailing={<Badge tone="brand">3</Badge>}
          onClick={() => setRowClicks((value) => value + 1)}
          testId="dev-ui-listrow-click"
          ariaLabel="Clickable ListRow fixture"
        />

        <ListRow
          leading={<IconTile icon={GraduationCap} tone="success" />}
          title="Anchor row"
          subtitle="Renders a real <a> element."
          meta="Same hash: stays on the matrix"
          href="#/dev/ui"
          testId="dev-ui-listrow-anchor"
        />

        <ListRow
          leading={<IconTile icon={Star} tone="warning" />}
          title="Row with trailing action"
          subtitle="Trailing icon button stops propagation."
          trailing={
            <span onClick={(event) => event.stopPropagation()}>
              <IconButton
                ariaLabel="Remove fixture row"
                size="sm"
                onClick={() => setTrailingClicks((value) => value + 1)}
              >
                <Trash2 />
              </IconButton>
            </span>
          }
          onClick={() => setRowClicks((value) => value + 1)}
          ariaLabel="Row with trailing action fixture"
        />

        <div className="pointer-events-none opacity-50" aria-hidden="true">
          <ListRow
            leading={<IconTile icon={UserRound} size="sm" />}
            title="Disabled-looking row (composition)"
            subtitle="ListRow has no disabled prop; callers own this wrapper."
            meta="Not interactive"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Counter testId="dev-ui-listrow-clicks" label="Row clicks" value={rowClicks} />
        <Counter
          testId="dev-ui-listrow-trailing-clicks"
          label="Trailing clicks"
          value={trailingClicks}
        />
        <span className="text-micro text-fg-muted">
          Selected state is contextual (aria-current); the shared row does not paint it.
        </span>
      </div>
    </Section>
  );
}

/* ── 5 · Tabs ────────────────────────────────────────────────────────────── */

const NAV_TABS: TabItem[] = [
  { id: 'today', label: 'Today' },
  { id: 'content', label: 'Content', count: 12, countAriaLabel: 'Content, 12 new items' },
  { id: 'profile', label: 'Profile' },
];

const PANEL_TABS: TabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity', count: 12, countAriaLabel: 'Activity, 12 items' },
  {
    id: 'archive',
    label: 'Archive',
    disabled: true,
    title: 'Archive is disabled in this fixture',
  },
];

function TabsSection() {
  const [navValue, setNavValue] = useState('today');
  const [panelValue, setPanelValue] = useState('overview');

  return (
    <Section
      id="tabs"
      title="Tabs"
      hint="C5 · nav / panel skins · disabled + count · ←/→/Home/End, one tab stop"
    >
      <div className="space-y-5">
        <div className="min-w-0">
          <p className="mb-2 text-micro font-medium text-fg-muted">nav skin</p>
          <Tabs
            skin="nav"
            items={NAV_TABS}
            value={navValue}
            onChange={setNavValue}
            layoutId="dev-ui-tabs-nav"
            ariaLabel="Dev UI navigation tabs"
            testId="dev-ui-tabs-nav"
          />
          <p className="mt-2 text-caption text-fg-secondary">Selected: {navValue}</p>
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-micro font-medium text-fg-muted">
            panel skin · count + disabled
          </p>
          <Tabs
            skin="panel"
            items={PANEL_TABS}
            value={panelValue}
            onChange={setPanelValue}
            layoutId="dev-ui-tabs-panel"
            ariaLabel="Dev UI panel tabs"
            idPrefix="dev-ui-tabs"
            testId="dev-ui-tabs-panel"
          />
          <div
            {...tabPanelProps('dev-ui-tabs', panelValue)}
            data-testid="dev-ui-tabs-panel-body"
            className="mt-2 rounded-control border border-line-subtle bg-surface/40 p-3 text-caption text-fg-secondary"
          >
            Panel content for <span className="font-medium text-fg-strong">{panelValue}</span>.
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── 6 · Segmented ───────────────────────────────────────────────────────── */

const SEGMENTED_BASIC = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
];

const SEGMENTED_FIVE = [
  { value: 'one', label: 'One' },
  { value: 'two', label: 'Two' },
  { value: 'three', label: 'Three' },
  { value: 'four', label: 'Four' },
  { value: 'five', label: 'Five' },
];

const SEGMENTED_ASYNC = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
];

function SegmentedSection() {
  const [basic, setBasic] = useState('off');
  const [five, setFive] = useState('two');
  const [asyncValue, setAsyncValue] = useState('alpha');
  const [loadingValue, setLoadingValue] = useState<string | null>(null);

  useEffect(() => {
    if (!loadingValue) return;
    const next = loadingValue;
    const timer = window.setTimeout(() => {
      setAsyncValue(next);
      setLoadingValue(null);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [loadingValue]);

  return (
    <Section
      id="segmented"
      title="Segmented"
      hint="C6 · 2–5 options · sm / md · disabled / loading · radiogroup with ←/→/Home/End"
    >
      <div className="space-y-4">
        <DemoRow label="2 items · sm">
          <Segmented
            options={SEGMENTED_BASIC}
            value={basic}
            onChange={setBasic}
            layoutId="dev-ui-segmented-basic"
            ariaLabel="Dev UI two-option segmented control"
            size="sm"
            testId="dev-ui-segmented-basic"
          />
          <span className="text-caption text-fg-secondary">Selected: {basic}</span>
        </DemoRow>

        <DemoRow label="5 items · md · full width">
          <div className="w-full max-w-md">
            <Segmented
              options={SEGMENTED_FIVE}
              value={five}
              onChange={setFive}
              layoutId="dev-ui-segmented-five"
              ariaLabel="Dev UI five-option segmented control"
              size="md"
              fullWidth
              testId="dev-ui-segmented-five"
            />
          </div>
          <span className="text-caption text-fg-secondary">Selected: {five}</span>
        </DemoRow>

        <DemoRow
          label="Async switch · loadingValue"
          note="The checked option keeps its place while the target option shows a spinner."
        >
          <Segmented
            options={SEGMENTED_ASYNC}
            value={asyncValue}
            onChange={(value) => setLoadingValue(value)}
            loadingValue={loadingValue ?? undefined}
            layoutId="dev-ui-segmented-async"
            ariaLabel="Dev UI async segmented control"
            testId="dev-ui-segmented-async"
          />
          <span className="text-caption text-fg-secondary">
            Selected: {asyncValue}
            {loadingValue ? ` · loading ${loadingValue}` : ''}
          </span>
        </DemoRow>

        <DemoRow
          label="Disabled"
          note="Above five options, use Tabs or a menu (C6); six-option controls are intentionally not rendered."
        >
          <Segmented
            options={SEGMENTED_BASIC}
            value="on"
            onChange={() => {}}
            layoutId="dev-ui-segmented-disabled"
            ariaLabel="Dev UI disabled segmented control"
            disabled
            testId="dev-ui-segmented-disabled"
          />
        </DemoRow>
      </div>
    </Section>
  );
}

/* ── 7 · Dialog / ConfirmDialog ──────────────────────────────────────────── */

type DialogId = 'sm' | 'md' | 'lg' | 'fullscreen' | 'sheet' | 'busy' | 'confirm';

const DIALOG_TRIGGERS: ReadonlyArray<{ id: DialogId; label: string }> = [
  { id: 'sm', label: 'Small dialog' },
  { id: 'md', label: 'Medium + form' },
  { id: 'lg', label: 'Large dialog' },
  { id: 'fullscreen', label: 'Fullscreen' },
  { id: 'sheet', label: 'Sheet' },
  { id: 'busy', label: 'Busy alertdialog' },
  { id: 'confirm', label: 'ConfirmDialog' },
];

function DialogSection() {
  const [dialog, setDialog] = useState<DialogId | null>(null);
  const [field, setField] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const close = () => {
    setDialog(null);
    setFieldError(null);
  };

  const submitField = () => {
    if (!field.trim()) {
      setFieldError('Enter a value to continue.');
      return;
    }
    close();
  };

  return (
    <Section
      id="dialog"
      title="Dialog / ConfirmDialog"
      hint="C4 · sm/md/lg/fullscreen/sheet · alertdialog busy · form error · Esc + focus trap"
    >
      <div className="space-y-4">
        <DemoRow
          label="Open a fixture"
          note="Esc/backdrop/X close; focus returns to the trigger. The busy fixture deliberately disables every built-in close path and exits through its footer."
        >
          {DIALOG_TRIGGERS.map(({ id, label }) => (
            <Button
              key={id}
              variant="secondary"
              onClick={() => setDialog(id)}
              testId={`dev-ui-dialog-open-${id}`}
            >
              {label}
            </Button>
          ))}
        </DemoRow>

        <p className="text-micro text-fg-muted">
          No dialog is open. Fixtures use static copy; the form never sends a request.
        </p>
      </div>

      <Dialog
        open={dialog === 'sm'}
        onClose={close}
        size="sm"
        title="Small dialog"
        description="Fixed 448px ceiling on desktop; bottom sheet below md."
        initialFocus='[data-testid="dev-ui-dialog-sm-ok"]'
        testId="dev-ui-dialog-sm"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={close} testId="dev-ui-dialog-sm-ok">
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-caption leading-relaxed text-fg-secondary">
          One short confirmation. The initial focus is on the primary action in
          this fixture; destructive confirmations start on Cancel instead.
        </p>
      </Dialog>

      <Dialog
        open={dialog === 'md'}
        onClose={close}
        size="md"
        title="Medium dialog with a form"
        description="Inline error stays in the dialog; it never closes on failure."
        error={fieldError}
        initialFocus='[data-testid="dev-ui-dialog-md-input"]'
        testId="dev-ui-dialog-md"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submitField} testId="dev-ui-dialog-md-submit">
              Save
            </Button>
          </>
        }
      >
        <label
          htmlFor="dev-ui-dialog-md-field"
          className="block text-caption font-medium text-fg-strong"
        >
          Fixture field
        </label>
        <input
          id="dev-ui-dialog-md-field"
          data-testid="dev-ui-dialog-md-input"
          value={field}
          onChange={(event) => {
            setField(event.target.value);
            setFieldError(null);
          }}
          placeholder="Required"
          className="mt-2 h-control-md w-full rounded-control border border-line-subtle bg-surface-2/60 px-3 text-ui text-fg-primary placeholder:text-fg-secondary focus:border-brand/60 focus:ring-2 focus:ring-brand/15"
        />
        <p className="mt-2 text-micro text-fg-muted">
          Submitting empty shows the Dialog `error` slot.
        </p>
      </Dialog>

      <Dialog
        open={dialog === 'lg'}
        onClose={close}
        size="lg"
        title="Large dialog"
        description="896px ceiling; body scrolls independently of the page."
        testId="dev-ui-dialog-lg"
        footer={
          <Button variant="secondary" onClick={close} testId="dev-ui-dialog-lg-close">
            Close
          </Button>
        }
      >
        <div className="space-y-3 text-caption leading-relaxed text-fg-secondary">
          <p>
            Large dialogs are for content-heavy tasks. The panel keeps a single
            scroll region and a persistent header/footer.
          </p>
          <p>
            Every paragraph here is a fixture. There is no network request and no
            persisted state, so the matrix can run offline.
          </p>
          <ListRow
            leading={<IconTile icon={BookOpenCheck} size="sm" />}
            title="Nested content is composed, never re-shelled"
            subtitle="ListRow inside a Dialog body keeps its own surface."
            meta="No new tokens"
          />
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'fullscreen'}
        onClose={close}
        fullscreen
        title="Fullscreen dialog"
        description="Only for login gates / first-run guidance in product UI."
        testId="dev-ui-dialog-fullscreen"
        footer={
          <Button variant="secondary" onClick={close} testId="dev-ui-dialog-fullscreen-close">
            Close
          </Button>
        }
      >
        <p className="max-w-reading text-caption leading-relaxed text-fg-secondary">
          Fullscreen covers the viewport with the app background and no backdrop
          blur. This fixture demonstrates the shell; it is not the login gate.
        </p>
      </Dialog>

      <Dialog
        open={dialog === 'sheet'}
        onClose={close}
        sheet
        size="sm"
        title="Sheet dialog"
        description="Bottom sheet below md, centered modal above md."
        testId="dev-ui-dialog-sheet"
        footer={
          <Button variant="secondary" onClick={close} testId="dev-ui-dialog-sheet-close">
            Close
          </Button>
        }
      >
        <p className="text-caption leading-relaxed text-fg-secondary">
          Resize to 375px to see the sheet edge and safe-area padding.
        </p>
      </Dialog>

      <Dialog
        open={dialog === 'busy'}
        onClose={close}
        role="alertdialog"
        loading
        showClose={false}
        size="sm"
        title="Busy alert dialog"
        description="Escape, backdrop and the X are disabled while loading."
        testId="dev-ui-dialog-busy"
        footer={
          <Button variant="secondary" onClick={close} testId="dev-ui-dialog-busy-stop">
            Stop demo
          </Button>
        }
      >
        <p className="text-caption leading-relaxed text-fg-secondary">
          A blocking job keeps the dialog open and exposes `aria-busy`. The footer
          action exists only because this is a demo; a real busy flow would own
          its own completion signal.
        </p>
      </Dialog>

      <ConfirmDialog
        open={dialog === 'confirm'}
        title="Delete this sample?"
        description="This is a fixture; nothing is actually deleted."
        confirmLabel="Delete sample"
        cancelLabel="Cancel"
        onConfirm={() => new Promise<void>((resolve) => window.setTimeout(resolve, 700))}
        onClose={close}
        testId="dev-ui-confirm"
      />
    </Section>
  );
}

/* ── 8 · EmptyState ──────────────────────────────────────────────────────── */

function EmptyStateSection() {
  const [clicks, setClicks] = useState(0);

  return (
    <Section
      id="empty"
      title="EmptyState"
      hint="C10 · card py-10 / page py-16 / inline py-3 · one hint + one next action"
    >
      <div className="space-y-3">
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="rounded-card border border-line-subtle bg-surface/40">
            <EmptyState
              icon={Inbox}
              title="No fixtures yet"
              hint="Empty means the request succeeded with no items."
              action={{
                label: 'Add fixture',
                onClick: () => setClicks((value) => value + 1),
                testId: 'dev-ui-empty-action',
              }}
              size="card"
              testId="dev-ui-empty-card"
            />
          </div>

          <div className="rounded-card border border-line-subtle bg-surface/40">
            <EmptyState
              icon={Inbox}
              title="Inline empty"
              hint="Used inside a card that owns its padding."
              size="inline"
              testId="dev-ui-empty-inline"
            />
          </div>

          <div className="rounded-card border border-line-subtle bg-surface/40">
            <EmptyState
              icon={Inbox}
              title="Page empty"
              hint="Full screen: the title is h2 and the block gets py-16."
              size="page"
              testId="dev-ui-empty-page"
            />
          </div>
        </div>

        <Counter testId="dev-ui-empty-clicks" label="Empty action clicks" value={clicks} />
      </div>
    </Section>
  );
}

/* ── 9 · ErrorPanel ─────────────────────────────────────────────────────── */

function ErrorPanelSection() {
  const [actions, setActions] = useState(0);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(() => {
      setRetrying(false);
      setActions((value) => value + 1);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [retrying]);

  return (
    <Section
      id="error"
      title="ErrorPanel"
      hint="C10 · card / inline / page · role=alert · retry stays in the error branch"
    >
      <div className="space-y-3">
        <ErrorPanel
          title="Could not load the fixture"
          detail="This demo retry is a local 800ms timer; no request is sent."
          onRetry={() => setRetrying(true)}
          retryLabel="Retry"
          retrying={retrying}
          secondary={{ label: 'Secondary action', onClick: () => setActions((value) => value + 1) }}
          testId="dev-ui-error-card"
          retryTestId="dev-ui-error-retry"
        />

        <ErrorPanel
          level="inline"
          title="Refresh failed"
          detail="Old data stays on screen."
          onRetry={() => setRetrying(true)}
          retryLabel="Retry"
          retrying={retrying}
          testId="dev-ui-error-inline"
        />

        <div className="rounded-card border border-line-subtle bg-surface/40">
          <ErrorPanel
            level="page"
            title="Page-level failure"
            detail="A second exit is offered so the user is never trapped."
            onRetry={() => setRetrying(true)}
            retryLabel="Retry"
            retrying={retrying}
            secondary={{ label: 'Back to Today', onClick: () => setActions((value) => value + 1) }}
            testId="dev-ui-error-page"
          />
        </div>

        <Counter testId="dev-ui-error-actions" label="Error actions" value={actions} />
      </div>
    </Section>
  );
}

/* ── 10 · LoadingState / Skeleton ───────────────────────────────────────── */

function LoadingStateSection() {
  return (
    <Section
      id="loading"
      title="LoadingState / Skeleton"
      hint="C10 · spinner / skeleton / refreshing · aria-busy + readable status"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-2 text-micro font-medium text-fg-muted">Spinner</p>
          <LoadingState label="Loading fixture…" size="md" testId="dev-ui-loading-spinner" />
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-micro font-medium text-fg-muted">Skeleton rows</p>
          <LoadingState
            kind="skeleton"
            label="Loading list…"
            rows={3}
            testId="dev-ui-loading-skeleton"
          />
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-micro font-medium text-fg-muted">Bare Skeleton</p>
          <Skeleton lines={4} />
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-micro font-medium text-fg-muted">Refreshing (data kept)</p>
          <RefreshingState label="Refreshing…" testId="dev-ui-loading-refreshing" />
        </div>
      </div>
    </Section>
  );
}

/* ── 11 · Token probes (used by scripts/contrast-audit.mjs) ─────────────── */

const TEXT_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['fg-primary', 'text-fg-primary'],
  ['fg-strong', 'text-fg-strong'],
  ['fg-secondary', 'text-fg-secondary'],
  ['fg-muted', 'text-fg-muted'],
  ['fg-disabled', 'text-fg-disabled'],
  ['fg-inverse', 'text-fg-inverse'],
  ['brand', 'text-brand'],
  ['brand-300', 'text-brand-300'],
  ['brand-400', 'text-brand-400'],
  ['success-fg', 'text-success-fg'],
  ['warning-fg', 'text-warning-fg'],
  ['danger-fg', 'text-danger-fg'],
  ['highlight-fg', 'text-highlight-fg'],
];

const BG_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['app', 'bg-app'],
  ['surface', 'bg-surface'],
  ['surface-2', 'bg-surface-2'],
  ['surface-3', 'bg-surface-3'],
  ['control', 'bg-control'],
  ['brand', 'bg-brand'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['danger', 'bg-danger'],
  ['highlight', 'bg-highlight'],
];

function TokenSection() {
  return (
    <Section
      id="tokens"
      title="Token colors"
      hint="Probe swatches read by scripts/contrast-audit.mjs; values come from tailwind.config.js"
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {TEXT_TOKENS.map(([name, className]) => (
          <div
            key={name}
            className="flex min-w-0 items-center justify-between gap-2 rounded-control border border-line-subtle bg-surface/40 px-3 py-2"
          >
            <span data-token={name} className={cn('text-ui font-medium', className)}>
              Aa
            </span>
            <code className="truncate text-micro text-fg-muted">{name}</code>
          </div>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {BG_TOKENS.map(([name, className]) => (
          <div key={name} className="min-w-0 rounded-control border border-line-subtle p-2">
            <span
              data-token-bg={name}
              className={cn('block h-8 rounded-control border border-line-subtle', className)}
            />
            <code className="mt-1 block truncate text-micro text-fg-muted">{name}</code>
          </div>
        ))}
      </div>
    </Section>
  );
}

export function ComponentMatrix() {
  return (
    <div className="space-y-10">
      <ButtonSection />
      <BadgeSection />
      <CardSection />
      <ListRowSection />
      <TabsSection />
      <SegmentedSection />
      <DialogSection />
      <EmptyStateSection />
      <ErrorPanelSection />
      <LoadingStateSection />
      <TokenSection />
    </div>
  );
}

export default ComponentMatrix;
