const axios = require('axios');

class AIService {
  constructor() {
    this.provider = null;
    this.ollamaUrl = 'http://localhost:11434';
    this.openaiUrl = 'https://api.openai.com/v1';
    this.openaiKey = null;
    this.model = null;
    this.isReady = false;
    this.todoPromptCategories = `- 招聘信息（岗位、要求、联系方式等）
- 求购信息（需求物品或服务、预算、时间要求等）
- 寻找资源（寻找合作伙伴、渠道、供应商、场地等）
- 寻找咨询老师或专家（咨询方向、领域、联系方式等）`;
  }

  getDefaultTodoPromptCategories() {
    return `- 招聘信息（岗位、要求、联系方式等）
- 求购信息（需求物品或服务、预算、时间要求等）
- 寻找资源（寻找合作伙伴、渠道、供应商、场地等）
- 寻找咨询老师或专家（咨询方向、领域、联系方式等）`;
  }

  async getStatus() {
    try {
      await this.autoDetectProvider();
    } catch {}
    const ollamaAvailable = await this.checkOllama();
    const openaiConfigured = !!this.openaiKey;
    
    return {
      provider: this.provider,
      model: this.model,
      isReady: this.isReady,
      ollamaAvailable,
      openaiConfigured,
      ollamaModels: ollamaAvailable ? await this.getOllamaModels() : [],
      todoPromptCategories: this.todoPromptCategories
    };
  }

  async configure(config) {
    if (Object.prototype.hasOwnProperty.call(config, 'openaiKey')) {
      this.openaiKey = config.openaiKey ? String(config.openaiKey).trim() : null;
    }
    if (Object.prototype.hasOwnProperty.call(config, 'ollamaUrl')) {
      this.ollamaUrl = config.ollamaUrl ? String(config.ollamaUrl).trim() : 'http://localhost:11434';
    }
    if (Object.prototype.hasOwnProperty.call(config, 'model')) {
      this.model = config.model ? String(config.model).trim() : null;
    }
    if (typeof config.todoPromptCategories === 'string') {
      this.todoPromptCategories = config.todoPromptCategories.trim() || this.getDefaultTodoPromptCategories();
    }

    // Auto-detect best provider
    await this.autoDetectProvider();
    
    return this.getStatus();
  }

  async autoDetectProvider() {
    // Try Ollama first
    const ollamaAvailable = await this.checkOllama();
    if (ollamaAvailable) {
      this.provider = 'ollama';
      if (!this.model) {
        const models = await this.getOllamaModels();
        if (models.length > 0) {
          this.model = this.pickPreferredOllamaModel(models) || models[0];
        }
      }
      this.isReady = !!this.model;
      return;
    }

    // Fallback to OpenAI
    if (this.openaiKey) {
      this.provider = 'openai';
      if (!this.model) {
        this.model = 'gpt-3.5-turbo';
      }
      this.isReady = true;
      return;
    }

    this.isReady = false;
  }

