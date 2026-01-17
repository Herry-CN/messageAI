const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TODO_FILE = path.join(DATA_DIR, 'todos.json');

class TodoService {
  constructor() {
    this.todos = [];
    this.loadFromDisk();
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

  async generateFromChat(messages, aiService, chatName) {
    if (!messages || messages.length === 0) {
      return [];
    }

    console.log('[TodoService] generateFromChat messages length =', messages.length);

    const existingKeys = new Set(
      this.todos
        .filter(t => t.groupName === chatName && t.sender && t.messageTime)
        .map(t => `${t.groupName}||${t.sender}||${t.messageTime}`)
    );

    const filteredMessages = [];
    for (const m of messages) {
      const timeStr = new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false });
      const sender = m.sender || '';
      const key = `${chatName}||${sender}||${timeStr}`;
      if (existingKeys.has(key)) {
        console.log('[TodoService] skip message already in todos:', key);
        continue;
      }
      filteredMessages.push({ ...m, _timeStr: timeStr });
    }

    if (filteredMessages.length === 0) {
      console.log('[TodoService] generateFromChat all messages skipped due to existing todos');
      return [];
    }

    const chatContent = filteredMessages
      .map(m => {
        const timeStr = m._timeStr || new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false });
        return `[${timeStr}] [${m.sender}]: ${m.content}`;
      })
      .join('\n');

    console.log('[TodoService] generateFromChat chatContent sample =', chatContent.substring(0, 200));
    const extractedTodos = await aiService.extractTodos(chatContent);
    console.log('[TodoService] generateFromChat extractedTodos =', extractedTodos);

    const createdTodos = [];
    for (const todoData of extractedTodos) {
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
        sourceMessage: chatContent
      });
      createdTodos.push(todo);
    }

    return createdTodos;
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

  saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(TODO_FILE, JSON.stringify(this.todos, null, 2), 'utf-8');
    } catch {
    }
  }
}

module.exports = TodoService;
