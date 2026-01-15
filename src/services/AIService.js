const axios = require('axios');

class AIService {
  constructor() {
    this.provider = null;
    this.ollamaUrl = 'http://localhost:11434';
    this.openaiUrl = 'https://api.openai.com/v1';
    this.openaiKey = null;
    this.model = null;
    this.isReady = false;
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
      ollamaModels: ollamaAvailable ? await this.getOllamaModels() : []
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
    const prompt = `请分析以下聊天内容，提取其中的待办事项。返回JSON数组格式，每个待办包含：
- title: 待办标题
- description: 详细描述
- priority: 优先级 (high/medium/low)
- dueDate: 截止日期（如果提到）

聊天内容：
${chatContent}

请只返回JSON数组，不要其他内容。如果没有待办事项，返回空数组[]。`;

    const response = await this.chat(prompt);
    
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
        return parsed.filter(item => 
          item && 
          typeof item === 'object' &&
          typeof item.title === 'string' &&
          item.title.trim().length > 0
        ).map(item => ({
          title: String(item.title).substring(0, 200),
          description: item.description ? String(item.description).substring(0, 1000) : '',
          priority: ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
          dueDate: item.dueDate || null
        }));
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
