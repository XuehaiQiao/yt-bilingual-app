# 词族候选 AI 审计汇总（2026-11-23）

> 输入：436 个机器候选族；8 批 AI 逐族审阅；只产出建议，**未改数据**。
> 结果：keep 402 / trim 21 / split 13；高置信待应用 23 条，中/低置信待人工 11 条。

## 高置信变更（建议应用）

| id | head | verdict | 要移除 | 理由摘要 |
|---|---|---|---|---|
| F0264 | large | split | 边:  | WordNet 用「近义/释义桥」把三个不同词根串成 18 人：large/largeness（拉丁 largus）、extend/exte |
| F0900 | digital | trim | digitalis | digitalis（毛地黄/洋地黄制剂）是植物—药物名，只在 digitalize.v.02「投予洋地黄」这一医学义上入族（数字义 digi |
| F0370 | industry | trim | diligence, diligent | diligent/diligence（拉丁 diligere）与 industry（拉丁 industria）不同词根，WordNet 只经 |
| F1710 | vital | trim | indispensability, indispensable, indispensableness | indispensable/indispensability/indispensableness 词根是拉丁 dispensare（分配/免 |
| F2473 | vent | trim | venter, ventral | venter 是词形枢纽：venter.n.01「发泄的人」连 vent，venter.n.02「腹/子宫」连 ventral（拉丁 ven |
| F2524 | splash | trim | ostentate, ostentation, ostentatious, ostentatiousness | ostentate/ostentation/ostentatious（拉丁 ostendere「展示」）与 splash（拟声词根）不同根， |
| F1842 | aggressive | trim | pugnacious, pugnacity | aggress-/aggressor 与 pugnacious/pugnacity 不同词根：前者拉丁 aggredi（ad+gradi「走 |
| F1709 | strain | split | 边: strain–strenuous | strain 源自拉丁 stringere「拉紧」，strenuous 源自拉丁 strenuus「精力充沛」，非同根；WordNet 仅凭 |
| F2751 | sour | split | 边: sour–tartness | sour（日耳曼语源）与 tart（teart 语源）不同根；桥边 tartness→sour 是同义关系（同属 sour.n.02 味觉义 |
| F0064 | use | trim | serviceability, serviceable, serviceableness | serviceable 源出 service（拉丁 servire），非 use 派生；WordNet 经 useableness–serv |
| F0039 | life | trim | livery | livery 与 liver 的边走 WordNet 形容词 livery「胆汁的」（bilious.s.02），数据里 livery 是「 |
| F1578 | curious | split | 边: curious–inquisitiveness | curious 源自拉丁 cura「关心」（cur-），inquiry/inquisitive 源自 quaerere「寻求」（quer-/ |
| F0202 | drive | split | 边: drive–drift | WordNet 把 drift 挂到 drive 只靠 drift.n.07「矿井水平巷道」↔drive.v.19「水平挖掘」这一冷僻义；d |
| F0312 | clear | trim | limpid, limpidity | limpid/limpidity 与 clear 词根不同（拉丁 limpidus vs clarus）：limpidity 与 clari |
| F0474 | fly | split | 边: flee–flight | flight 兼「飞行」与「逃走」两义：flight–fly（allowlist，飞行义）与 flight–flee（flight.n.01 |
| F1548 | vacation | split | 边: vacate–vacation | vacate–vacation 走 vacation.n.02「法律上使无效/撤销」冷僻义（revoke.v.02），不是「假期」义；vac |
| F0845 | advantage | split | 边: advantageous–profitableness | profitable/profitability/profitableness 属 profit（拉丁 profectus）词根，WordN |
| F0441 | enter | trim | entrancement | enter/entry/entrance/entering/entrant/entree 同拉丁 intrare「进入」，语义透明；但 en |
| F0090 | bad | split | 边: bad–severeness | WordNet badness.n.02（疼痛/天气等不良程度）同义集把 severeness 的派生指针挂到 bad（severeness |
| F0383 | page | trim | pager | page/paginate/pagination/paging 同出拉丁 pagina「页」，分页义透明；pager 走 page.v.01 |
| F1259 | bright | split | 边: bright–luminousness | bright/brightness 为日耳曼语源（OE beorht）；luminous/luminosity/luminousness 属 |
| F1393 | angle | trim | angler | angle「角/角度」源自拉丁 angulus；angler「垂钓者/阴谋者」源自古英语 angel「鱼钩」，与 angle「钓鱼」同形异源 |
| F2407 | frost | trim | frostian | frostian「罗伯特·弗罗斯特（诗人）风格的」源自姓氏 Frost，与 frost「霜」仅词形相同、词源无关，属专名派生误入。删 fro |

## 中/低置信（待人工裁决）

| id | head | verdict | conf | 要移除 |
|---|---|---|---|---|
| F0045 | game | trim | medium | gameness |
| F3586 | agony | trim | medium | agonist, agonistic |
| F1461 | impress | trim | medium | impressment |
| F0213 | create | trim | medium | creature |
| F2021 | spoil | trim | medium | spoilation, spoliation |
| F0252 | sound | trim | medium | sonant |
| F1186 | urban | trim | medium | urbane |
| F1453 | deposit | split | medium | 边: depose–deposition |
| F1623 | dump | split | medium | 边: dump–dumpy |
| F2880 | foil | split | medium | 边: foil–foliate |
| F0624 | wind | trim | medium | winder |

## 说明

- 未应用；应用时把这些变更写回 `scripts/build_word_families.py` 的 blacklist/allowlist/remove_members，重新生成数据。
- 高置信变更预计影响 23 个族；split 后可能有一个子组失去 CEFR 锚点而被丢弃（如 foil 组）。
- 中/低置信 11 条先保留，待你逐条决定。
