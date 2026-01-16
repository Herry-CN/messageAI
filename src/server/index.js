const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Import services
const AIService = require('../services/AIService');
const WeChatService = require('../services/WeChatService');
const TodoService = require('../services/TodoService');
const KnowledgeBaseService = require('../services/KnowledgeBaseService');

// Allowed origins for CORS - restrict to local access only
const ALLOWED_ORIGINS = [
  'http://localhost:3847',
  'http://127.0.0.1:3847',
  'file://' // Electron file protocol
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Electron, or curl)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed) || allowed === origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: corsOptions
});

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Initialize services
const aiService = new AIService();
const wechatService = new WeChatService();
const todoService = new TodoService();
const knowledgeBaseService = new KnowledgeBaseService();

// Auto-configure with user provided path
const USER_DATA_PATH = 'C:\\Users\\hearl\\Documents\\EchoTrace\\LyraHerry';
console.log('Attempting to auto-configure WeChat data path:', USER_DATA_PATH);
wechatService.configure(USER_DATA_PATH).then(result => {
  console.log('Auto-configuration result:', result);
}).catch(err => {
  console.error('Auto-configuration failed:', err);
});

// API Routes

// AI Configuration
app.get('/api/ai/status', async (req, res) => {
  try {
    const status = await aiService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/config', async (req, res) => {
  try {
    const config = await aiService.configure(req.body);
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const response = await aiService.chat(message, context);
    res.json({ response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WeChat Routes
app.get('/api/wechat/status', (req, res) => {
  try {
    const status = wechatService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wechat/configure', async (req, res) => {
  try {
    const { dataPath, dbKey } = req.body;
    const result = await wechatService.configure(dataPath, dbKey);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wechat/contacts', async (req, res) => {
  try {
    const contacts = await wechatService.getContacts();
    res.json(contacts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wechat/groups', async (req, res) => {
  try {
    const groups = await wechatService.getGroups();
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/wechat/messages/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;
    const { limit = 100, offset = 0, startTime = 0 } = req.query;
    const messages = await wechatService.getMessages(chatId, parseInt(limit), parseInt(offset), parseInt(startTime));
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wechat/monitor/start', async (req, res) => {
  try {
    const { groupIds } = req.body;
    await wechatService.startMonitoring(groupIds, (message) => {
      io.emit('new-message', message);
    });
    res.json({ success: true, message: '监控已启动' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/wechat/monitor/stop', (req, res) => {
  try {
    wechatService.stopMonitoring();
    res.json({ success: true, message: '监控已停止' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Todo Routes
app.get('/api/todos', (req, res) => {
  try {
    const todos = todoService.getAll();
    res.json(todos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/todos', (req, res) => {
  try {
    const todo = todoService.create(req.body);
    res.json(todo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/todos/:id', (req, res) => {
  try {
    const { id } = req.params;
    const todo = todoService.update(id, req.body);
    res.json(todo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/todos/:id', (req, res) => {
  try {
    const { id } = req.params;
    todoService.delete(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/todos/generate-from-chat', async (req, res) => {
  try {
    const { messages, chatName } = req.body;
    console.log('[Server] /api/todos/generate-from-chat messages length =', messages ? messages.length : 0);
    const todos = await todoService.generateFromChat(messages, aiService, chatName);
    console.log('[Server] /api/todos/generate-from-chat todos length =', todos.length);
    res.json(todos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Knowledge Base Routes
app.get('/api/knowledge', (req, res) => {
  try {
    const { query } = req.query;
    const results = query 
      ? knowledgeBaseService.search(query)
      : knowledgeBaseService.getAll();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/knowledge/index', async (req, res) => {
  try {
    const { messages } = req.body;
    const result = await knowledgeBaseService.indexMessages(messages);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/knowledge/query', async (req, res) => {
  try {
    const { question } = req.body;
    const answer = await knowledgeBaseService.queryWithAI(question, aiService);
    res.json({ answer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO events
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('subscribe-group', (groupId) => {
    socket.join(`group-${groupId}`);
    console.log(`Client ${socket.id} subscribed to group ${groupId}`);
  });
  
  socket.on('unsubscribe-group', (groupId) => {
    socket.leave(`group-${groupId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
const PORT = process.env.PORT || 3847;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (process.send) {
    process.send({ type: 'ready', port: PORT });
  }
});

module.exports = { app, io };
