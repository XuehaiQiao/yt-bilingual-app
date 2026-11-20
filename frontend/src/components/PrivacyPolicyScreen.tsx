// Public privacy policy page (`#/privacy`).
//
// M4 minimal set from docs/项目提案-上线功能.md §4.6.1: operator + contact
// channel, what we collect, why, AI providers + cross-border transfer, cookies,
// retention, deletion/export (M2 boundaries), access/correction, security,
// changes and contact. No support email is advertised because none exists in
// G1; the contact channel is the inviter / admin, and the page says so.
import { LegalDocument, type LegalSection } from './LegalDocument';

const SECTIONS: readonly LegalSection[] = [
  {
    id: 'operator',
    titleKey: 'public.legal.privacy.operator.title',
    paragraphs: [
      'public.legal.privacy.operator.body',
      'public.legal.privacy.operator.contact',
      'public.legal.privacy.operator.response',
    ],
  },
  {
    id: 'collect',
    titleKey: 'public.legal.privacy.collect.title',
    paragraphs: ['public.legal.privacy.collect.body'],
    bullets: [
      'public.legal.privacy.collect.account',
      'public.legal.privacy.collect.cookie',
      'public.legal.privacy.collect.learning',
      'public.legal.privacy.collect.aiUsage',
      'public.legal.privacy.collect.logs',
      'public.legal.privacy.collect.localVideo',
    ],
  },
  {
    id: 'purpose',
    titleKey: 'public.legal.privacy.purpose.title',
    paragraphs: [
      'public.legal.privacy.purpose.body',
      'public.legal.privacy.purpose.noSell',
    ],
  },
  {
    id: 'ai',
    titleKey: 'public.legal.privacy.ai.title',
    paragraphs: [
      'public.legal.privacy.ai.body',
      'public.legal.privacy.ai.crossBorder',
      'public.legal.privacy.ai.infra',
      'public.legal.privacy.ai.eval',
    ],
  },
  {
    id: 'cookies',
    titleKey: 'public.legal.privacy.cookies.title',
    paragraphs: [
      'public.legal.privacy.cookies.body',
      'public.legal.privacy.cookies.noTracking',
      'public.legal.privacy.cookies.control',
    ],
  },
  {
    id: 'retention',
    titleKey: 'public.legal.privacy.retention.title',
    paragraphs: ['public.legal.privacy.retention.body'],
    bullets: [
      'public.legal.privacy.retention.account',
      'public.legal.privacy.retention.logs',
      'public.legal.privacy.retention.usage',
      'public.legal.privacy.retention.backups',
      'public.legal.privacy.retention.local',
    ],
  },
  {
    id: 'deletion',
    titleKey: 'public.legal.privacy.deletion.title',
    paragraphs: [
      'public.legal.privacy.deletion.body',
      'public.legal.privacy.deletion.delete',
      'public.legal.privacy.deletion.export',
      'public.legal.privacy.deletion.manual',
      'public.legal.privacy.deletion.cache',
    ],
  },
  {
    id: 'rights',
    titleKey: 'public.legal.privacy.rights.title',
    paragraphs: ['public.legal.privacy.rights.body'],
  },
  {
    id: 'security',
    titleKey: 'public.legal.privacy.security.title',
    paragraphs: ['public.legal.privacy.security.body'],
  },
  {
    id: 'changes',
    titleKey: 'public.legal.privacy.changes.title',
    paragraphs: ['public.legal.privacy.changes.body'],
  },
  {
    id: 'contact',
    titleKey: 'public.legal.privacy.contact.title',
    paragraphs: [
      'public.legal.privacy.contact.body',
      'public.legal.privacy.contact.effective',
    ],
  },
];

export function PrivacyPolicyScreen() {
  return (
    <LegalDocument
      kind="privacy"
      testId="privacy-screen"
      titleKey="public.legal.privacy.title"
      leadKey="public.legal.privacy.lead"
      sections={SECTIONS}
    />
  );
}
