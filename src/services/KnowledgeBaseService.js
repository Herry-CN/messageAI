const { v4: uuidv4 } = require('uuid');

/**
 * Knowledge Base Service
 * Structures chat data into a searchable knowledge base for AI consumption
 */
class KnowledgeBaseService {
  constructor() {
    this.documents = [];
    this.index = new Map(); // Simple inverted index for search
  }

  getAll() {
    return this.documents;
  }

  /**
   * Index messages into the knowledge base
   */
  async indexMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new Error('messages必须是数组');
    }

    const indexed = [];
    
    for (const message of messages) {
      const doc = this.createDocument(message);
      this.documents.push(doc);
      this.addToIndex(doc);
      indexed.push(doc.id);
    }

    return {
      success: true,
      indexedCount: indexed.length,
      totalDocuments: this.documents.length
    };
  }

  createDocument(message) {
    return {
      id: uuidv4(),
      type: 'message',
      content: message.content,
      metadata: {
        sender: message.sender,
        chatId: message.chatId,
        timestamp: message.timestamp,
        messageType: message.type
      },
      keywords: this.extractKeywords(message.content),
      createdAt: new Date().toISOString()
    };
  }

  extractKeywords(text) {
    if (!text) return [];
    
    // Simple keyword extraction
    // In production, use proper NLP tokenization for Chinese
    const words = text
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);
    
    return [...new Set(words)];
  }

  addToIndex(doc) {
    for (const keyword of doc.keywords) {
      const lowerKeyword = keyword.toLowerCase();
      if (!this.index.has(lowerKeyword)) {
        this.index.set(lowerKeyword, []);
      }
      this.index.get(lowerKeyword).push(doc.id);
    }
  }

  /**
   * Search the knowledge base
   */
  search(query, limit = 20) {
    if (!query) return [];

    const queryKeywords = this.extractKeywords(query);
    const scores = new Map();

    // Score documents based on keyword matches
    for (const keyword of queryKeywords) {
      const lowerKeyword = keyword.toLowerCase();
      const docIds = this.index.get(lowerKeyword) || [];
      
      for (const docId of docIds) {
        const currentScore = scores.get(docId) || 0;
        scores.set(docId, currentScore + 1);
      }
    }

    // Sort by score and return top results
    const sortedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    return sortedIds
      .map(id => this.documents.find(d => d.id === id))
      .filter(Boolean);
  }

  /**
   * Query the knowledge base with AI assistance
   */
  async queryWithAI(question, aiService) {
    // Find relevant documents
    const relevantDocs = this.search(question, 10);

    if (relevantDocs.length === 0) {
      return '知识库中没有找到相关信息。';
    }

    // Build context from documents
    const context = relevantDocs
      .map(doc => `[${doc.metadata.sender}]: ${doc.content}`)
      .join('\n');

    // Use AI to answer based on context
    const prompt = `基于以下聊天记录信息，回答用户的问题。如果信息不足，请如实说明。

相关聊天记录：
${context}

用户问题：${question}

请提供准确、有帮助的回答：`;

    const answer = await aiService.chat(prompt);
    return answer;
  }

  /**
   * Get statistics about the knowledge base
   */
  getStatistics() {
    const totalDocs = this.documents.length;
    const uniqueKeywords = this.index.size;
    
    const bySender = {};
    for (const doc of this.documents) {
      const sender = doc.metadata.sender || 'unknown';
      bySender[sender] = (bySender[sender] || 0) + 1;
    }

    return {
      totalDocuments: totalDocs,
      uniqueKeywords,
      documentsBySender: bySender
    };
  }

  /**
   * Clear the knowledge base
   */
  clear() {
    this.documents = [];
    this.index.clear();
    return { success: true };
  }

  /**
   * Export knowledge base for backup
   */
  export() {
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      documents: this.documents
    };
  }

  /**
   * Import knowledge base from backup
   */
  import(data) {
    if (!data.documents || !Array.isArray(data.documents)) {
      throw new Error('无效的导入数据格式');
    }

    this.clear();
    
    for (const doc of data.documents) {
      this.documents.push(doc);
      this.addToIndex(doc);
    }

    return {
      success: true,
      importedCount: data.documents.length
    };
  }
}

module.exports = KnowledgeBaseService;
