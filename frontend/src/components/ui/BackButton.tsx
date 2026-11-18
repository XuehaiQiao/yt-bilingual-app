// The single page-level back control (design-system/components.md C12 /
// navigation-model.md NM-09). One size, one position, one behaviour:
// 36px tall, -ml-2 so the icon aligns with the content edge, label hidden below
// `sm`, and a 44px minimum hit target on coarse pointers.
import { ArrowLeft } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useI18n } from '../../i18n/I18nProvider';

export interface BackButtonProps {
  /** Single navigation action: route back, or the view's own back callback. */
  onBack: () => void;
  /**
   * Parent screen name (today / content / practice / profile / a list name).
   * The aria label becomes "返回<父级>" without adding a new i18n key. When the
   * vocabulary or grammar needs a separator, language-specific spacing is used.
   */
  parentLabel?: string;
  /** Fully-formed aria/tooltip override (wins over `parentLabel`). */
  ariaLabel?: string;
  /** Visible text override (e.g. "返回文章列表"); defaults to `nav.back`. */
  label?: string;
  /** Optional element id for the visible label, e.g. a screen-specific testid. */
  testId?: string;
  className?: string;
}

export function BackButton({
  onBack,
  parentLabel,
  ariaLabel,
  label,
  testId,
  className,
}: BackButtonProps) {
  const { t, language } = useI18n();
  const back = t('nav.back');
  const text = label ?? back;
  // `nav.backTo` does not exist yet and the i18n files are out of scope, so the
  // parent is appended here. Chinese compounds without a space; Vietnamese
  // needs one between "Quay lại" and the parent noun.
  const composedAria = parentLabel
    ? `${back}${language === 'zh-CN' ? '' : ' '}${parentLabel}`
    : back;
  const resolvedAria = ariaLabel ?? composedAria;

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onBack}
      aria-label={resolvedAria}
      title={resolvedAria}
      className={cn(
        'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2',
        'text-ui font-medium text-fg-secondary transition-colors',
        'hover:bg-state-hover hover:text-fg-primary active:scale-[0.98]',
        // Visual height stays 36px (C12), but the clickable area is expanded
        // to 44×44 via a transparent pseudo-element so touch targets pass.
        'after:absolute after:-inset-x-1.5 after:-inset-y-1 after:content-[""]',
        '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11',
        className,
      )}
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="hidden sm:inline">{text}</span>
    </button>
  );
}

export default BackButton;
