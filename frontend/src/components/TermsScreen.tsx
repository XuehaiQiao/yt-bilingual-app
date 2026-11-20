// Public terms of service page (`#/terms`).
//
// M4 minimal set from docs/项目提案-上线功能.md §4.6.2: service description,
// invite-only accounts, prohibited behaviour, content/copyright (YouTube embed,
// public-domain books, user files), third parties, changes/termination,
// liability, applicable law (no invented court — D-6 is still pending) and
// contact/effective date.
import { LegalDocument, type LegalSection } from './LegalDocument';

const SECTIONS: readonly LegalSection[] = [
  {
    id: 'service',
    titleKey: 'public.legal.terms.service.title',
    paragraphs: [
      'public.legal.terms.service.body',
      'public.legal.terms.service.beta',
    ],
  },
  {
    id: 'account',
    titleKey: 'public.legal.terms.account.title',
    paragraphs: [
      'public.legal.terms.account.body',
      'public.legal.terms.account.one',
      'public.legal.terms.account.secure',
    ],
  },
  {
    id: 'prohibited',
    titleKey: 'public.legal.terms.prohibited.title',
    paragraphs: ['public.legal.terms.prohibited.body'],
    bullets: [
      'public.legal.terms.prohibited.item1',
      'public.legal.terms.prohibited.item2',
      'public.legal.terms.prohibited.item3',
      'public.legal.terms.prohibited.item4',
      'public.legal.terms.prohibited.item5',
    ],
  },
  {
    id: 'content',
    titleKey: 'public.legal.terms.content.title',
    paragraphs: [
      'public.legal.terms.content.body',
      'public.legal.terms.content.uploads',
      'public.legal.terms.content.complaint',
    ],
  },
  {
    id: 'third-party',
    titleKey: 'public.legal.terms.thirdParty.title',
    paragraphs: ['public.legal.terms.thirdParty.body'],
  },
  {
    id: 'changes',
    titleKey: 'public.legal.terms.changes.title',
    paragraphs: [
      'public.legal.terms.changes.body',
      'public.legal.terms.changes.notice',
    ],
  },
  {
    id: 'liability',
    titleKey: 'public.legal.terms.liability.title',
    paragraphs: [
      'public.legal.terms.liability.body',
      'public.legal.terms.liability.limit',
    ],
  },
  {
    id: 'law',
    titleKey: 'public.legal.terms.law.title',
    paragraphs: [
      'public.legal.terms.law.body',
      'public.legal.terms.law.pending',
    ],
  },
  {
    id: 'contact',
    titleKey: 'public.legal.terms.contact.title',
    paragraphs: [
      'public.legal.terms.contact.body',
      'public.legal.terms.contact.effective',
    ],
  },
];

export function TermsScreen() {
  return (
    <LegalDocument
      kind="terms"
      testId="terms-screen"
      titleKey="public.legal.terms.title"
      leadKey="public.legal.terms.lead"
      sections={SECTIONS}
    />
  );
}
