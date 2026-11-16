// Detect public-domain book links so the article reader can hand them off to
// the dedicated "import public-domain book" flow instead of pretending they are
// ordinary articles. Keep the rules in sync with backend/book_import.py: only
// https + fixed hosts/paths; no userinfo/ports/query strings.
export type PublicDomainSource = 'gutenberg' | 'standard_ebooks';

export interface PublicDomainBookLink {
    sourceType: PublicDomainSource;
    /** The URL as pasted (the backend canonicalises it on preview). */
    url: string;
}

const GUTENBERG_HOSTS = new Set(['www.gutenberg.org', 'gutenberg.org']);
const STANDARD_EBOOKS_HOSTS = new Set([
    'standardebooks.org',
    'www.standardebooks.org',
]);

const GUTENBERG_PAGE = /^\/ebooks\/\d{1,8}$/;
const GUTENBERG_CACHE = /^\/cache\/epub\/(\d{1,8})\/pg(\d{1,8})\.txt$/;
const GUTENBERG_FILES = /^\/files\/\d{1,8}\/[A-Za-z0-9._\-/]+\.txt$/;
const STANDARD_EBOOKS_PAGE = /^\/ebooks\/[a-z0-9-]+\/[a-z0-9-]+$/;

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** ``null`` when the URL is not a supported public-domain book link. */
export function classifyPublicDomainBookUrl(raw: string): PublicDomainBookLink | null {
    const value = (raw || '').trim();
    if (!value || value.length > 2048) return null;
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.port && parsed.port !== '443') return null;
    if (parsed.search) return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    const path = safeDecode(parsed.pathname).replace(/\/+$/, '') || '/';

    if (GUTENBERG_HOSTS.has(host)) {
        if (GUTENBERG_PAGE.test(path)) {
            return { sourceType: 'gutenberg', url: value };
        }
        const cache = GUTENBERG_CACHE.exec(path);
        if (cache && cache[1] === cache[2]) {
            return { sourceType: 'gutenberg', url: value };
        }
        if (GUTENBERG_FILES.test(path)) {
            return { sourceType: 'gutenberg', url: value };
        }
        return null;
    }
    if (STANDARD_EBOOKS_HOSTS.has(host) && STANDARD_EBOOKS_PAGE.test(path)) {
        return { sourceType: 'standard_ebooks', url: value };
    }
    return null;
}
