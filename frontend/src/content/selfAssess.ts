// 3-minute self-assessment content (20 items: 4 skills × A1–C1).
//
// The backend owns the authoritative bank (`content/ability/self_assess.json`,
// §5.7) and validates the submitted item ids against it. This bundled copy is
// the frontend fallback for the current backend: `GET /api/ability/profile`
// does not ship the self-assessment items, so the sheet still needs statements
// before the first submit. Keep the ids identical to the backend bank; the copy
// is imported from that file (not hand-invented) so both sides stay in sync.
//
// Content, not UI copy: it stays out of the i18n dictionary on purpose.
import type { LanguageCode } from '../i18n';

export type SelfAssessSkill = 'listening' | 'speaking' | 'reading' | 'writing';
export type SelfAssessBand = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export interface BundledSelfAssessItem {
    id: string;
    skill: SelfAssessSkill;
    band: SelfAssessBand;
    statement: string;
}

const ZH_ITEMS: BundledSelfAssessItem[] = [
    { id: "self-listening-a1", skill: "listening", band: "A1", statement: "我能听懂很慢、很清楚的问候和数字。" },
    { id: "self-listening-a2", skill: "listening", band: "A2", statement: "我能听懂日常购物或出行对话的大意。" },
    { id: "self-listening-b1", skill: "listening", band: "B1", statement: "我能听懂熟悉话题的视频，抓住主要观点和几个细节。" },
    { id: "self-listening-b2", skill: "listening", band: "B2", statement: "我能听懂访谈或讲座的论证和态度。" },
    { id: "self-listening-c1", skill: "listening", band: "C1", statement: "我能听懂学术或专业内容里的隐含态度。" },
    { id: "self-speaking-a1", skill: "speaking", band: "A1", statement: "我能用简单句介绍自己。" },
    { id: "self-speaking-a2", skill: "speaking", band: "A2", statement: "我能完成点单、预约或问路。" },
    { id: "self-speaking-b1", skill: "speaking", band: "B1", statement: "我能就熟悉话题连续说 1 分钟。" },
    { id: "self-speaking-b2", skill: "speaking", band: "B2", statement: "我能参与讨论并回应对方观点。" },
    { id: "self-speaking-c1", skill: "speaking", band: "C1", statement: "我能就复杂话题做 3 分钟连贯表达。" },
    { id: "self-reading-a1", skill: "reading", band: "A1", statement: "我能读懂菜单、路标和短消息里的具体信息。" },
    { id: "self-reading-a2", skill: "reading", band: "A2", statement: "我能读懂通知和行程的主旨。" },
    { id: "self-reading-b1", skill: "reading", band: "B1", statement: "我能读懂熟悉话题的短文并区分事实与观点。" },
    { id: "self-reading-b2", skill: "reading", band: "B2", statement: "我能读懂评论或新闻里的论证与立场。" },
    { id: "self-reading-c1", skill: "reading", band: "C1", statement: "我能读懂学术文章里的复杂论证和隐含态度。" },
    { id: "self-writing-a1", skill: "writing", band: "A1", statement: "我能写 20–40 词的自我介绍。" },
    { id: "self-writing-a2", skill: "writing", band: "A2", statement: "我能写留言或邮件说明日常安排。" },
    { id: "self-writing-b1", skill: "writing", band: "B1", statement: "我能写 80–120 词的短文并说明理由。" },
    { id: "self-writing-b2", skill: "writing", band: "B2", statement: "我能写段落清晰的议论文或报告。" },
    { id: "self-writing-c1", skill: "writing", band: "C1", statement: "我能写 180–250 词的结构化文章。" },
];

const VI_ITEMS: BundledSelfAssessItem[] = [
    { id: "self-listening-a1", skill: "listening", band: "A1", statement: "Tôi có thể hiểu lời chào và con số nói rất chậm, rõ ràng." },
    { id: "self-listening-a2", skill: "listening", band: "A2", statement: "Tôi có thể hiểu ý chính hội thoại mua sắm hoặc đi lại thường ngày." },
    { id: "self-listening-b1", skill: "listening", band: "B1", statement: "Tôi có thể hiểu video về chủ đề quen thuộc, nắm ý chính và vài chi tiết." },
    { id: "self-listening-b2", skill: "listening", band: "B2", statement: "Tôi có thể hiểu lập luận và thái độ trong phỏng vấn hoặc bài giảng." },
    { id: "self-listening-c1", skill: "listening", band: "C1", statement: "Tôi có thể hiểu thái độ hàm ẩn trong nội dung học thuật hoặc chuyên môn." },
    { id: "self-speaking-a1", skill: "speaking", band: "A1", statement: "Tôi có thể giới thiệu bản thân bằng câu đơn." },
    { id: "self-speaking-a2", skill: "speaking", band: "A2", statement: "Tôi có thể gọi món, đặt lịch hoặc hỏi đường." },
    { id: "self-speaking-b1", skill: "speaking", band: "B1", statement: "Tôi có thể nói liên tục 1 phút về chủ đề quen thuộc." },
    { id: "self-speaking-b2", skill: "speaking", band: "B2", statement: "Tôi có thể tham gia thảo luận và phản hồi ý kiến đối phương." },
    { id: "self-speaking-c1", skill: "speaking", band: "C1", statement: "Tôi có thể trình bày liên tục 3 phút về chủ đề phức tạp." },
    { id: "self-reading-a1", skill: "reading", band: "A1", statement: "Tôi có thể đọc thông tin cụ thể trong thực đơn, biển chỉ dẫn và tin nhắn ngắn." },
    { id: "self-reading-a2", skill: "reading", band: "A2", statement: "Tôi có thể hiểu ý chính của thông báo và lịch trình." },
    { id: "self-reading-b1", skill: "reading", band: "B1", statement: "Tôi có thể đọc bài ngắn về chủ đề quen thuộc và phân biệt sự thật với quan điểm." },
    { id: "self-reading-b2", skill: "reading", band: "B2", statement: "Tôi có thể hiểu lập luận và lập trường trong bình luận hoặc tin tức." },
    { id: "self-reading-c1", skill: "reading", band: "C1", statement: "Tôi có thể hiểu lập luận phức tạp và thái độ hàm ẩn trong bài học thuật." },
    { id: "self-writing-a1", skill: "writing", band: "A1", statement: "Tôi có thể viết 20–40 từ tự giới thiệu." },
    { id: "self-writing-a2", skill: "writing", band: "A2", statement: "Tôi có thể viết tin nhắn hoặc email nêu kế hoạch hằng ngày." },
    { id: "self-writing-b1", skill: "writing", band: "B1", statement: "Tôi có thể viết đoạn 80–120 từ và nêu lý do." },
    { id: "self-writing-b2", skill: "writing", band: "B2", statement: "Tôi có thể viết bài nghị luận hoặc báo cáo có đoạn rõ ràng." },
    { id: "self-writing-c1", skill: "writing", band: "C1", statement: "Tôi có thể viết bài có cấu trúc 180–250 từ." },
];

export function bundledSelfAssessItems(language: LanguageCode): BundledSelfAssessItem[] {
    return language === 'vi-VN' ? VI_ITEMS : ZH_ITEMS;
}
