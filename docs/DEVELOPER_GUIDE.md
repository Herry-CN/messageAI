# WeChat AI Assistant - Developer Guide

## 开发者文档

### 项目架构

```
wechat-ai-assistant/
├── src/
│   ├── main/               # Electron主进程
│   │   ├── main.js         # 应用入口
│   │   └── preload.js      # 预加载脚本
│   ├── renderer/           # 渲染进程（前端）
│   │   ├── index.html      # 主页面
│   │   ├── styles.css      # 样式表
│   │   └── app.js          # 前端应用逻辑
│   ├── server/             # 后端服务
│   │   └── index.js        # Express服务器
│   └── services/           # 业务服务
│       ├── AIService.js        # AI服务（Ollama/OpenAI）
│       ├── WeChatService.js    # 微信数据服务
│       ├── TodoService.js      # 待办事项服务
│       └── KnowledgeBaseService.js  # 知识库服务
├── public/                 # 静态资源
├── docs/                   # 文档
├── package.json
└── README.md
```

### 技术栈

- **桌面框架**: Electron
- **后端服务**: Express.js + Socket.IO
- **前端**: 原生 HTML/CSS/JavaScript
- **数据库**: SQLite (微信数据读取)
- **AI集成**: Ollama (本地) / OpenAI (云端)

### 开发环境设置

```bash
# 安装依赖
npm install

# 启动开发模式（服务器 + Electron）
npm run dev

# 仅启动服务器
npm run server

# 构建应用
npm run build
```

### API 文档

#### AI服务

```
GET  /api/ai/status          # 获取AI服务状态
POST /api/ai/config          # 配置AI服务
POST /api/ai/chat            # AI对话
```

#### 微信服务

```
GET  /api/wechat/status      # 获取微信服务状态
POST /api/wechat/configure   # 配置微信数据路径
GET  /api/wechat/contacts    # 获取联系人列表
GET  /api/wechat/groups      # 获取群聊列表
GET  /api/wechat/messages/:chatId  # 获取指定会话消息
POST /api/wechat/monitor/start     # 开始监控
POST /api/wechat/monitor/stop      # 停止监控
```

#### 待办服务

```
GET    /api/todos            # 获取所有待办
POST   /api/todos            # 创建待办
PUT    /api/todos/:id        # 更新待办
DELETE /api/todos/:id        # 删除待办
POST   /api/todos/generate-from-chat  # 从聊天生成待办
```

#### 知识库服务

```
GET  /api/knowledge          # 获取/搜索知识库
POST /api/knowledge/index    # 索引消息
POST /api/knowledge/query    # AI智能查询
```

### 微信数据读取

本项目参考 [WeChatMsg](https://github.com/TC999/WeChatMsg) 的实现思路。

微信PC版在本地存储数据的结构：
- `MicroMsg.db` - 联系人、群聊信息
- `MSG*.db` - 消息内容
- `MediaMSG*.db` - 媒体消息

**注意**: 微信数据库是加密的，需要获取密钥才能读取。实际生产环境中需要实现数据库解密功能。

### 扩展开发

#### 添加新的AI提供者

1. 在 `AIService.js` 中添加新的提供者方法
2. 在 `autoDetectProvider()` 中添加检测逻辑
3. 在 `chat()` 方法中添加路由

#### 添加新功能页面

1. 在 `index.html` 中添加导航项和页面容器
2. 在 `app.js` 中添加页面逻辑
3. 在 `styles.css` 中添加样式

### 构建与发布

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

构建产物位于 `dist/` 目录。

### 贡献指南

1. Fork 本仓库
2. 创建功能分支
3. 提交更改
4. 发起 Pull Request

### License

MIT License
