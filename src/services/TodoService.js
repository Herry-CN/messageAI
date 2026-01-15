const { v4: uuidv4 } = require('uuid');

class TodoService {
  constructor() {
    this.todos = [];
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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.todos.push(todo);
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

    return this.todos[index];
  }

  delete(id) {
    const index = this.todos.findIndex(t => t.id === id);
    if (index === -1) {
      throw new Error('待办事项不存在');
    }

    this.todos.splice(index, 1);
    return { success: true };
  }

  toggleComplete(id) {
    const todo = this.getById(id);
    if (!todo) {
      throw new Error('待办事项不存在');
    }

    todo.completed = !todo.completed;
    todo.updatedAt = new Date().toISOString();
    return todo;
  }

  async generateFromChat(messages, aiService) {
    if (!messages || messages.length === 0) {
      return [];
    }

    // Combine messages into text for analysis
    const chatContent = messages
      .map(m => `${m.sender}: ${m.content}`)
      .join('\n');

    // Use AI to extract todos
    const extractedTodos = await aiService.extractTodos(chatContent);

    // Create todo items
    const createdTodos = [];
    for (const todoData of extractedTodos) {
      const todo = this.create({
        ...todoData,
        source: 'ai-generated',
        sourceMessage: chatContent.substring(0, 200)
      });
      createdTodos.push(todo);
    }

    return createdTodos;
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
}

module.exports = TodoService;
