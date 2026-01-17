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

  async getStatus() {
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
    if (config.openaiKey) {
      this.openaiKey = config.openaiKey;
    }
    if (config.ollamaUrl) {
      this.ollamaUrl = config.ollamaUrl;
    }
    if (config.model) {
      this.model = config.model;
    }
    if (typeof config.todoPromptCategories === 'string') {
      this.todoPromptCategories = config.todoPromptCategories;
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
          // Prefer qwen, llama, or mistral models
          const preferredModel = models.find(m => 
            m.includes('qwen') || m.includes('llama') || m.includes('mistral')
          ) || models[0];
          this.model = preferredModel;
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
    try {
      const messages = [
        ...context.map(c => ({ role: c.role, content: c.content })),
        { role: 'user', content: message }
      ];

      const response = await axios.post(`${this.ollamaUrl}/api/chat`, {
        model: this.model,
        messages,
        stream: false
      });

      return response.data.message?.content || '';
    } catch (error) {
      throw new Error(`Ollama请求失败: ${error.message}`);
    }
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

  async extractTodos(chatContent) {
    const categoriesText = this.todoPromptCategories || `- 招聘信息（岗位、要求、联系方式等）
- 求购信息（需求物品或服务、预算、时间要求等）
- 寻找资源（寻找合作伙伴、渠道、供应商、场地等）
- 寻找咨询老师或专家（咨询方向、领域、联系方式等）`;

    const prompt = `请分析以下聊天内容，提取其中的“重要信息记录”。重要信息主要包括但不限于：
${categoriesText}

聊天内容中，每一行的格式为：
[时间] [发送者]: 消息内容
例如：
[2026/1/17 12:34:02] [张三]: 需要采购一批电脑，请有资源的私聊

请将识别出的每条重要信息整理为JSON数组格式，每个元素包含：
- title: 标题（简要概括这条重要信息）
- description: 详细描述（尽量复述关键细节，便于后续查阅）
- priority: 优先级 (high/medium/low)
- dueDate: 截止日期或时间点（如果聊天中提到了具体时间，如“本周五前”、“3月1日”等，可以用字符串原样写出；如果未提到则为 null）
- sender: 该信息的发送者（从每行开头第二个中括号 [] 中提取，如果没有则为 null）
- messageTime: 消息发送时间（从每行开头第一个中括号 [] 中提取，如 2023/1/1 12:00:00，如果没有则为 null）

聊天内容：
${chatContent}

请只返回JSON数组，不要其他内容。如果没有符合上述类型的“重要信息记录”，请返回空数组[]。`;

    console.log('[AIService.extractTodos] prompt preview =', prompt.substring(0, 200));
    const response = await this.chat(prompt);
    console.log('[AIService.extractTodos] raw response preview =', String(response).substring(0, 200));
    
    try {
      // Try to parse JSON from response with validation
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Validate that parsed result is an array with expected todo structure
        if (!Array.isArray(parsed)) {
          return [];
        }
        // Filter and validate each todo item
        const filtered = parsed.filter(item => 
          item && 
          typeof item === 'object' &&
          typeof item.title === 'string' &&
          item.title.trim().length > 0
        ).map(item => ({
          title: String(item.title).substring(0, 200),
          description: item.description ? String(item.description).substring(0, 1000) : '',
          priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
          dueDate: item.dueDate || null,
          sender: item.sender || null,
          messageTime: item.messageTime || null
        }));
        console.log('[AIService.extractTodos] parsed items =', parsed.length, 'filtered items =', filtered.length);
        return filtered;
      }
      return [];
    } catch {
      return [];
    }
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
