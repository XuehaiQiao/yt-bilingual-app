// 句子精背（Sentence Packs）— 类型、拉取、配色、进度。
// 详见 specs/009-sentence-packs/
import { apiFetch } from './api';
import { t } from '../i18n';
import { readScopedText, writeScopedText } from './storageScope';

export type ChunkCat = 'adv' | 'col' | 'idi' | 'phr';

export interface SegChunk {
    t: string;   // 英文语块
    g: string;   // 中文注释
    c: ChunkCat; // 语块类别
}
export type Seg = (string | SegChunk)[];

export interface Sentence {
    d: number;   // 级内天 1–10
    n: number;   // 级内序号 1–100
    cat: 'think' | 'work' | 'daily';
    zh: string;
    seg: Seg;
}

export interface SentenceLevelMeta {
    id: number;
    title: string;
    subtitle: string;
    count: number;
    days: number;
}
export interface SentenceLevel extends SentenceLevelMeta {
    sentences: Sentence[];
}

// 四类语块的配色（紫=高级词，与 AI 生词高亮同色；其余按语义分色）。
// 展示名走 i18n 字典（sentences.chunk.* / sentences.cat.*），这里只管颜色。
export const CHUNK_STYLE: Record<ChunkCat, { text: string }> = {
    adv: { text: 'text-purple-300' },
    col: { text: 'text-sky-300' },
    idi: { text: 'text-amber-300' },
    phr: { text: 'text-emerald-300' },
};

// --- 拉取 ---
export async function fetchSentenceLevels(): Promise<SentenceLevelMeta[]> {
    const r = await apiFetch('/api/sentences/levels');
    if (!r.ok) throw new Error(t('errors.loadSentenceLevels'));
    return r.json();
}
export async function fetchSentenceLevel(id: number): Promise<SentenceLevel> {
    const r = await apiFetch(`/api/sentences/level/${id}`);
    if (!r.ok) throw new Error(t('errors.loadSentenceLevel'));
    return r.json();
}

// --- 把一句 seg 拼成纯英文（用于搜索、收藏、朗读） ---
export function segToPlain(seg: Seg): string {
    return seg.map(p => (typeof p === 'string' ? p : p.t)).join('');
}

// --- 进度（按级×天，存 localStorage；P2-50：按身份 scope 隔离） ---
// 句子打卡是用户私有学习史：同一浏览器换账号后 B 不能看到 A 的「已背完」。
const dayStore = (lv: number, d: number) => `sentence-lv${lv}-day${d}`;

export function isDayDone(lv: number, d: number): boolean {
    return readScopedText(dayStore(lv, d)) === '1';
}
export function setDayDone(lv: number, d: number, done: boolean) {
    writeScopedText(dayStore(lv, d), done ? '1' : '0');
}
export function levelDoneDays(lv: number, totalDays: number): number {
    let n = 0;
    for (let d = 1; d <= totalDays; d++) if (isDayDone(lv, d)) n++;
    return n;
}
export function levelPercent(lv: number, totalDays: number): number {
    if (!totalDays) return 0;
    return Math.round((levelDoneDays(lv, totalDays) / totalDays) * 100);
}

// --- 复习打卡：每天 4 格，复习一遍勾一个（按级×天，存 localStorage；P2-50 按身份隔离） ---
export const REVIEW_COUNT = 4;
const revStore = (lv: number, d: number) => `sentence-lv${lv}-rev${d}`;

export function getReviews(lv: number, d: number): boolean[] {
    const raw = readScopedText(revStore(lv, d)) || '';
    return Array.from({ length: REVIEW_COUNT }, (_, i) => raw[i] === '1');
}
export function toggleReview(lv: number, d: number, i: number) {
    const arr = getReviews(lv, d);
    arr[i] = !arr[i];
    writeScopedText(revStore(lv, d), arr.map(b => (b ? '1' : '0')).join(''));
}

// --- 自测：是否隐藏译文（全局开关，持久化） ---
const ZH_HIDDEN_KEY = 'sentence-zh-hidden';
export function loadZhHidden(): boolean {
    return localStorage.getItem(ZH_HIDDEN_KEY) === '1';
}
export function saveZhHidden(hidden: boolean) {
    localStorage.setItem(ZH_HIDDEN_KEY, hidden ? '1' : '0');
}
