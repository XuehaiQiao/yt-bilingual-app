// AI-generated marker (v1.1 P0, design governance: "AI 生成" must be visible
// next to the content it produced, not buried in a legal page).
//
// One component, one meaning: this text was produced by a model and may be
// wrong. The `kind` only changes the short label (translation / analysis /
// quiz); the accessible title always explains the caveat. Colour never carries
// the meaning — the word "AI" is in the label.
import { Sparkles } from 'lucide-react';
import { cn } from '../lib/cn';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

export type AIGeneratedKind = 'translation' | 'analysis' | 'quiz' | 'gloss' | 'generic';

const LABEL_KEYS: Record<AIGeneratedKind, TranslationKey> = {
  translation: 'ai.badge.translation',
  analysis: 'ai.badge.analysis',
  quiz: 'ai.badge.quiz',
  gloss: 'ai.badge.gloss',
  generic: 'ai.badge.generated',
};

interface AIGeneratedBadgeProps {
  kind?: AIGeneratedKind;
  /** Stable hook for acceptance scripts; defaults to `ai-badge-<kind>`. */
  testId?: string;
  className?: string;
}

export function AIGeneratedBadge({
  kind = 'generic',
  testId,
  className,
}: AIGeneratedBadgeProps) {
  const { t } = useI18n();
  return (
    <span
      data-testid={testId ?? `ai-badge-${kind}`}
      data-ai-generated={kind}
      title={t('ai.badge.title')}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full',
        'border border-highlight/25 bg-highlight/10 px-2 py-0.5',
        'text-micro font-medium leading-none text-highlight-fg',
        className,
      )}
    >
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t(LABEL_KEYS[kind])}</span>
    </span>
  );
}