  async checkOllama() {
    try {
      const response = await axios.get(`${this.ollamaUrl}/api/tags`, { timeout: 2000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async getOllamaModels() {
    try {
      const response = await axios.get(`${this.ollamaUrl}/api/tags`);
      return response.data.models?.map(m => m.name) || [];
    } catch {
      return [];
    }
  }

  pickPreferredOllamaModel(models, exclude = []) {
    const excluded = new Set(exclude.filter(Boolean));
    const ordered = [
      ...models.filter(m => /qwen2\.5/i.test(m)),
      ...models.filter(m => /llama/i.test(m)),
      ...models.filter(m => /mistral/i.test(m)),
      ...models.filter(m => /qwen/i.test(m)),
      ...models
    ];
    return ordered.find(m => !excluded.has(m)) || null;
  }

  async chat(message, context = []) {
    if (!this.isReady) {
      await this.autoDetectProvider();
      if (!this.isReady) {
        throw new Error('AI服务未配置。请先配置Ollama或OpenAI。');
      }
    }

    if (this.provider === 'ollama') {
      return this.chatWithOllama(message, context);
    } else if (this.provider === 'openai') {
      return this.chatWithOpenAI(message, context);
    }

    throw new Error('未知的AI提供者');
  }

  async chatWithOllama(message, context) {
    const messages = [
      ...context.map(c => ({ role: c.role, content: c.content })),
      { role: 'user', content: message }
    ];

    const triedModels = new Set();
    let currentModel = this.model;

    while (currentModel && !triedModels.has(currentModel)) {
      triedModels.add(currentModel);
      try {
        const response = await axios.post(`${this.ollamaUrl}/api/chat`, {
          model: currentModel,
          messages,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.2
          }
        });

        this.model = currentModel;
        return response.data.message?.content || '';
      } catch (error) {
        const models = await this.getOllamaModels();
        const fallbackModel = this.pickPreferredOllamaModel(models, [...triedModels]);
        console.error(`[AIService] Ollama model ${currentModel} failed:`, error.message);
        if (!fallbackModel) {
          throw new Error(`Ollama请求失败: ${error.message}`);
        }
        currentModel = fallbackModel;
      }
    }

    throw new Error('Ollama请求失败: 未找到可用模型');
  }

  async chatWithOpenAI(message, context) {
    try {
      const messages = [
        { role: 'system', content: '你是一个智能助手，帮助用户管理微信消息和待办事项。' },
        ...context.map(c => ({ role: c.role, content: c.content })),
        { role: 'user', content: message }
      ];

      const response = await axios.post(
        `${this.openaiUrl}/chat/completions`,
        {
          model: this.model,
          messages,
          temperature: 0.7
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openaiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.choices[0]?.message?.content || '';
    } catch (error) {
      throw new Error(`OpenAI请求失败: ${error.message}`);
    }
  }

  parseJsonResponse(response) {
    if (!response) return null;

    try {
      return JSON.parse(response);
    } catch {}

    const fencedMatch = String(response).match(/```json\s*([\s\S]*?)```/i);
    if (fencedMatch) {
      try {
        return JSON.parse(fencedMatch[1]);
      } catch {}
    }

    const objectMatch = String(response).match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {}
    }

    const arrayMatch = String(response).match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {}
    }

    return null;
  }

  normalizeLeadItems(parsed) {
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.results)
          ? parsed.results
          : Array.isArray(parsed?.data)
            ? parsed.data
            : parsed && typeof parsed === 'object' && typeof parsed.title === 'string'
              ? [parsed]
              : [];

    return items.filter(item => 
      item && 
      typeof item === 'object' &&
      typeof item.title === 'string' &&
      item.title.trim().length > 0
    ).map(item => {
      const rawConfidence = typeof item.confidence === 'number'
        ? item.confidence
        : Number(item.confidence);
      const confidence = Number.isFinite(rawConfidence)
        ? (rawConfidence > 1 ? rawConfidence / 100 : rawConfidence)
        : 0.8;

      return {
        title: String(item.title).substring(0, 200),
        description: item.description ? String(item.description).substring(0, 1000) : '',
        priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
        dueDate: item.dueDate || null,
        sender: item.sender || null,
        messageTime: item.messageTime || null,
        category: item.category ? String(item.category).substring(0, 50) : null,
        confidence: Math.max(0, Math.min(1, confidence))
      };
    });
  }

  async classifyBusinessSegment(chatContent, options = {}) {
    const previousSummary = options.previousSummary ? String(options.previousSummary).trim() : '';
    const prompt = `你是群聊商机筛选器。请判断下面聊天片段是否包含“值得抓取的商机信息”。

可选标签只有：
- recruitment
- procurement
- resource
- expert
- irrelevant

判定原则：
- 招聘、诚聘、急招、猎头岗位 -> recruitment
- 求购、采购、寻供应商、明确预算/采购需求 -> procurement
- 找渠道、找合作方、找资源、找场地、找服务商 -> resource
- 找顾问、找老师、找专家、找咨询服务 -> expert
- 普通聊天、寒暄、会议安排、无明确需求 -> irrelevant

召回优先：
- 只要片段里有较明确的岗位、需求、联系方式、预算、合作意向、求助方向，就不要判 irrelevant

如果有上一段摘要，可作为上下文参考：
${previousSummary || '无'}

请只返回 JSON 对象：
{
  "label": "recruitment|procurement|resource|expert|irrelevant",
  "confidence": 0.0,
  "shouldExtract": true,
  "summary": "一句话概括片段内容"
}

聊天片段：
${chatContent}`;

    const response = await this.chat(prompt);
    const parsed = this.parseJsonResponse(response) || {};
    const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : Number(parsed.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? (rawConfidence > 1 ? rawConfidence / 100 : rawConfidence)
      : 0;
    const label = ['recruitment', 'procurement', 'resource', 'expert', 'irrelevant'].includes(parsed.label)
      ? parsed.label
      : 'irrelevant';

    return {
      label,
      confidence: Math.max(0, Math.min(1, confidence)),
      shouldExtract: parsed.shouldExtract === true || label !== 'irrelevant',
      summary: parsed.summary ? String(parsed.summary).substring(0, 200) : ''
    };
  }

  async extractBusinessLeads(chatContent, options = {}) {
    const previousSummary = options.previousSummary ? String(options.previousSummary).trim() : '';
    const segmentLabel = options.segmentLabel ? String(options.segmentLabel).trim() : '';
    const categoriesText = this.todoPromptCategories || this.getDefaultTodoPromptCategories();

    const prompt = `请分析以下聊天内容，提取其中的“商机 / 资源类重要信息”。

这里的目标信息主要包括但不限于：
${categoriesText}

以下情况只要出现，就应优先提取：
- 明确招聘、诚聘、急招、猎头岗位、招聘顾问、招聘专家
- 明确求购、采购、寻找供应商、寻找渠道、寻找合作资源
- 明确寻找顾问、老师、专家、咨询服务

以下内容通常不要提取：
- 普通寒暄、确认收到、表情回复
- 一般性见面安排、接送沟通、时间确认
- 没有明确需求、资源、岗位、联系方式、预算、合作意向的信息

上一段摘要（用于补足上下文）：
${previousSummary || '无'}

当前片段预判标签：
${segmentLabel || '未提供'}

聊天内容中，每一行的格式为：
[时间] [发送者]: 消息内容
例如：
[2026/1/17 12:34:02] [张三]: 需要采购一批电脑，请有资源的私聊

请特别注意：
- 如果消息里出现“招聘”“诚聘”“急招”“猎头岗位”等字样，通常应当提取
- 如果消息中包含岗位名称、任职要求、工作地点、薪资、联系方式中的任意两项及以上，应判定为招聘信息
- 同一条消息即使没有截止日期，也可以提取，dueDate 填 null 即可

请将识别出的每条重要信息整理为 JSON 对象，格式如下：
{
  "summary": "该片段的一句话摘要",
  "items": [
    {
      "title": "标题",
      "description": "详细描述",
      "priority": "high|medium|low",
      "dueDate": null,
      "sender": "发送者",
      "messageTime": "2026/4/4 18:58:37",
      "category": "recruitment|procurement|resource|expert",
      "confidence": 0.0
    }
  ]
}

字段要求：
- title: 标题（简要概括这条重要信息）
- description: 详细描述（尽量复述关键细节，便于后续查阅）
- priority: 优先级 (high/medium/low)
- dueDate: 截止日期或时间点（如果聊天中提到了具体时间，如“本周五前”、“3月1日”等，可以用字符串原样写出；如果未提到则为 null）
- sender: 该信息的发送者（从每行开头第二个中括号 [] 中提取，如果没有则为 null）
- messageTime: 消息发送时间（从每行开头第一个中括号 [] 中提取，如 2023/1/1 12:00:00，如果没有则为 null）
- category: 只能是 recruitment、procurement、resource、expert 之一
- confidence: 0 到 1 之间的小数，表示你对这条结果的把握

示例：
输入：
[2026/4/4 18:58:37] [李老师]: 浙江精益企管集团招聘质量驻厂顾问，要求有汽车零部件行业质量主管经验，工作地点浙江，联系电话13800000000。

输出：
{"summary":"群内有人发布浙江地区质量驻厂顾问招聘信息","items":[{"title":"招聘质量驻厂顾问","description":"浙江精益企管集团招聘质量驻厂顾问，要求有汽车零部件行业质量主管经验，工作地点浙江，联系电话13800000000。","priority":"high","dueDate":null,"sender":"李老师","messageTime":"2026/4/4 18:58:37","category":"recruitment","confidence":0.92}]}

聊天内容：
${chatContent}

请只返回 JSON 对象，不要其他内容。如果没有符合上述类型的“重要信息记录”，请返回 {"summary":"","items":[]}。`;

    console.log('[AIService.extractTodos] prompt preview =', prompt.substring(0, 200));
    const response = await this.chat(prompt);
    console.log('[AIService.extractTodos] raw response preview =', String(response).substring(0, 200));
    
    try {
      const parsed = this.parseJsonResponse(response);
      const summary = parsed && typeof parsed.summary === 'string' ? parsed.summary.substring(0, 200) : '';
      const filtered = this.normalizeLeadItems(parsed);
      console.log('[AIService.extractTodos] parsed items =', filtered.length, 'filtered items =', filtered.length);
      return {
        summary,
        items: filtered
      };
    } catch {
      return {
        summary: '',
        items: []
      };
    }
  }

  async extractTodos(chatContent, options = {}) {
    const result = await this.extractBusinessLeads(chatContent, options);
    return result.items;
  }

  async summarize(content) {
    const prompt = `请用简洁的中文总结以下内容的要点：

${content}

要求：
1. 提取关键信息
2. 分点列出
3. 保持简洁明了`;

    return this.chat(prompt);
  }
}

module.exports = AIService;
