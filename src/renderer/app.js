/**
 * WeChat AI Assistant - Frontend Application
 * 微信AI助手 - 前端应用
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - The string to escape
 * @returns {string} - The escaped string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return str.replace(/[&<>"']/g, m => map[m]);
}

class WeChatAIApp {
  constructor() {
    this.serverPort = 3847;
    this.currentPage = 'dashboard';
    this.currentChatId = null;
    this.currentChatType = 'contacts';
    this.messages = [];
    this.todos = [];
    this.currentTodoFilter = 'all';
    this.contacts = [];
    this.groups = [];
    this.monitoringGroups = [];
    this.isMonitoring = false;
    this.socket = null;
    this.chatHistory = [];
    this.isUsingDemoData = true; // Track if using demo/sample data
    this.messagePageLimit = 50;
    this.aiAnalysisHours = 1;
    this.leadConfidenceThreshold = 0.75;
    this.batchSelectedGroupIds = [];
    this.chatListShowOnlySelected = false;
    this.autoBatchIntervalMinutes = 5;
    this.autoBatchTimer = null;
    this.autoBatchNextRunAt = null;
    this.autoBatchCountdownTimer = null;
    this.lastAINotReadyToastAt = 0;

    this.init();
  }

  async init() {
    // Get server port from Electron if available
    if (window.electronAPI) {
      try {
        this.serverPort = await window.electronAPI.getServerPort();
      } catch (e) {
        console.log('Using default server port');
      }
    }

    // Load message page limit from localStorage
    const savedLimit = localStorage.getItem('messagePageLimit');
    if (savedLimit) {
      const n = parseInt(savedLimit, 10);
      if (!Number.isNaN(n) && n > 0 && n <= 500) {
        this.messagePageLimit = n;
      }
    }

    const savedHours = localStorage.getItem('aiAnalysisHours');
    if (savedHours) {
      const h = parseInt(savedHours, 10);
      if (!Number.isNaN(h) && h >= 1 && h <= 48) {
        this.aiAnalysisHours = h;
      }
    }

    const savedConfidenceThreshold = localStorage.getItem('leadConfidenceThreshold');
    if (savedConfidenceThreshold) {
      const n = parseFloat(savedConfidenceThreshold);
      if (!Number.isNaN(n) && n >= 0.5 && n <= 0.95) {
        this.leadConfidenceThreshold = n;
      }
    }

    const batchConfigRaw = localStorage.getItem('batchTodoSettings');
    if (batchConfigRaw) {
      try {
        const cfg = JSON.parse(batchConfigRaw);
        if (Array.isArray(cfg.selectedGroupIds)) {
          this.batchSelectedGroupIds = cfg.selectedGroupIds.map(id => String(id));
        }
        if (typeof cfg.autoIntervalMinutes === 'number' && cfg.autoIntervalMinutes >= 5) {
          this.autoBatchIntervalMinutes = cfg.autoIntervalMinutes;
        }
      } catch {}
    }

    // Auto-configure from localStorage if available
    const savedPath = localStorage.getItem('wechatDataPath');
    if (savedPath) {
      console.log('Restoring saved WeChat path:', savedPath);
      await this.configureWechat(savedPath, true);
    }

    this.setupNavigation();
    this.setupEventListeners();
    
    // Only load initial data if not already loaded by configureWechat
    if (!savedPath) {
      await this.loadInitialData();
    }

    this.setupWebSocket();
    this.checkAIStatus();
    this.startAutoBatchExtract();
  }

  setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        this.navigateTo(page);
      });
    });

    // Handle navigation from Electron
    if (window.electronAPI) {
      window.electronAPI.onNavigate((page) => {
        this.navigateTo(page);
      });
    }
  }

  setupEventListeners() {
    // Chat tabs
    document.querySelectorAll('.chat-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        this.currentChatType = e.target.dataset.type;
        this.renderChatList();
      });
    });

    // Todo filters
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.filterTodos(e.target.dataset.filter);
      });
    });

    // Chat search
    const chatSearch = document.getElementById('chat-search');
    if (chatSearch) {
      chatSearch.addEventListener('input', () => this.renderChatList());
    }

    // Monitor group search
    const monitorGroupSearch = document.getElementById('monitor-group-search');
    if (monitorGroupSearch) {
      monitorGroupSearch.addEventListener('input', () => this.renderMonitorGroups());
    }

    // Enter key for todo input
    const todoInput = document.getElementById('new-todo-input');
    if (todoInput) {
      todoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.addTodo();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('todo-detail-modal');
        if (modal && modal.classList.contains('active')) {
          this.closeTodoDetail();
        }
      }
    });
  }

  navigateTo(page) {
    // Update navigation
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });

    // Update pages
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === `page-${page}`);
    });

    this.currentPage = page;

    // Load page-specific data
    this.loadPageData(page);
  }

  async loadPageData(page) {
    switch (page) {
      case 'dashboard':
        this.updateDashboard();
        break;
      case 'messages':
        await this.loadContacts();
        await this.loadGroups();
        this.renderChatList();
        break;
      case 'monitor':
        await this.loadGroups();
        this.renderMonitorGroups();
        break;
      case 'todos':
        await this.loadTodos();
        break;
      case 'knowledge':
        await this.loadKnowledge();
        break;
      case 'settings':
        await this.loadSettings();
        break;
    }
  }

  async loadInitialData() {
    try {
      // All data loading runs concurrently - updateDemoModeIndicators 
      // runs after all promises complete, so isUsingDemoData is set
      await Promise.all([
        this.checkWeChatStatus(),
        this.loadContacts(),
        this.loadGroups(),
        this.loadTodos()
      ]);
      this.updateDashboard();
      this.updateDemoModeIndicators();
    } catch (error) {
      console.error('Failed to load initial data:', error);
    }
  }

  async checkWeChatStatus() {
    try {
      const status = await this.api('/api/wechat/status');
      this.isUsingDemoData = status.isUsingDemoData === true;
    } catch {
      this.isUsingDemoData = true;
    }
  }

  updateDemoModeIndicators() {
    // Update dashboard notice
    const dashboardNotice = document.getElementById('dashboard-demo-notice');
    if (dashboardNotice) {
      dashboardNotice.style.display = this.isUsingDemoData ? 'block' : 'none';
    }
  }

  setupWebSocket(retryCount = 0) {
    try {
      if (typeof io !== 'undefined') {
        console.log(`Attempting to connect to WebSocket at http://localhost:${this.serverPort}`);
        this.socket = io(`http://localhost:${this.serverPort}`);
        
        this.socket.on('connect', () => {
          console.log('Connected to WebSocket server with ID:', this.socket.id);
          this.showToast('实时监控连接成功', 'success');
        });

        this.socket.on('connect_error', (error) => {
          console.error('WebSocket connection error:', error);
          this.showToast('实时监控连接失败: ' + error.message, 'error');
        });

        this.socket.on('new-message', (message) => {
          console.log('Received new message:', message);
          if (this.isMonitoring) {
            console.log('Monitoring active. Checked groups:', this.monitoringGroups);
            console.log('Message chat ID:', message.chatId);
            
             // Check if message belongs to monitored groups
             // Use loose comparison or string conversion to ensure match
             if (this.monitoringGroups.some(id => String(id) === String(message.chatId))) {
               console.log('Message matches monitored group, adding to feed');
               this.addFeedMessage(message);
             } else {
               console.log('Message ignored: Chat ID not in monitored groups');
             }
          } else {
            console.log('Monitoring not active, ignoring message');
          }
        });
      } else {
        if (retryCount < 20) {
          console.log(`Socket.IO client not loaded yet, retrying (${retryCount + 1}/20)...`);
          setTimeout(() => this.setupWebSocket(retryCount + 1), 500);
          return;
        }
        console.warn('Socket.IO client not loaded, falling back to polling if needed');
        this.pollForMessages();
      }
    } catch (error) {
      console.error('WebSocket setup failed:', error);
    }
  }

  pollForMessages() {
    setInterval(async () => {
      if (this.isMonitoring) {
        // Polling endpoint for new messages would go here
      }
    }, 5000);
  }

  // API Helper
  async api(endpoint, options = {}) {
    const url = `http://localhost:${this.serverPort}${endpoint}`;
    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });
      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
      }
      if (!response.ok) {
        throw new Error(data && data.error ? data.error : `请求失败(${response.status})`);
      }
      return data;
    } catch (error) {
      console.error(`API Error (${endpoint}):`, error);
      throw error;
    }
  }

  async ensureAIReady() {
    try {
      const status = await this.api('/api/ai/status');
      if (status && status.isReady === true) return true;
    } catch {}

    const now = Date.now();
    if (!this.lastAINotReadyToastAt || now - this.lastAINotReadyToastAt > 60000) {
      this.lastAINotReadyToastAt = now;
      this.showToast('AI未就绪，请先在设置中配置Ollama或OpenAI', 'warning');
    }
    return false;
  }

  // Dashboard
  updateDashboard() {
    document.getElementById('stat-contacts').textContent = this.contacts.length;
    document.getElementById('stat-groups').textContent = this.groups.length;
    document.getElementById('stat-todos').textContent = this.todos.filter(t => !t.completed).length;
    // Knowledge base stats would be updated similarly
  }

  // Contacts & Groups
  async loadContacts() {
    try {
      this.contacts = await this.api('/api/wechat/contacts');
    } catch {
      // Use sample data if server not available
      this.contacts = [
        { id: 'wxid_001', name: '张三', avatar: null, type: 'friend' },
        { id: 'wxid_002', name: '李四', avatar: null, type: 'friend' },
        { id: 'wxid_003', name: '王五', avatar: null, type: 'friend' }
      ];
    }
  }

  async loadGroups() {
    try {
      this.groups = await this.api('/api/wechat/groups');
    } catch {
      this.groups = [
        { id: 'group_001', name: '工作群', memberCount: 25 },
        { id: 'group_002', name: '项目讨论组', memberCount: 8 },
        { id: 'group_003', name: '技术交流群', memberCount: 120 }
      ];
    }
  }

  renderChatList() {
    const container = document.getElementById('chat-items');
    const searchTerm = document.getElementById('chat-search')?.value.toLowerCase() || '';
    
    const items = this.currentChatType === 'contacts' ? this.contacts : this.groups;
    let filtered = items.filter(item => 
      item.name.toLowerCase().includes(searchTerm)
    );

    const isGroupList = this.currentChatType === 'groups';
    if (isGroupList && this.chatListShowOnlySelected) {
      filtered = filtered.filter(item => this.batchSelectedGroupIds.includes(String(item.id)));
    }

    // Add demo mode notice if using sample data
    const demoNotice = this.isUsingDemoData ? `
      <div class="demo-notice">
        <span class="demo-notice-icon">ℹ️</span>
        <span>当前显示的是示例数据。请在设置中配置微信数据目录以查看真实数据。</span>
      </div>
    ` : '';

    const batchControls = isGroupList ? `
      <div class="chat-list-batch-controls">
        <button type="button" class="link-button" onclick="app.selectAllVisibleGroups()">全选当前列表</button>
        <button type="button" class="link-button" onclick="app.deselectAllVisibleGroups()">取消当前列表选择</button>
        <button type="button" class="link-button" onclick="app.clearAllGroupSelections()">清空全部选择</button>
        <label class="only-selected-toggle">
          <input type="checkbox" ${this.chatListShowOnlySelected ? 'checked' : ''} onchange="app.toggleShowOnlySelected(this.checked)">
          只看已选群
        </label>
        <button type="button" class="link-button" onclick="app.exportGroupSelection()">导出群选择</button>
        <button type="button" class="link-button" onclick="app.importGroupSelection()">导入群选择</button>
        <span class="auto-batch-status" id="auto-batch-status-text"></span>
      </div>
    ` : '';

    container.innerHTML = demoNotice + batchControls + filtered.map(item => {
      const escapedId = escapeHtml(item.id);
      const escapedName = escapeHtml(item.name);
      const firstChar = escapeHtml(item.name[0] || '?');
      const memberCount = typeof item.memberCount === 'number' ? item.memberCount : 0;
      const isGroup = this.currentChatType === 'groups';
      const isSelected = isGroup && this.batchSelectedGroupIds.includes(String(item.id));
      const checkboxHtml = isGroup
        ? `<input type="checkbox" class="chat-item-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); app.toggleBatchGroupSelection('${escapedId}', this.checked)">`
        : '';
      
      return `
        <div class="chat-item ${this.currentChatId === item.id ? 'active' : ''}" 
             onclick="app.selectChat('${escapedId}')">
          ${checkboxHtml}
          <div class="chat-avatar">${firstChar}</div>
          <div class="chat-info">
            <div class="chat-name">${escapedName}</div>
            <div class="chat-preview">${this.currentChatType === 'groups' ? `${memberCount}人` : '点击查看消息'}</div>
          </div>
        </div>
      `;
    }).join('');
    this.updateAutoBatchStatusUI();
  }

  async selectChat(chatId) {
    this.currentChatId = chatId;
    this.renderChatList();

    const items = this.currentChatType === 'contacts' ? this.contacts : this.groups;
    const chat = items.find(i => i.id === chatId);
    
    document.getElementById('message-header').textContent = chat?.name || '未知会话';

    try {
      const limit = this.messagePageLimit || 50;
      const data = await this.api(`/api/wechat/messages/${chatId}?limit=${limit}`);
      this.messages = Array.isArray(data.messages) ? data.messages : [];
      this.renderMessages();
    } catch {
      this.messages = [];
      this.renderMessages();
    }
  }

  async ensureChatSelectedForSmartCapture() {
    if (this.currentChatId) {
      return true;
    }

    if (this.currentChatType === 'groups') {
      if (this.batchSelectedGroupIds.length === 1) {
        await this.selectChat(this.batchSelectedGroupIds[0]);
        return true;
      }

      if (this.batchSelectedGroupIds.length > 1) {
        this.showToast('已勾选多个群，请点击左侧群名打开一个会话，或使用批量抓取商机', 'warning');
        return false;
      }
    }

    this.showToast('请先选择一个会话', 'warning');
    return false;
  }

  toggleBatchGroupSelection(groupId, checked) {
    const id = String(groupId);
    if (checked) {
      if (!this.batchSelectedGroupIds.includes(id)) {
        this.batchSelectedGroupIds.push(id);
      }
    } else {
      this.batchSelectedGroupIds = this.batchSelectedGroupIds.filter(gid => gid !== id);
    }
    this.saveBatchTodoSettings();
  }

  saveBatchTodoSettings() {
    const config = {
      selectedGroupIds: this.batchSelectedGroupIds,
      autoIntervalMinutes: this.autoBatchIntervalMinutes
    };
    localStorage.setItem('batchTodoSettings', JSON.stringify(config));
  }

  selectAllVisibleGroups() {
    if (this.currentChatType !== 'groups') return;

    const searchTerm = document.getElementById('chat-search')?.value.toLowerCase() || '';
    const visible = this.groups.filter(item =>
      item.name.toLowerCase().includes(searchTerm)
    );

    visible.forEach(item => {
      const id = String(item.id);
      if (!this.batchSelectedGroupIds.includes(id)) {
        this.batchSelectedGroupIds.push(id);
      }
    });

    this.saveBatchTodoSettings();
    this.renderChatList();
  }

  deselectAllVisibleGroups() {
    if (this.currentChatType !== 'groups') return;

    const searchTerm = document.getElementById('chat-search')?.value.toLowerCase() || '';
    const visible = this.groups.filter(item =>
      item.name.toLowerCase().includes(searchTerm)
    );
    const visibleIds = new Set(visible.map(item => String(item.id)));

    this.batchSelectedGroupIds = this.batchSelectedGroupIds.filter(id => !visibleIds.has(id));
    this.saveBatchTodoSettings();
    this.renderChatList();
  }

  clearAllGroupSelections() {
    if (this.currentChatType !== 'groups') return;
    this.batchSelectedGroupIds = [];
    this.saveBatchTodoSettings();
    this.renderChatList();
  }

  toggleShowOnlySelected(checked) {
    this.chatListShowOnlySelected = !!checked;
    this.renderChatList();
  }

  exportGroupSelection() {
    if (this.currentChatType !== 'groups') return;
    if (!this.batchSelectedGroupIds || this.batchSelectedGroupIds.length === 0) {
      this.showToast('当前没有已选群', 'info');
      return;
    }
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      selectedGroupIds: this.batchSelectedGroupIds.slice()
    };
    const text = JSON.stringify(data, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('群选择已复制到剪贴板', 'success');
      }).catch(() => {
        window.prompt('请复制以下内容备份群选择：', text);
      });
    } else {
      window.prompt('请复制以下内容备份群选择：', text);
    }
  }

  importGroupSelection() {
    if (this.currentChatType !== 'groups') return;
    const handleImport = (text) => {
      if (!text) {
        this.showToast('导入失败：没有读取到内容', 'error');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.showToast('导入失败：内容不是有效的JSON', 'error');
        return;
      }
      if (!parsed || !Array.isArray(parsed.selectedGroupIds)) {
        this.showToast('导入失败：缺少selectedGroupIds字段', 'error');
        return;
      }
      const idSet = new Set(parsed.selectedGroupIds.map(id => String(id)));
      const validIds = this.groups
        .map(g => String(g.id))
        .filter(id => idSet.has(id));
      if (validIds.length === 0) {
        this.showToast('导入成功，但未匹配到任何当前存在的群', 'info');
      }
      this.batchSelectedGroupIds = validIds;
      this.saveBatchTodoSettings();
      this.renderChatList();
      if (validIds.length > 0) {
        this.showToast(`已导入 ${validIds.length} 个群的选择`, 'success');
      }
    };

    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(text => {
        if (!text) {
          const input = window.prompt('剪贴板中没有内容，请粘贴之前导出的群选择：');
          if (!input) return;
          handleImport(input);
        } else {
          handleImport(text);
        }
      }).catch(() => {
        const input = window.prompt('请粘贴之前导出的群选择内容：');
        if (!input) return;
        handleImport(input);
      });
    } else {
      const input = window.prompt('请粘贴之前导出的群选择内容：');
      if (!input) return;
      handleImport(input);
    }
  }

  generateSampleMessages(chatId, count) {
    const messages = [];
    const senders = ['我', '张三', '李四'];
    const contents = [
      '好的，明天下午3点开会讨论项目进度',
      '收到，我会准备好PPT',
      '记得把上周的数据分析报告发给我',
      '会议室已经预定好了',
      '周末有空一起打球吗？'
    ];

    for (let i = 0; i < count; i++) {
      const isMe = Math.random() > 0.6;
      messages.push({
        id: `msg_${i}`,
        sender: isMe ? '我' : senders[Math.floor(Math.random() * senders.length)],
        content: contents[Math.floor(Math.random() * contents.length)],
        timestamp: Date.now() - (count - i) * 60000 * 5,
        isMe
      });
    }
    return messages;
  }

  renderMessages() {
    const container = document.getElementById('message-list');
    
    if (this.messages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">💬</span>
          <p>暂无消息</p>
        </div>
      `;
      return;
    }

    container.innerHTML = this.messages.map(msg => {
      const escapedSender = escapeHtml(msg.sender || '');
      const escapedContent = escapeHtml(msg.content || '');
      const formattedTime = this.formatTime(msg.timestamp);
      
      return `
        <div class="message-item ${msg.isMe ? 'sent' : ''}">
          <div class="message-bubble">
            ${!msg.isMe ? `<div class="message-sender">${escapedSender}</div>` : ''}
            <div>${escapedContent}</div>
            <div class="message-time">${formattedTime}</div>
          </div>
        </div>
      `;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // Monitor
  renderMonitorGroups() {
    const container = document.getElementById('group-checkboxes');
    const searchTerm = document.getElementById('monitor-group-search')?.value.toLowerCase() || '';
    
    // Add demo mode notice if using sample data
    const demoNotice = this.isUsingDemoData ? `
      <div class="demo-notice">
        <span class="demo-notice-icon">ℹ️</span>
        <span>演示模式：以下群聊为示例数据，监控功能将模拟消息。请在设置中配置微信数据目录以使用真实数据。</span>
      </div>
    ` : '';
    
    const filteredGroups = this.groups.filter(group => 
      group.name.toLowerCase().includes(searchTerm)
    );

    const groupsHtml = filteredGroups.map(group => {
      const escapedId = escapeHtml(group.id);
      const escapedName = escapeHtml(group.name);
      const memberCount = typeof group.memberCount === 'number' ? group.memberCount : 0;
      
      return `
        <label class="group-checkbox">
          <input type="checkbox" value="${escapedId}" 
                 ${this.monitoringGroups.includes(group.id) ? 'checked' : ''}>
          <span>${escapedName} (${memberCount}人)</span>
        </label>
      `;
    }).join('');

    container.innerHTML = demoNotice + groupsHtml;

    if (filteredGroups.length === 0 && !this.isUsingDemoData) {
      container.innerHTML += `<div style="text-align:center; color:var(--text-light); padding: 20px;">未找到匹配的群聊</div>`;
    }
  }

  async startMonitor() {
    const checkboxes = document.querySelectorAll('#group-checkboxes input:checked');
    this.monitoringGroups = Array.from(checkboxes).map(cb => cb.value);

    if (this.monitoringGroups.length === 0) {
      this.showToast('请至少选择一个群聊', 'warning');
      return;
    }

    try {
      await this.api('/api/wechat/monitor/start', {
        method: 'POST',
        body: JSON.stringify({ groupIds: this.monitoringGroups })
      });
    } catch (e) {
      console.log('Using local simulation for monitoring due to API error');
      this.simulateMonitoring();
    }

    this.isMonitoring = true;
    document.getElementById('btn-start-monitor').disabled = true;
    document.getElementById('btn-stop-monitor').disabled = false;
    document.getElementById('live-indicator').classList.add('active');
    document.getElementById('feed-list').innerHTML = '';

    this.showToast('监控已启动', 'success');
  }

  simulateMonitoring() {
    if (!this.isMonitoring) return;

    // Simulate receiving messages
    this.monitorSimInterval = setInterval(() => {
      if (!this.isMonitoring) return;
      if (Math.random() > 0.4) return;

      const groupId = this.monitoringGroups[Math.floor(Math.random() * this.monitoringGroups.length)];
      const group = this.groups.find(g => g.id === groupId);
      const senders = ['张三', '李四', '王五', '赵六'];
      const contents = [
        '大家好，今天的会议改到下午4点',
        '请注意查收刚发的邮件',
        '有人能帮我review一下代码吗？',
        '提醒：明天是项目deadline',
        '周五下班前记得提交周报'
      ];

      this.addFeedMessage({
        groupName: group?.name || '未知群组',
        sender: senders[Math.floor(Math.random() * senders.length)],
        content: contents[Math.floor(Math.random() * contents.length)],
        timestamp: Date.now()
      });
    }, 8000);
  }

  addFeedMessage(msg) {
    const container = document.getElementById('feed-list');
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) {
      container.innerHTML = '';
    }

    const escapedGroupName = escapeHtml(msg.groupName || '');
    const escapedSender = escapeHtml(msg.sender || '');
    const escapedContent = escapeHtml(msg.content || '');
    const formattedTime = this.formatTime(msg.timestamp);

    const element = document.createElement('div');
    element.className = 'feed-item';
    element.innerHTML = `
      <div class="feed-group">${escapedGroupName}</div>
      <div class="feed-sender">${escapedSender}</div>
      <div class="feed-content">${escapedContent}</div>
      <div class="feed-time">${formattedTime}</div>
    `;
    container.insertBefore(element, container.firstChild);

    // Keep only last 50 messages
    while (container.children.length > 50) {
      container.removeChild(container.lastChild);
    }
  }

  async stopMonitor() {
    try {
      await this.api('/api/wechat/monitor/stop', { method: 'POST' });
    } catch (e) {
      console.log('Stopping local simulation');
    }

    this.isMonitoring = false;
    if (this.monitorSimInterval) {
      clearInterval(this.monitorSimInterval);
    }
    
    document.getElementById('btn-start-monitor').disabled = false;
    document.getElementById('btn-stop-monitor').disabled = true;
    document.getElementById('live-indicator').classList.remove('active');

    this.showToast('监控已停止', 'success');
  }

  // Todos
  async loadTodos() {
    try {
      this.todos = await this.api('/api/todos');
    } catch {
      this.todos = [];
    }
    this.renderTodos();
  }

  renderTodos(filter = null) {
    const activeFilter = filter || this.currentTodoFilter;
    const container = document.getElementById('todo-list');
    let filtered = this.todos;

    switch (activeFilter) {
      case 'pending':
        filtered = this.todos.filter(t => !t.completed);
        break;
      case 'completed':
        filtered = this.todos.filter(t => t.completed);
        break;
      case 'ai-generated':
        filtered = this.todos.filter(t => t.source === 'ai-generated');
        break;
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">✅</span>
          <p>暂无待办事项</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(todo => {
      const escapedId = escapeHtml(todo.id);
      const escapedTitle = escapeHtml(todo.title);
      const priorityLabel = this.getPriorityLabel(todo.priority);
      const escapedPriority = escapeHtml(todo.priority);
      const dueDateStr = todo.dueDate ? new Date(todo.dueDate).toLocaleDateString() : '';
      
      // New fields display
      const groupName = todo.groupName ? `<span class="meta-tag group-tag">📁 ${escapeHtml(todo.groupName)}</span>` : '';
      const sender = todo.sender ? `<span class="meta-tag sender-tag">👤 ${escapeHtml(todo.sender)}</span>` : '';
      const timeStr = todo.messageTime ? `<span class="meta-tag time-tag">🕒 ${escapeHtml(todo.messageTime)}</span>` : '';

      return `
        <div class="todo-item ${todo.completed ? 'completed' : ''}">
          <input type="checkbox" class="todo-checkbox" 
                 ${todo.completed ? 'checked' : ''} 
                 onchange="app.toggleTodo('${escapedId}')">
          <div class="todo-content">
            <div class="todo-title">${escapedTitle}</div>
            <div class="todo-meta">
              <span class="priority-badge priority-${escapedPriority}">${priorityLabel}</span>
              ${todo.source === 'ai-generated' ? '<span class="source-badge">AI生成</span>' : ''}
              ${dueDateStr ? `<span>截止: ${dueDateStr}</span>` : ''}
              ${timeStr}
              ${groupName}
              ${sender}
            </div>
          </div>
          <div class="todo-actions">
            <button class="todo-action-btn" onclick="app.openTodoDetail('${escapedId}')">👁️</button>
            <button class="todo-action-btn" onclick="app.deleteTodo('${escapedId}')">🗑️</button>
          </div>
        </div>
      `;
    }).join('');
  }

  getPriorityLabel(priority) {
    const labels = { high: '紧急', medium: '普通', low: '低优先' };
    return labels[priority] || priority;
  }

  filterTodos(filter) {
    this.currentTodoFilter = filter;
    this.renderTodos(filter);
  }

  async addTodo() {
    const input = document.getElementById('new-todo-input');
    const priority = document.getElementById('new-todo-priority').value;
    const title = input.value.trim();

    if (!title) {
      this.showToast('请输入待办内容', 'warning');
      return;
    }

    const todo = {
      title,
      priority,
      source: 'manual'
    };

    try {
      const newTodo = await this.api('/api/todos', {
        method: 'POST',
        body: JSON.stringify(todo)
      });
      this.todos.push(newTodo);
    } catch {
      this.todos.push({
        id: Date.now().toString(),
        ...todo,
        completed: false,
        createdAt: new Date().toISOString()
      });
    }

    input.value = '';
    this.renderTodos();
    this.updateDashboard();
    this.showToast('待办已添加', 'success');
  }

  async toggleTodo(id) {
    try {
      const todo = this.todos.find(t => t.id === id);
      if (todo) {
        todo.completed = !todo.completed;
        await this.api(`/api/todos/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ completed: todo.completed })
        });
      }
    } catch {
      const todo = this.todos.find(t => t.id === id);
      if (todo) {
        todo.completed = !todo.completed;
      }
    }
    this.renderTodos();
    this.updateDashboard();
  }

  async deleteTodo(id) {
    try {
      await this.api(`/api/todos/${id}`, { method: 'DELETE' });
    } catch {}
    this.todos = this.todos.filter(t => t.id !== id);
    this.renderTodos();
    this.updateDashboard();
    this.showToast('待办已删除', 'success');
  }

  async deleteAllTodos() {
    if (!this.todos || this.todos.length === 0) {
      this.showToast('暂无待办可删除', 'info');
      return;
    }

    const ok = window.confirm('确定要删除全部待办事项吗？此操作不可恢复。');
    if (!ok) return;

    try {
      await this.api('/api/todos/delete-all', { method: 'POST' });
      this.todos = [];
      this.renderTodos();
      this.updateDashboard();
      this.showToast('已删除全部待办', 'success');
    } catch (e) {
      console.error(e);
      this.showToast('全部删除失败，请重试', 'error');
    }
  }

  async generateTodosFromChat() {
    if (!(await this.ensureChatSelectedForSmartCapture())) {
      return;
    }

    if (!(await this.ensureAIReady())) {
      return;
    }

    this.showLoading(true);
    try {
      const hours = this.aiAnalysisHours && this.aiAnalysisHours >= 1 && this.aiAnalysisHours <= 48
        ? this.aiAnalysisHours
        : 1;
      const secondsRange = hours * 3600;
      const startTime = Math.floor(Date.now() / 1000) - secondsRange;
      
      // Fetch messages from the last N hours
      // Use a large limit to ensure we get all of them
      const data = await this.api(`/api/wechat/messages/${this.currentChatId}?limit=1000&startTime=${startTime}`);
      const recentMessages = Array.isArray(data.messages) ? data.messages : [];
      
      console.log(`[Client] generateTodosFromChat fetched ${recentMessages.length} messages from last ${hours} hour(s)`);

      if (recentMessages.length === 0) {
        this.showToast(`过去${hours}小时内没有消息`, 'info');
        this.showLoading(false);
        return;
      }

      // Filter for text messages only (do not change current view messages)
      const textMessages = recentMessages.filter(msg => msg.type === 'text');
      console.log(`[Client] generateTodosFromChat filtered to ${textMessages.length} text messages in last ${hours} hour(s)`);

      if (textMessages.length === 0) {
        this.showToast(`过去${hours}小时内没有文字消息`, 'info');
        this.showLoading(false);
        return;
      }

      // Get current chat name
      const items = this.currentChatType === 'contacts' ? this.contacts : this.groups;
      const currentChat = items.find(i => i.id === this.currentChatId);
      const chatName = currentChat ? currentChat.name : '未知会话';

      const newTodos = await this.api('/api/todos/generate-from-chat', {
        method: 'POST',
        body: JSON.stringify({ 
          messages: textMessages,
          chatName: chatName,
          confidenceThreshold: this.leadConfidenceThreshold
        })
      });
      
      this.todos = [...this.todos, ...newTodos];
      this.renderTodos();
      this.updateDashboard();
      this.showToast(`智能抓取到 ${newTodos.length} 条商机/资源类重要信息`, 'success');
      console.log('[Client] generateTodosFromChat newTodos =', newTodos);
    } catch (error) {
      console.error(error);
      this.showToast(`商机智能抓取失败：${error.message || '请检查AI配置'}`, 'error');
    }
    this.showLoading(false);
  }

  startAutoBatchExtract() {
    this.stopAutoBatchExtract();

    const minutes = this.autoBatchIntervalMinutes;
    if (!minutes || minutes < 5) {
      console.log('[AutoBatch] Interval < 5 minutes or not set, auto analysis disabled.');
      this.updateAutoBatchStatusUI();
      return;
    }

    const interval = minutes * 60 * 1000;
    console.log(`[AutoBatch] Starting with interval ${minutes} minutes`);

    this.autoBatchNextRunAt = Date.now() + interval;

    this.autoBatchTimer = setInterval(() => {
      this.generateTodosForSelectedGroupsBatch(true);
      const currentMinutes = this.autoBatchIntervalMinutes;
      if (!currentMinutes || currentMinutes < 5) {
        this.stopAutoBatchExtract();
        return;
      }
      const nextInterval = currentMinutes * 60 * 1000;
      this.autoBatchNextRunAt = Date.now() + nextInterval;
    }, interval);

    if (this.autoBatchCountdownTimer) {
      clearInterval(this.autoBatchCountdownTimer);
    }
    this.autoBatchCountdownTimer = setInterval(() => {
      this.updateAutoBatchStatusUI();
    }, 1000);
    this.updateAutoBatchStatusUI();
  }

  stopAutoBatchExtract() {
    if (this.autoBatchTimer) {
      clearInterval(this.autoBatchTimer);
      this.autoBatchTimer = null;
    }
    if (this.autoBatchCountdownTimer) {
      clearInterval(this.autoBatchCountdownTimer);
      this.autoBatchCountdownTimer = null;
    }
    this.autoBatchNextRunAt = null;
    this.updateAutoBatchStatusUI();
  }

  updateAutoBatchStatusUI() {
    const el = document.getElementById('auto-batch-status-text');
    if (!el) return;

    const minutes = this.autoBatchIntervalMinutes;
    if (!minutes || minutes < 5) {
      el.textContent = '定时批量分析：已关闭';
      return;
    }

    if (!this.autoBatchTimer) {
      el.textContent = `定时批量分析：每${minutes}分钟，未启动`;
      return;
    }

    if (!this.autoBatchNextRunAt) {
      el.textContent = `定时批量分析：每${minutes}分钟`;
      return;
    }

    const diff = this.autoBatchNextRunAt - Date.now();
    if (diff <= 0) {
      el.textContent = `定时批量分析：正在执行`;
      return;
    }

    const totalSeconds = Math.floor(diff / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    el.textContent = `定时批量分析：每${minutes}分钟，距离下次还有 ${mm}:${ss}`;
  }

  toggleBatchProgress(show) {
    const container = document.getElementById('batch-progress-container');
    if (container) {
      container.style.display = show ? 'block' : 'none';
      if (show) {
        this.updateBatchProgress(0, '准备开始...');
      }
    }
  }

  updateBatchProgress(percent, text) {
    const bar = document.getElementById('batch-progress-bar');
    const textEl = document.getElementById('batch-progress-text');
    const percentEl = document.getElementById('batch-progress-percent');
    
    if (bar) bar.style.width = `${percent}%`;
    if (textEl) textEl.textContent = text;
    if (percentEl) percentEl.textContent = `${Math.floor(percent)}%`;
  }

  async generateTodosForSelectedGroupsBatch(isAuto = false) {
    if (!this.batchSelectedGroupIds || this.batchSelectedGroupIds.length === 0) {
      if (!isAuto) this.showToast('请先在左侧群聊列表中勾选要处理的群聊', 'warning');
      return;
    }

    if (!(await this.ensureAIReady())) {
      return;
    }

    const hours = this.aiAnalysisHours && this.aiAnalysisHours >= 1 && this.aiAnalysisHours <= 48
      ? this.aiAnalysisHours
      : 1;
    const secondsRange = hours * 3600;

    const groupIds = this.batchSelectedGroupIds.slice();
    if (!isAuto) {
      // Use progress bar instead of full screen loading
      this.toggleBatchProgress(true);
    }
    else console.log('[AutoBatch] Starting extraction cycle...');

    let totalTodos = 0;
    let groupsNoMessages = 0;
    let groupsNoText = 0;
    let groupsAIRequested = 0;
    let groupsAIEmpty = 0;
    let groupsAIError = 0;

    try {
      for (let i = 0; i < groupIds.length; i++) {
        const groupId = groupIds[i];
        const startTime = Math.floor(Date.now() / 1000) - secondsRange;

        const group = this.groups.find(g => String(g.id) === String(groupId));
        const chatName = group ? group.name : '未知会话';

        console.log(`[Client] batchGenerateTodos start group ${chatName} (${groupId}) [${i + 1}/${groupIds.length}]`);
        
        // Update progress start
        if (!isAuto) {
          const percent = (i / groupIds.length) * 100;
          this.updateBatchProgress(percent, `正在分析: ${chatName} (${i + 1}/${groupIds.length})`);
        }

        const PAGE_SIZE = 1000;
        const SAFETY_LIMIT = 10000;
        let allMessages = [];
        let offset = 0;
        while (true) {
          const data = await this.api(`/api/wechat/messages/${groupId}?limit=${PAGE_SIZE}&offset=${offset}&startTime=${startTime}`);
          const batch = Array.isArray(data.messages) ? data.messages : [];
          if (batch.length > 0) {
            allMessages = allMessages.concat(batch);
          }
          if (batch.length < PAGE_SIZE || allMessages.length >= SAFETY_LIMIT) {
            break;
          }
          offset += PAGE_SIZE;
        }
        allMessages.sort((a, b) => a.timestamp - b.timestamp);
        console.log(`[Client] batchGenerateTodos group ${chatName} fetched total ${allMessages.length} messages from last ${hours} hour(s)`);

        if (allMessages.length === 0) {
          groupsNoMessages++;
          if (!isAuto) {
            const percent = ((i + 1) / groupIds.length) * 100;
            this.updateBatchProgress(percent, `完成: ${chatName} (无消息)`);
          }
          continue;
        }

        const textMessages = allMessages.filter(msg => msg.type === 'text');
        console.log(`[Client] batchGenerateTodos group ${chatName} filtered to ${textMessages.length} text messages`);

        if (textMessages.length === 0) {
          groupsNoText++;
          if (!isAuto) {
            const percent = ((i + 1) / groupIds.length) * 100;
            this.updateBatchProgress(percent, `完成: ${chatName} (无文本消息)`);
          }
          continue;
        }

        groupsAIRequested++;
        const newTodos = await this.api('/api/todos/generate-from-chat', {
          method: 'POST',
          body: JSON.stringify({
            messages: textMessages,
            chatName: chatName,
            confidenceThreshold: this.leadConfidenceThreshold
          })
        });

        if (Array.isArray(newTodos) && newTodos.length > 0) {
          this.todos = [...this.todos, ...newTodos];
          totalTodos += newTodos.length;
          this.renderTodos();
          this.updateDashboard();
        } else {
          groupsAIEmpty++;
        }

        console.log(`[Client] batchGenerateTodos group ${chatName} created ${(Array.isArray(newTodos) ? newTodos.length : 0)} todos`);
        
        // Update progress end of item
        if (!isAuto) {
          const percent = ((i + 1) / groupIds.length) * 100;
          this.updateBatchProgress(percent, `完成: ${chatName}`);
        }
      }

      if (!isAuto) {
        this.updateBatchProgress(100, '批量分析完成');
        setTimeout(() => this.toggleBatchProgress(false), 3000);
        
        if (totalTodos > 0) {
        this.showToast(`批量抓取完成，共生成 ${totalTodos} 条商机/资源类重要信息`, 'success');
        } else {
        const parts = [];
        if (groupsNoMessages > 0) parts.push(`无消息群${groupsNoMessages}`);
        if (groupsNoText > 0) parts.push(`无文本群${groupsNoText}`);
        if (groupsAIRequested > 0) parts.push(`已分析群${groupsAIRequested}`);
        if (groupsAIError > 0) parts.push(`失败群${groupsAIError}`);
        if (groupsAIEmpty > 0) parts.push(`无结果群${groupsAIEmpty}`);
        const detail = parts.length > 0 ? `（${parts.join('，')}）` : '';
        this.showToast(`批量抓取完成，未发现新的商机/资源类重要信息${detail}`, 'info');
        }
      } else {
        console.log(`[AutoBatch] Cycle completed. Generated ${totalTodos} todos.`);
        if (totalTodos > 0) {
          this.showToast(`自动抓取: 新增 ${totalTodos} 条商机/资源类重要信息`, 'success');
        }
      }
    } catch (error) {
      console.error('[Client] batchGenerateTodos error', error);
      groupsAIError++;
      if (!isAuto) {
        this.toggleBatchProgress(false);
        this.showToast(`批量商机智能抓取失败：${error.message || '请检查AI配置'}`, 'error');
      }
    }

    // if (!isAuto) this.showLoading(false); // Removed as we use progress bar
  }

  // Knowledge Base
  async loadKnowledge() {
    try {
      const items = await this.api('/api/knowledge');
      this.renderKnowledgeItems(items);
      document.getElementById('stat-knowledge').textContent = items.length;
    } catch {
      document.getElementById('stat-knowledge').textContent = '0';
    }
  }

  renderKnowledgeItems(items) {
    const container = document.getElementById('knowledge-items');
    if (!items || items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">📚</span>
          <p>知识库暂无数据</p>
        </div>
      `;
      return;
    }

    container.innerHTML = items.slice(0, 20).map(item => {
      const escapedContent = escapeHtml(item.content || '');
      const escapedSender = escapeHtml(item.metadata?.sender || '未知');
      const keywords = Array.isArray(item.keywords) ? item.keywords.slice(0, 5).map(k => escapeHtml(k)).join(', ') : '无';
      
      return `
        <div class="knowledge-item">
          <div class="knowledge-item-content">${escapedContent}</div>
          <div class="knowledge-item-meta">
            <span>发送者: ${escapedSender}</span>
            <span>关键词: ${keywords}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  async searchKnowledge() {
    const query = document.getElementById('knowledge-search-input').value.trim();
    if (!query) return;

    try {
      const results = await this.api(`/api/knowledge?query=${encodeURIComponent(query)}`);
      this.renderKnowledgeItems(results);
    } catch {
      this.showToast('搜索失败', 'error');
    }
  }

  async queryKnowledge() {
    const question = document.getElementById('knowledge-query-input').value.trim();
    if (!question) return;

    const resultContainer = document.getElementById('query-result');
    resultContainer.textContent = '正在查询...';

    try {
      const { answer } = await this.api('/api/knowledge/query', {
        method: 'POST',
        body: JSON.stringify({ question })
      });
      resultContainer.textContent = answer;
    } catch {
      resultContainer.textContent = 'AI查询失败，请检查AI配置';
    }
  }

  async indexToKnowledge() {
    if (this.messages.length === 0) {
      this.showToast('请先选择一个会话', 'warning');
      return;
    }

    this.showLoading(true);
    try {
      const result = await this.api('/api/knowledge/index', {
        method: 'POST',
        body: JSON.stringify({ messages: this.messages })
      });
      this.showToast(`已添加 ${result.indexedCount} 条消息到知识库`, 'success');
    } catch {
      this.showToast('添加失败', 'error');
    }
    this.showLoading(false);
  }

  // AI Chat
  handleChatKeypress(event) {
    if (event.key === 'Enter') {
      this.sendAIMessage();
    }
  }

  async sendAIMessage() {
    const input = document.getElementById('ai-chat-input');
    const message = input.value.trim();
    if (!message) return;

    // Add user message
    this.addChatMessage(message, 'user');
    input.value = '';

    // Get AI response
    try {
      const { response } = await this.api('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ 
          message,
          context: this.chatHistory.slice(-10)
        })
      });
      this.addChatMessage(response, 'ai');
    } catch {
      this.addChatMessage('抱歉，AI服务暂时不可用。请检查AI配置。', 'ai');
    }
  }

  addChatMessage(content, type) {
    const container = document.getElementById('ai-chat-messages');
    const escapedContent = escapeHtml(content);
    const element = document.createElement('div');
    element.className = type === 'user' ? 'user-message' : 'ai-message';
    element.innerHTML = `
      <div class="message-avatar">${type === 'user' ? '👤' : '🤖'}</div>
      <div class="message-content">${escapedContent}</div>
    `;
    container.appendChild(element);
    container.scrollTop = container.scrollHeight;

    // Keep chat history
    this.chatHistory.push({
      role: type === 'user' ? 'user' : 'assistant',
      content
    });
  }

  // Settings
  async loadSettings() {
    await this.checkAIStatus();

    // Restore WeChat path to input
    const savedPath = localStorage.getItem('wechatDataPath');
    const input = document.getElementById('wechat-path');
    if (savedPath && input) {
      input.value = savedPath;
    }

    const messageLimitInput = document.getElementById('message-limit');
    if (messageLimitInput) {
      messageLimitInput.value = this.messagePageLimit;
    }

    const ollamaUrlInput = document.getElementById('ollama-url');
    if (ollamaUrlInput) {
      ollamaUrlInput.value = localStorage.getItem('aiOllamaUrl') || 'http://localhost:11434';
    }

    const hoursInput = document.getElementById('ai-analysis-hours');
    if (hoursInput) {
      hoursInput.value = this.aiAnalysisHours;
    }

    const confidenceInput = document.getElementById('lead-confidence-threshold');
    if (confidenceInput) {
      confidenceInput.value = this.leadConfidenceThreshold;
    }

    try {
      const storage = await this.api('/api/todos/storage');
      const storageInput = document.getElementById('todo-storage-file');
      if (storageInput && storage?.todoFile) {
        storageInput.value = storage.todoFile;
      }
    } catch {
      const storageInput = document.getElementById('todo-storage-file');
      if (storageInput) {
        storageInput.value = '';
      }
    }

    const autoBatchIntervalInput = document.getElementById('auto-batch-interval-minutes');
    if (autoBatchIntervalInput) {
      autoBatchIntervalInput.value = this.autoBatchIntervalMinutes || '';
    }
  }

  async checkAIStatus() {
    try {
      let status = await this.api('/api/ai/status');

      try {
        const savedPrompt = localStorage.getItem('aiTodoPromptCategories');
        const savedOllamaUrl = localStorage.getItem('aiOllamaUrl');
        const savedModel = localStorage.getItem('aiPreferredModel');
        const syncPayload = {};

        if (savedOllamaUrl && savedOllamaUrl.trim()) {
          syncPayload.ollamaUrl = savedOllamaUrl.trim();
        }
        if (savedModel && savedModel.trim() && savedModel !== status.model) {
          syncPayload.model = savedModel.trim();
        }
        if (savedPrompt && savedPrompt.trim() && savedPrompt !== status.todoPromptCategories) {
          syncPayload.todoPromptCategories = savedPrompt;
        }

        if (Object.keys(syncPayload).length > 0) {
          await this.api('/api/ai/config', {
            method: 'POST',
            body: JSON.stringify(syncPayload)
          });
          status = await this.api('/api/ai/status');
        }
      } catch (e) {
        console.error('Failed to sync AI todo prompt categories from localStorage', e);
      }

      this.updateAIStatusDisplay(status);
    } catch {
      this.updateAIStatusDisplay({
        isReady: false,
        provider: null,
        ollamaAvailable: false,
        openaiConfigured: false
      });
    }
  }

  updateAIStatusDisplay(status) {
    // Update sidebar status
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    
    if (status.isReady) {
      statusDot.className = 'status-dot online';
      statusText.textContent = `AI: ${status.provider === 'ollama' ? 'Ollama' : 'OpenAI'}`;
    } else {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'AI: 未配置';
    }

    // Update settings page
    const statusCard = document.getElementById('ai-status-card');
    if (statusCard) {
      statusCard.innerHTML = `
        <div class="ai-status-item">
          <span>状态</span>
          <span style="color: ${status.isReady ? 'var(--success-color)' : 'var(--danger-color)'}">
            ${status.isReady ? '已就绪' : '未就绪'}
          </span>
        </div>
        <div class="ai-status-item">
          <span>当前提供者</span>
          <span>${status.provider || '无'}</span>
        </div>
        <div class="ai-status-item">
          <span>当前模型</span>
          <span>${status.model || '未选择'}</span>
        </div>
        <div class="ai-status-item">
          <span>Ollama可用</span>
          <span>${status.ollamaAvailable ? '✅ 是' : '❌ 否'}</span>
        </div>
        <div class="ai-status-item">
          <span>OpenAI已配置</span>
          <span>${status.openaiConfigured ? '✅ 是' : '❌ 否'}</span>
        </div>
      `;

      // Populate model selector
      const modelSelect = document.getElementById('ai-model');
      if (modelSelect && status.ollamaModels) {
        const savedModel = localStorage.getItem('aiPreferredModel');
        const currentValue = modelSelect.value;
        modelSelect.innerHTML = '<option value="">自动选择</option>' +
          status.ollamaModels.map(m => `<option value="${m}">${m}</option>`).join('');
        modelSelect.value = savedModel || currentValue || status.model || '';
      }

      const promptTextarea = document.getElementById('ai-todo-prompt');
      if (promptTextarea) {
        const savedPrompt = localStorage.getItem('aiTodoPromptCategories');
        if (savedPrompt && savedPrompt.trim()) {
          promptTextarea.value = savedPrompt;
        } else if (status.todoPromptCategories) {
          promptTextarea.value = status.todoPromptCategories;
        }
      }
    }
  }

  async selectWechatPath() {
    if (window.electronAPI) {
      const path = await window.electronAPI.selectWechatPath();
      if (path) {
        document.getElementById('wechat-path').value = path;
        await this.configureWechat(path);
      }
    } else {
      this.showToast('请在桌面应用中使用此功能', 'warning');
    }
  }

  async configureWechat(path, silent = false) {
    try {
      await this.api('/api/wechat/configure', {
        method: 'POST',
        body: JSON.stringify({ dataPath: path })
      });
      
      localStorage.setItem('wechatDataPath', path);

      if (!silent) {
        this.showToast('微信数据目录已配置', 'success');
      }
      await this.loadInitialData();
    } catch {
      if (!silent) {
        this.showToast('配置失败', 'error');
      }
    }
  }

  async saveAISettings() {
    const ollamaUrl = document.getElementById('ollama-url').value.trim();
    const openaiKey = document.getElementById('openai-key').value.trim();
    const model = document.getElementById('ai-model').value;
    const todoPrompt = document.getElementById('ai-todo-prompt').value;
    const confidenceInput = document.getElementById('lead-confidence-threshold');
    const confidenceThreshold = confidenceInput ? parseFloat(confidenceInput.value) : this.leadConfidenceThreshold;

    if (Number.isNaN(confidenceThreshold) || confidenceThreshold < 0.5 || confidenceThreshold > 0.95) {
      this.showToast('最低抓取把握度请输入 0.50 到 0.95 之间的数字', 'warning');
      return;
    }

    if (todoPrompt && todoPrompt.trim()) {
      localStorage.setItem('aiTodoPromptCategories', todoPrompt);
    } else {
      localStorage.removeItem('aiTodoPromptCategories');
    }

    if (ollamaUrl) {
      localStorage.setItem('aiOllamaUrl', ollamaUrl);
    } else {
      localStorage.removeItem('aiOllamaUrl');
    }

    if (model) {
      localStorage.setItem('aiPreferredModel', model);
    } else {
      localStorage.removeItem('aiPreferredModel');
    }

    this.leadConfidenceThreshold = confidenceThreshold;
    localStorage.setItem('leadConfidenceThreshold', String(confidenceThreshold));

    try {
      await this.api('/api/ai/config', {
        method: 'POST',
        body: JSON.stringify({
          ollamaUrl,
          openaiKey,
          model,
          todoPromptCategories: todoPrompt
        })
      });
      await this.checkAIStatus();
      this.showToast('AI抓取设置已保存', 'success');
    } catch {
      this.showToast('保存失败', 'error');
    }
  }

  resetAIPrompt() {
    const promptTextarea = document.getElementById('ai-todo-prompt');
    if (!promptTextarea) return;
    promptTextarea.value = `- 招聘信息（岗位、要求、联系方式等）
- 求购信息（需求物品或服务、预算、时间要求等）
- 寻找资源（寻找合作伙伴、渠道、供应商、场地等）
- 寻找咨询老师或专家（咨询方向、领域、联系方式等)`;
  }

  async quitApp() {
    try {
      if (window.electronAPI && window.electronAPI.quitApp) {
        await window.electronAPI.quitApp();
      } else {
        window.close();
      }
    } catch (error) {
      console.error('Failed to quit app:', error);
    }
  }

  async saveMessageSettings() {
    const input = document.getElementById('message-limit');
    const hoursInput = document.getElementById('ai-analysis-hours');
    const autoBatchIntervalInput = document.getElementById('auto-batch-interval-minutes');
    const confidenceInput = document.getElementById('lead-confidence-threshold');
    if (!input || !hoursInput || !autoBatchIntervalInput || !confidenceInput) return;

    const value = parseInt(input.value, 10);
    if (Number.isNaN(value) || value <= 0 || value > 500) {
      this.showToast('请输入 1 到 500 之间的数字', 'warning');
      return;
    }

    const hours = parseInt(hoursInput.value, 10);
    if (Number.isNaN(hours) || hours < 1 || hours > 48) {
      this.showToast('AI识别范围请输入 1 到 48 小时之间的数字', 'warning');
      return;
    }

    const autoIntervalRaw = autoBatchIntervalInput.value.trim();
    let autoIntervalMinutes = 0;
    if (autoIntervalRaw) {
      autoIntervalMinutes = parseInt(autoIntervalRaw, 10);
      if (Number.isNaN(autoIntervalMinutes) || autoIntervalMinutes < 5) {
        this.showToast('自动分析间隔最小为 5 分钟', 'warning');
        return;
      }
    }

    const confidenceThreshold = parseFloat(confidenceInput.value);
    if (Number.isNaN(confidenceThreshold) || confidenceThreshold < 0.5 || confidenceThreshold > 0.95) {
      this.showToast('最低抓取把握度请输入 0.50 到 0.95 之间的数字', 'warning');
      return;
    }

    this.messagePageLimit = value;
    localStorage.setItem('messagePageLimit', String(value));
    this.aiAnalysisHours = hours;
    localStorage.setItem('aiAnalysisHours', String(hours));
    this.leadConfidenceThreshold = confidenceThreshold;
    localStorage.setItem('leadConfidenceThreshold', String(confidenceThreshold));
    this.autoBatchIntervalMinutes = autoIntervalMinutes || 0;
    this.saveBatchTodoSettings();
    this.startAutoBatchExtract();
    this.showToast('显示与抓取设置已保存', 'success');
  }

  openTodoDetail(id) {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) {
      this.showToast('未找到待办详情', 'error');
      return;
    }

    const modal = document.getElementById('todo-detail-modal');
    const titleEl = document.getElementById('todo-detail-title');
    const contentEl = document.getElementById('todo-detail-content');
    if (!modal || !titleEl || !contentEl) return;

    const priorityLabel = this.getPriorityLabel(todo.priority);
    const dueDateStr = todo.dueDate ? new Date(todo.dueDate).toLocaleDateString() : '无';
    const groupTag = todo.groupName ? `📁 ${escapeHtml(todo.groupName)}` : '未知群组';
    const senderTag = todo.sender ? `👤 ${escapeHtml(todo.sender)}` : '未知发送者';
    const timeTag = todo.messageTime ? `🕒 ${escapeHtml(todo.messageTime)}` : '未知时间';
    const description = todo.description ? escapeHtml(todo.description) : '无';
    const sourcePreview = todo.sourceMessage ? escapeHtml(todo.sourceMessage) : '无';

    titleEl.textContent = todo.title || '待办详情';
    contentEl.innerHTML = `
      <div style="margin-bottom: 12px;">
        <span class="priority-badge priority-${escapeHtml(todo.priority)}">${priorityLabel}</span>
        ${todo.source === 'ai-generated' ? '<span class="source-badge">AI生成</span>' : ''}
        <span style="margin-left:8px;">截止: ${dueDateStr}</span>
      </div>
      <div style="margin-bottom: 12px; display:flex; gap:8px; flex-wrap:wrap;">
        <span class="meta-tag time-tag">${timeTag}</span>
        <span class="meta-tag group-tag">${groupTag}</span>
        <span class="meta-tag sender-tag">${senderTag}</span>
      </div>
      <div style="margin-bottom: 12px;">
        <h4 style="margin:0 0 8px 0;">详细描述</h4>
        <div>${description}</div>
      </div>
      <div>
        <h4 style="margin:0 0 8px 0;">源消息片段</h4>
        <pre class="source-preview">${sourcePreview}</pre>
      </div>
    `;

    modal.classList.add('active');
  }

  closeTodoDetail() {
    const modal = document.getElementById('todo-detail-modal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // Utilities
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.toggle('active', show);
  }
}

// Initialize app
const app = new WeChatAIApp();
