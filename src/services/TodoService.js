const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const LEGACY_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LEGACY_TODO_FILE = path.join(LEGACY_DATA_DIR, 'todos.json');

function resolveDataDir() {
  if (process.env.APP_USER_DATA_PATH) {
    return path.join(process.env.APP_USER_DATA_PATH, 'data');
  }
  return LEGACY_DATA_DIR;
}

const DATA_DIR = resolveDataDir();
const TODO_FILE = path.join(DATA_DIR, 'todos.json');

class TodoService {
  constructor() {
    this.todos = [];
    this.migrateLegacyDataIfNeeded();
    this.loadFromDisk();
  }

  getStorageInfo() {
    return {
      dataDir: DATA_DIR,
      todoFile: TODO_FILE,
      legacyTodoFile: LEGACY_TODO_FILE
    };
  }

  getAll() {
    return this.todos.sort((a, b) => {
      // Sort by: incomplete first, then by priority, then by due date
      if (a.completed !== b.completed) {
        return a.completed ? 1 : -1;
      }
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      if (a.dueDate && b.dueDate) {
        return new Date(a.dueDate) - new Date(b.dueDate);
      }
      return 0;
    });
  }

  getById(id) {
    return this.todos.find(t => t.id === id);
  }

  create(todoData) {
    const todo = {
      id: uuidv4(),
      title: todoData.title,
      description: todoData.description || '',
      priority: todoData.priority || 'medium',
      dueDate: todoData.dueDate || null,
      completed: false,
      source: todoData.source || 'manual',
      sourceMessage: todoData.sourceMessage || null,
      
      // New fields
      groupName: todoData.groupName || null,
      sender: todoData.sender || null,
      messageTime: todoData.messageTime || null,
      category: todoData.category || null,
      confidence: typeof todoData.confidence === 'number' ? todoData.confidence : null,

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.todos.push(todo);
    this.saveToDisk();
    return todo;
  }

  update(id, updates) {
    const index = this.todos.findIndex(t => t.id === id);
    if (index === -1) {
      throw new Error('待办事项不存在');
    }

    this.todos[index] = {
      ...this.todos[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    this.saveToDisk();
    return this.todos[index];
  }

  delete(id) {
    const index = this.todos.findIndex(t => t.id === id);
    if (index === -1) {
      throw new Error('待办事项不存在');
    }

    this.todos.splice(index, 1);
    this.saveToDisk();
    return { success: true };
  }

  deleteAll() {
    const count = this.todos.length;
    this.todos = [];
    this.saveToDisk();
    return { success: true, count };
  }

  toggleComplete(id) {
    const todo = this.getById(id);
    if (!todo) {
      throw new Error('待办事项不存在');
    }

    todo.completed = !todo.completed;
    todo.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return todo;
  }

  async generateFromChat(messages, aiService, chatName, options = {}) {
    if (!messages || messages.length === 0) {
      return [];
    }

    console.log('[TodoService] generateFromChat messages length =', messages.length);

    const normalizedMessages = this.normalizeBusinessMessages(messages);
    if (normalizedMessages.length === 0) {
      return [];
    }

    const segments = this.buildBusinessSegments(normalizedMessages);
    console.log('[TodoService] generateFromChat segment count =', segments.length);

    const extractedTodos = [];
    let firstBatchError = null;
    let previousSummary = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      console.log(`[TodoService] generateFromChat segment ${i + 1}/${segments.length} chars = ${segment.chatContent.length}`);

      const ruleTodos = this.fallbackExtractImportantMessages(segment.messages).map(todo => ({
        ...todo,
        sourceMessage: segment.chatContent,
        segmentIndex: i,
        segmentSummary: segment.segmentSummary
      }));

      let classification = {
        label: segment.primaryLabel || 'irrelevant',
        confidence: segment.ruleScore,
        shouldExtract: segment.ruleScore >= 0.45,
        summary: segment.segmentSummary
      };

      try {
        const aiClassification = await aiService.classifyBusinessSegment(segment.chatContent, {
          previousSummary,
          chatName
        });
        classification = {
          label: aiClassification.label || classification.label,
          confidence: Math.max(aiClassification.confidence || 0, classification.confidence || 0),
          shouldExtract: aiClassification.shouldExtract || classification.shouldExtract || ruleTodos.length > 0,
          summary: aiClassification.summary || classification.summary
        };
      } catch (error) {
        console.error(`[TodoService] classify segment ${i + 1} failed:`, error.message);
        if (!firstBatchError) {
          firstBatchError = error;
        }
      }

      const shouldExtract = ruleTodos.length > 0 || (classification.label !== 'irrelevant' && classification.confidence >= 0.45);
      let aiItems = [];

      if (shouldExtract) {
        try {
          const extracted = await aiService.extractBusinessLeads(segment.chatContent, {
            previousSummary,
            chatName,
            segmentLabel: classification.label
          });
          aiItems = (extracted.items || []).map(todo => ({
            ...todo,
            sourceMessage: segment.chatContent,
            segmentIndex: i,
            segmentSummary: extracted.summary || classification.summary
          }));
          if (extracted.summary) {
            previousSummary = this.mergeRollingSummary(previousSummary, extracted.summary);
          } else if (classification.summary) {
            previousSummary = this.mergeRollingSummary(previousSummary, classification.summary);
          }
        } catch (error) {
          console.error(`[TodoService] extract segment ${i + 1} failed:`, error.message);
          if (!firstBatchError) {
            firstBatchError = error;
          }
        }
      }

      if (!aiItems.length && classification.summary) {
        previousSummary = this.mergeRollingSummary(previousSummary, classification.summary);
      }

      const merged = this.mergeLeadCandidates([...aiItems, ...ruleTodos]);
      if (merged.length > 0) {
        extractedTodos.push(...merged);
      }
    }

    const thresholdFromOptions = Number(options.confidenceThreshold);
    const confidenceThreshold = Number.isFinite(thresholdFromOptions) && thresholdFromOptions >= 0.5 && thresholdFromOptions <= 0.95
      ? thresholdFromOptions
      : 0.75;

    const filteredTodos = extractedTodos.filter(todo => {
      const confidence = typeof todo.confidence === 'number' ? todo.confidence : 0.8;
      return confidence >= confidenceThreshold;
    });

    if (filteredTodos.length === 0 && firstBatchError) {
      throw firstBatchError;
    }

    const createdTodos = [];
    for (const todoData of filteredTodos) {
      // Check for duplicates before creating
      const isDuplicate = this.todos.some(existing => {
        // Must be from same group
        if (existing.groupName !== chatName) return false;
        
        // Strategy 1: AI extracted exact same message timestamp and sender
        if (todoData.messageTime && todoData.sender && 
            existing.messageTime === todoData.messageTime && 
            existing.sender === todoData.sender) {
          return true;
        }

        // Strategy 2: Title similarity check (exact match or very similar)
        if (existing.title === todoData.title) return true;
        
        // Strategy 3: Content overlap check (if description is long enough)
        // This prevents same task with slightly different AI wording
        if (todoData.description && existing.description && 
            todoData.description.length > 10 && existing.description.length > 10) {
          const similarity = this.calculateSimilarity(todoData.description, existing.description);
          if (similarity > 0.8) return true;
        }

        return false;
      });

      if (isDuplicate) {
        console.log('[TodoService] Skipping duplicate todo:', todoData.title);
        continue;
      }

      const todo = this.create({
        ...todoData,
        groupName: chatName,
        source: 'ai-generated',
        sourceMessage: todoData.sourceMessage
      });
      createdTodos.push(todo);
    }

    return createdTodos;
  }

  normalizeBusinessMessages(messages) {
    return messages.map(m => {
      const rawTimestamp = Number(m.timestamp) || Date.now();
      const normalizedTimestamp = rawTimestamp < 1000000000000 ? rawTimestamp * 1000 : rawTimestamp;
      const timeStr = new Date(normalizedTimestamp).toLocaleString('zh-CN', { hour12: false });
      const sender = m.sender || '';
      const content = m.content == null ? '' : String(m.content);
      const messageLine = `[${timeStr}] [${sender}]: ${content}`;
      const signals = this.detectBusinessSignals(content);
      return {
        ...m,
        timestamp: normalizedTimestamp,
        _timeStr: timeStr,
        _messageLine: messageLine,
        _signals: signals
      };
    }).filter(m => m._messageLine && m._messageLine.trim()).sort((a, b) => a.timestamp - b.timestamp);
  }

  detectBusinessSignals(content) {
    const text = String(content || '');
    const labelPatterns = [
      { label: 'recruitment', regex: /(招聘|诚聘|急招|猎头|岗位|任职要求|JD|薪资|简历)/i, score: 1 },
      { label: 'procurement', regex: /(求购|采购|寻购|供应商|报价|预算|询价)/i, score: 1 },
      { label: 'resource', regex: /(资源|渠道|合作方|合作伙伴|服务商|仓储|物流|财务|法务|保险|场地)/i, score: 0.9 },
      { label: 'expert', regex: /(老师|专家|顾问|咨询服务|咨询老师|咨询专家)/i, score: 0.8 }
    ];

    const labels = [];
    let score = 0;
    for (const pattern of labelPatterns) {
      if (pattern.regex.test(text)) {
        labels.push(pattern.label);
        score += pattern.score;
      }
    }

    if (/(微信|电话|联系|私聊|vx|V:|☎|手机)/i.test(text)) score += 0.2;
    if (/(地点|城市|坐标|薪资|待遇|预算|截止|本周|本月|尽快)/i.test(text)) score += 0.2;

    return {
      labels,
      score: Math.min(1, score),
      isRelevant: labels.length > 0 || score >= 0.7
    };
  }

  buildBusinessSegments(messages) {
    const MAX_CHARS_PER_SEGMENT = 2200;
    const MAX_MESSAGES_PER_SEGMENT = 25;
    const MAX_TIME_GAP_MS = 45 * 60 * 1000;
    const segments = [];
    let current = null;

    const finalize = () => {
      if (!current || current.messages.length === 0) return;
      current.chatContent = current.messages.map(m => m._messageLine).join('\n');
      current.primaryLabel = this.pickPrimaryLabel(current.labelCounts);
      current.ruleScore = Math.max(0, Math.min(1, current.ruleScore / Math.max(current.messages.length, 1)));
      current.segmentSummary = this.buildSegmentSummary(current.messages, current.primaryLabel);
      segments.push(current);
      current = null;
    };

    for (const message of messages) {
      const lastMessage = current && current.messages.length > 0 ? current.messages[current.messages.length - 1] : null;
      const gap = lastMessage ? message.timestamp - lastMessage.timestamp : 0;
      const nextLength = (current ? current.charCount : 0) + message._messageLine.length + 1;
      const nextPrimaryLabel = message._signals.labels[0] || null;
      const shouldSplit = !!current && (
        gap > MAX_TIME_GAP_MS ||
        nextLength > MAX_CHARS_PER_SEGMENT ||
        current.messages.length >= MAX_MESSAGES_PER_SEGMENT ||
        (nextPrimaryLabel && current.primaryLabel && nextPrimaryLabel !== current.primaryLabel && gap > 10 * 60 * 1000)
      );

      if (!current || shouldSplit) {
        finalize();
        current = {
          messages: [],
          charCount: 0,
          labelCounts: {},
          primaryLabel: nextPrimaryLabel,
          ruleScore: 0
        };
      }

      current.messages.push(message);
      current.charCount += message._messageLine.length + 1;
      current.ruleScore += message._signals.score || 0;
      for (const label of message._signals.labels) {
        current.labelCounts[label] = (current.labelCounts[label] || 0) + 1;
      }
      if (!current.primaryLabel && nextPrimaryLabel) {
        current.primaryLabel = nextPrimaryLabel;
      }
    }

    finalize();
    return segments;
  }

  pickPrimaryLabel(labelCounts) {
    const entries = Object.entries(labelCounts || {});
    if (entries.length === 0) return 'irrelevant';
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  buildSegmentSummary(messages, primaryLabel) {
    if (!messages || messages.length === 0) return '';
    const lastRelevant = [...messages].reverse().find(m => m._signals.isRelevant) || messages[messages.length - 1];
    const base = String(lastRelevant.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!base) return '';
    return `${primaryLabel || 'segment'}:${base}`;
  }

  mergeRollingSummary(previousSummary, nextSummary) {
    const parts = [previousSummary, nextSummary].filter(Boolean).map(item => String(item).trim()).filter(Boolean);
    const merged = parts.slice(-2).join('；');
    return merged.slice(-240);
  }

  mergeLeadCandidates(items) {
    const merged = [];

    for (const item of items) {
      if (!item || !item.title) continue;
      const currentConfidence = typeof item.confidence === 'number' ? item.confidence : 0.8;
      const existing = merged.find(candidate => this.isDuplicateLeadCandidate(candidate, item));
      if (!existing) {
        merged.push(item);
        continue;
      }

      const existingConfidence = typeof existing.confidence === 'number' ? existing.confidence : 0.8;
      if (currentConfidence > existingConfidence) {
        Object.assign(existing, item);
      }
    }

    return merged;
  }

  isDuplicateLeadCandidate(left, right) {
    if (!left || !right) return false;
    if (left.messageTime && right.messageTime && left.sender && right.sender) {
      if (left.messageTime === right.messageTime && left.sender === right.sender) return true;
    }
    if (left.title && right.title && left.title === right.title) return true;
    if (left.description && right.description) {
      return this.calculateSimilarity(left.description, right.description) > 0.82;
    }
    return false;
  }

  fallbackExtractImportantMessages(messages) {
    const results = [];
    const seen = new Set();

    for (const m of messages) {
      const content = m.content == null ? '' : String(m.content).trim();
      const sender = m.sender || null;
      const messageTime = m._timeStr || new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false });
      if (!content) continue;

      let title = null;
      let priority = 'medium';
      let category = null;
      let confidence = 0.8;

      if (/(招聘|诚聘|急招|猎头)/.test(content)) {
        title = this.extractTitleFromContent(content, /(招聘|诚聘|急招|猎头)/);
        priority = 'high';
        category = 'recruitment';
        confidence = 0.9;
      } else if (/(求购|采购|寻购|找供应商)/.test(content)) {
        title = this.extractTitleFromContent(content, /(求购|采购|寻购|找供应商)/);
        priority = 'high';
        category = 'procurement';
        confidence = 0.88;
      } else if (/(找资源|寻找资源|找渠道|找合作|找场地)/.test(content)) {
        title = this.extractTitleFromContent(content, /(找资源|寻找资源|找渠道|找合作|找场地)/);
        category = 'resource';
        confidence = 0.82;
      } else if (/(找老师|找专家|咨询老师|咨询专家|顾问)/.test(content)) {
        title = this.extractTitleFromContent(content, /(找老师|找专家|咨询老师|咨询专家|顾问)/);
        category = 'expert';
        confidence = 0.8;
      }

      if (!title) continue;

      const key = `${sender || ''}||${messageTime}||${title}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        title,
        description: content.slice(0, 500),
        priority,
        dueDate: null,
        sender,
        messageTime,
        category,
        confidence
      });
    }

    return results;
  }

  extractTitleFromContent(content, keywordRegex) {
    const lines = String(content).split('\n').map(line => line.trim()).filter(Boolean);
    const matchedLine = lines.find(line => keywordRegex.test(line)) || lines[0] || '';
    return matchedLine.slice(0, 60);
  }

  // Simple similarity check (Levenshtein distance based or Jaccard index)
  // Here we implement a simple Jaccard index for character n-grams
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = new Set(str1.split(''));
    const s2 = new Set(str2.split(''));
    const intersection = new Set([...s1].filter(x => s2.has(x)));
    const union = new Set([...s1, ...s2]);
    return intersection.size / union.size;
  }

  getStatistics() {
    const total = this.todos.length;
    const completed = this.todos.filter(t => t.completed).length;
    const pending = total - completed;
    const overdue = this.todos.filter(t => {
      if (t.completed || !t.dueDate) return false;
      return new Date(t.dueDate) < new Date();
    }).length;

    const byPriority = {
      high: this.todos.filter(t => t.priority === 'high' && !t.completed).length,
      medium: this.todos.filter(t => t.priority === 'medium' && !t.completed).length,
      low: this.todos.filter(t => t.priority === 'low' && !t.completed).length
    };

    return {
      total,
      completed,
      pending,
      overdue,
      byPriority
    };
  }

  loadFromDisk() {
    try {
      if (!fs.existsSync(TODO_FILE)) {
        this.todos = [];
        return;
      }
      const content = fs.readFileSync(TODO_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        this.todos = parsed;
      } else {
        this.todos = [];
      }
    } catch {
      this.todos = [];
    }
  }

  migrateLegacyDataIfNeeded() {
    try {
      if (TODO_FILE === LEGACY_TODO_FILE) {
        return;
      }

      if (fs.existsSync(TODO_FILE)) {
        return;
      }

      if (!fs.existsSync(LEGACY_TODO_FILE)) {
        return;
      }

      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.copyFileSync(LEGACY_TODO_FILE, TODO_FILE);
    } catch (error) {
      console.error('[TodoService] migrateLegacyDataIfNeeded failed:', error.message);
    }
  }

  saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(TODO_FILE, JSON.stringify(this.todos, null, 2), 'utf-8');
    } catch (error) {
      console.error('[TodoService] saveToDisk failed:', error.message);
    }
  }
}

module.exports = TodoService;
