// 常见英文专名小名单（人名 / 地名 / 国家与地区 / 机构·品牌·缩写）。
//
// 用途：阅读标亮最小版（v1.1 任务 3，D3-1）的防误标。句中首字母大写的专名
// （London / John / Einstein）会被后端词级表当成普通词，本名单和
// 「非句首首字母大写 → 不标」规则一起把它们挡在标亮之外。
//
// 收录口径：
//   - 只收「词形本身不和普通英文单词混淆」的常见专名。像 May / Mark / Bill /
//     Will / Rose / Grace / Jack / Lily / Turkey / Polish / Oracle / Zoom 这类
//     兼作普通词的故意不收，否则会把正常词汇一起静音（isProperNoun 不区分大小写）。
//   - 多词专名（New York / Hong Kong / Eiffel Tower）不在此处理：读取时它们是
//     两个 token，按单 token 匹配，不拼合。
//   - 纯数据 + 纯函数，无任何依赖；不做词形推断（不处理复数、派生词）。
//   - 名单只求覆盖常见项，不求完整；词级查不到的词后端本来也会返回 null。

const PROPER_NOUNS = new Set<string>([
    // —— 常见英文人名 ——
    'john', 'mary', 'james', 'michael', 'william', 'david', 'thomas', 'daniel',
    'peter', 'george', 'henry', 'tom', 'alex', 'harry', 'andrew', 'brian',
    'sarah', 'emily', 'alice', 'anna', 'emma', 'lucy', 'kate', 'jane',
    'elizabeth', 'victoria',
    // —— 常见姓氏 / 名人 ——
    'einstein', 'newton', 'darwin', 'shakespeare', 'beethoven', 'mozart',
    'dickens', 'austen', 'hemingway', 'orwell', 'lincoln', 'washington',
    'gandhi', 'sherlock', 'holmes',

    // —— 常见城市 / 地区 ——
    'london', 'paris', 'berlin', 'madrid', 'rome', 'moscow', 'beijing',
    'shanghai', 'tokyo', 'seoul', 'sydney', 'toronto', 'chicago', 'boston',
    'california', 'texas', 'florida', 'york', 'oxford', 'cambridge',
    'manchester', 'edinburgh', 'amsterdam', 'vienna', 'athens', 'singapore',
    // —— 常见地标 / 自然地物 ——
    'sahara', 'thames', 'eiffel', 'hollywood', 'amazon',

    // —— 国家 / 民族 / 语言 ——
    'america', 'american', 'britain', 'british', 'england', 'english',
    'scotland', 'wales', 'ireland', 'irish', 'france', 'french', 'germany',
    'german', 'spain', 'spanish', 'italy', 'italian', 'russia', 'russian',
    'china', 'chinese', 'japan', 'japanese', 'korea', 'korean', 'india',
    'indian', 'canada', 'canadian',

    // —— 机构 / 品牌 / 技术缩写 ——
    'youtube', 'google', 'facebook', 'instagram', 'twitter', 'tiktok',
    'netflix', 'microsoft', 'samsung', 'sony', 'nike', 'wikipedia', 'openai',
    'chatgpt', 'deepseek', 'iphone', 'ipad', 'macbook', 'android', 'linux',
    'nasa', 'nato', 'fbi', 'cia', 'bbc', 'cnn', 'ceo', 'dna', 'html', 'api',
    'url', 'usb', 'pdf', 'gps', 'uk', 'usa', 'eu', 'toefl', 'ielts',
]);

/**
 * 判断一个 token 是否属于内置的常见专名名单。
 *
 * 匹配规则：先去掉首尾非字母数字字符（保留内部撇号），再按小写整词匹配；
 * 兼容所有格写法（Einstein's / NASA's）。大小写不敏感，因此小写的
 * `london` 也返回 true——名单刻意不收兼作普通词的专名（见文件头）。
 * 不处理复数与多词专名。纯函数，无副作用。
 */
export function isProperNoun(token: string): boolean {
    const word = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (word.length < 2) return false;
    const lower = word.toLowerCase();
    if (PROPER_NOUNS.has(lower)) return true;
    // 所有格：Einstein's / NASA's → 去掉 's 再查。
    return lower.endsWith("'s") && PROPER_NOUNS.has(lower.slice(0, -2));
}
