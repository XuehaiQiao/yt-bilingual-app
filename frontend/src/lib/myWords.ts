// 「我的单词」与「已掌握」是两份独立列表（ADR-0001，docs/data-map.md）。
//
// 我的单词 = `favorites` 里 `type === 'vocabulary'` 的条目本身；计数就是
// 这个列表的长度。这里**刻意没有** `favorites − mastered` 减法，也没有读时
// mastery 过滤：存量重叠是数据缺陷，由 P0-02 的 reconcile 一次删除（写路径
// 保证互斥），读路径不得把真实收藏列表藏起来。
//
// 已掌握 = `word_states.mastered=1` 的独立列表（登录用户取
// `GET /api/review/words?mastered=1`，游客取本地「我会了」表）。它永远不从
// favorites 推导；两个列表在写路径上互斥，读路径只如实展示。
import type { FavoriteItem } from './favorites';
import { normalizeMasteryWord } from './wordMastery';

/**
 * 我的单词：唯一入口。只筛 `type === 'vocabulary'`，不做任何减法/交集/过滤。
 * 计数与导出都直接消费这个列表（`selectMyWords(favorites).length`）。
 */
export function selectMyWords(favorites: readonly FavoriteItem[]): FavoriteItem[] {
    return favorites.filter((favorite) => favorite.type === 'vocabulary');
}

/**
 * 已掌握：调用方传入权威列表（登录用户为服务端 mastered 列表映射成的
 * lemma，游客为本地「我会了」表），这里只做归一化 + 去重；计数 = 返回列表
 * 的长度。绝不接收/读取 favorites。
 */
export function selectMastered(serverWords: Iterable<string>): string[] {
    const seen = new Set<string>();
    const words: string[] = [];
    for (const raw of serverWords) {
        const lemma = normalizeMasteryWord(raw);
        if (!lemma || seen.has(lemma)) continue;
        seen.add(lemma);
        words.push(lemma);
    }
    return words;
}
