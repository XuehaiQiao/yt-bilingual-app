// Official blog API client (specs/020-blog).
//
// The backend reads `content/blog/*.md` directly — there is no database or
// CMS. These three public endpoints need no login. The frontend renders the
// Markdown with react-markdown (raw HTML never becomes executable); the
// backend's `html` field is kept for RSS/other consumers and as a fallback
// shape, not injected into the DOM.
import { api, apiFetch } from './api';

export interface BlogPostSummary {
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  tags: string[];
  /** Articles are written in Chinese; UI chrome is localized separately. */
  lang: string;
  readingMinutes: number;
}

export interface BlogPost extends BlogPostSummary {
  published: boolean;
  markdown: string;
  html: string;
}

interface BlogListResponse {
  posts: BlogPostSummary[];
  count: number;
}

export class BlogApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'BlogApiError';
    this.status = status;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail;
  } catch {
    // Non-JSON error body: fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`;
}

function asSummary(value: unknown): BlogPostSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.slug !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.date !== 'string' ||
    typeof record.excerpt !== 'string' ||
    !Array.isArray(record.tags) ||
    !record.tags.every((tag) => typeof tag === 'string')
  ) {
    return null;
  }
  return {
    slug: record.slug,
    title: record.title,
    date: record.date,
    excerpt: record.excerpt,
    tags: record.tags as string[],
    lang: typeof record.lang === 'string' ? record.lang : 'zh-CN',
    readingMinutes:
      typeof record.readingMinutes === 'number' && Number.isFinite(record.readingMinutes)
        ? record.readingMinutes
        : 1,
  };
}

export async function listBlogPosts(): Promise<BlogListResponse> {
  const response = await apiFetch('/api/blog/posts');
  if (!response.ok) throw new BlogApiError(await readError(response), response.status);
  const data = (await response.json()) as { posts?: unknown; count?: unknown };
  if (!Array.isArray(data?.posts)) {
    throw new BlogApiError('invalid blog list payload', -1);
  }
  const posts = data.posts.map(asSummary).filter((post): post is BlogPostSummary => post !== null);
  return { posts, count: typeof data.count === 'number' ? data.count : posts.length };
}

export async function getBlogPost(slug: string): Promise<BlogPost> {
  const response = await apiFetch(`/api/blog/posts/${encodeURIComponent(slug)}`);
  if (!response.ok) throw new BlogApiError(await readError(response), response.status);
  const data = (await response.json()) as Record<string, unknown>;
  const summary = asSummary(data);
  if (!summary || typeof data.markdown !== 'string' || typeof data.html !== 'string') {
    throw new BlogApiError('invalid blog detail payload', -1);
  }
  return {
    ...summary,
    published: data.published === true,
    markdown: data.markdown,
    html: data.html,
  };
}

/** Absolute RSS URL for feed readers; the endpoint is public and read-only. */
export function blogFeedUrl(): string {
  return api('/api/blog/feed.xml');
}
