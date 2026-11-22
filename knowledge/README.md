# 乡筑工作台知识库（运行数据）

本目录是工作台 AI 的**检索知识库**：服务端 `server/knowledge.ts` 启动后加载这里的案例与规则，
在协作区对话、调试台咨询（consultation）等链路中按问题检索，作为带出处的参考注入提示词。

来源：项目方整理并提供的 `归档/` 知识包（2026-09-09 版本，由 `npm run kb:sync` 同步）。

## 目录

| 路径 | 内容 | 条数 |
|---|---|---|
| `rural_age_friendly_100/references/cases.jsonl` | 乡村适老化案例卡（事实／推论／边界分栏） | 100 |
| `rural_age_friendly_100/references/rules.jsonl` | 条件化经验规则（编号 D01—D16） | 16 |
| `rural_age_friendly_100/references/sources.json` | 来源页面登记（标题／机构／日期／链接） | 67 |
| `rural_age_friendly_100/SKILL.md`、`README.md` | 使用流程与限制说明 | — |
| `rural_public_space_expansion/data/cases.jsonl` | 乡村与公共空间适老化参考卡 | 100 |
| `rural_public_space_expansion/references/distilled_rules.json` | 条件化经验规则（编号 D01—D20） | 20 |
| `rural_public_space_expansion/references/sources.json` | 来源页面登记 | 102 |
| `rural_public_space_expansion/manifest.json` | 计数、范围与缺口声明 | — |
| `method/deep-research-report-6.md` | 知识库扩充方法论报告（人工参考，不参与检索） | — |

两个库的规则编号会重复（都有 D01…），运行时统一加前缀区分：适老库 `AF-Dxx`、公共空间库 `PS-Dxx`。

## 使用边界（必须保留，不得改写）

- 案例是**带出处的整理与归纳**，不是现场核验、独立效果评估或施工图依据；`evidence_access` / `evidence_level`
  的 A / B 只表示「读到正文片段」或「仅有检索摘要」，**不是质量或成效等级**。
- 「蒸馏规则 / 适老化推论」是分析推论，不是工程规范、医疗结论、政策资格或补贴承诺。
- 尺寸、造价、坡度、覆盖率、跌倒下降比例等量化结论**未收录、也未验证**；具体项目需另行实测与专业复核。
- 图片与来源版权未确认，不得转作训练或再分发素材。
- 引用时必须保留 `case_id` 与来源链接；事实与推论分栏；超出 `transfer_boundary` 的做法不得照搬。

## 更新方式

```bash
npm run kb:sync -- "<归档目录>"   # 从归档目录重新同步数据文件（默认 ../归档 或 归档/）
npm run kb:check                  # 打印加载统计与检索自检（也可用 node --import tsx scripts/kb.ts check）
```

服务端缓存 60 秒自动重载，替换文件后无需重启后端；新增/修改文件请保持现有 JSONL 字段结构。
