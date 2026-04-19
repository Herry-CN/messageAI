针对聊天记录分析群聊商机智能抓取的标准做法（行业共识 pipeline）
行业内没有一个“官方标准”，但经过多年实践（尤其是2024-2026年LLM普及后），形成了高度一致的三阶段混合管道（Hybrid Pipeline），这也是你当前逻辑最需要升级的方向：

数据采集 & 预处理（Ingestion & Cleaning）
微信：读取SQLite（Msg\_xxx表）+ 时间/类型过滤（和你一样）。
行业升级：支持图片/链接/小程序卡片（OCR或描述），不再只留text消息。
去重：软去重（标记而非直接跳过）。

智能分段 + 分类（Segmentation & Classification） ← 你当前最弱的一环
不再固定2500字符硬切 → 采用时间自然段（30-60分钟）+ 语义聚类（TF-IDF或embedding相似度）。
两阶段AI（先分类再提取）：
第一阶段：轻量分类器（招聘/求购/资源/无关），召回率优先。
第二阶段：仅对相关消息做结构化提取（few-shot + CoT）。

每个batch自动追加前文摘要（上一段1-2句关键信息），解决上下文割裂。

提取 + 验证 + 落库（Extraction & Validation）
LLM Prompt：few-shot示例 + 置信度输出 + 严格边界定义（必须同时满足2个以上条件才算招聘）。
兜底：规则 + LLM并行（而非AI全空才触发）。
后处理：置信度过滤（<0.75丢弃） + 三层去重（完全相同 + 标题相同 + Jaccard+embedding相似度）。
输出：结构化JSON直接入CRM/待办系统。

常见技术栈：

LLM层：Qwen2.5/DeepSeek/Claude + temperature 0.3-0.5 + JSON mode。
框架：LangChain（semantic.extract / classify）、LlamaIndex。
评估：精确率/召回率/F1 + 人工标注验证（SCRM工具都在做）。
隐私：本地部署（Ollama）或企业微信官方通道。
