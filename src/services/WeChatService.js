const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Configuration constants
const MONITOR_INTERVAL_MS = 15000; // Check for new messages every 15 seconds
const SIMULATE_MESSAGE_CHANCE = 0.3; // 30% chance of generating a simulated message

// Path to Python script
const PYTHON_SCRIPT_PATH = path.join(__dirname, '..', 'python', 'wechat_reader.py');

/**
 * WeChat Service - Handles WeChat data reading and processing
 * Uses Python module based on https://github.com/TC999/WeChatMsg implementation
 * 
 * Supports WeChat 4.0 with database version 4.
 * 
 * WeChat stores its data in SQLite databases in the user's AppData folder.
 * The main databases include:
 * - contact/contact.db: Contains contacts (WeChat 4.0)
 * - session/session.db: Contains session info
 * - message/message_*.db: Contains messages
 */
class WeChatService {
  constructor() {
    this.dataPath = null;
    this.dbKey = null;
    this.isConfigured = false;
    this.monitoringActive = false;
    this.monitorInterval = null;
    this.lastMessageTime = null;
    this.monitorCallback = null;
    this.dbVersion = null;
    
    // Cache for contacts and groups
    this.contactsCache = [];
    this.groupsCache = [];
    this.messagesCache = new Map();
    this.groupLastMessageTimes = new Map();
  }

  /**
   * Execute Python script and return JSON result
   * @param {string} command - Command to execute
   * @param {Array} args - Additional arguments
   * @returns {Promise<object>} Parsed JSON result
   */
  async executePython(command, args = []) {
    return new Promise((resolve, reject) => {
      const allArgs = [PYTHON_SCRIPT_PATH, command, ...args];
      const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
      
      const python = spawn(pythonCommand, allArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          // If the primary command failed, and we haven't tried the fallback yet
          // logic could be complex here.
          // Instead, relying on correct command selection above is better.
          
          console.error(`Python script error (code ${code}):`, stderr);
          reject(new Error(stderr || `Python script exited with code ${code}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          resolve(result);
        } catch (parseError) {
          console.error('Failed to parse Python output:', stdout);
          reject(new Error('Failed to parse Python output'));
        }
      });

      python.on('error', (error) => {
        // Fallback logic could be here if we want to try the other command
        // But since we detect platform, we should be good.
        // Keeping original fallback logic just in case, but adapted
        
        const fallbackCommand = pythonCommand === 'python' ? 'python3' : 'python';
        console.log(`Primary python command failed, trying ${fallbackCommand}...`);
        
        const pythonAlt = spawn(fallbackCommand, allArgs, {
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        // ... rest of fallback logic ...
        let altStdout = '';
        let altStderr = '';

        pythonAlt.stdout.on('data', (data) => {
          altStdout += data.toString();
        });

        pythonAlt.stderr.on('data', (data) => {
          altStderr += data.toString();
        });

        pythonAlt.on('close', (altCode) => {
          if (altCode !== 0) {
            reject(new Error(altStderr || error.message));
            return;
          }

          try {
            const result = JSON.parse(altStdout);
            resolve(result);
          } catch (parseError) {
            reject(new Error('Failed to parse Python output'));
          }
        });

        pythonAlt.on('error', () => {
          reject(new Error('Python is not available. Please install Python 3.'));
        });
      });
    });
  }

  getStatus() {
    return {
      isConfigured: this.isConfigured,
      dataPath: this.dataPath,
      isMonitoring: this.monitoringActive,
      contactCount: this.contactsCache.length,
      groupCount: this.groupsCache.length,
      isUsingDemoData: !this.isConfigured,
      dbVersion: this.dbVersion
    };
  }

  async configure(dataPath, dbKey = null) {
    if (!dataPath) {
      throw new Error('请提供微信数据目录路径');
    }

    // Validate path exists
    if (!fs.existsSync(dataPath)) {
      throw new Error('指定的路径不存在');
    }

    this.dataPath = dataPath;
    this.dbKey = dbKey;

    // Try to load data using Python module
    try {
      const result = await this.executePython('init', [dataPath]);
      
      if (result.success) {
        this.isConfigured = true;
        this.dbVersion = result.status?.dbVersion || 4;
        
        // Load contacts and groups
        await this.loadInitialData();
        
        return {
          success: true,
          message: '配置成功，已加载微信数据',
          status: this.getStatus()
        };
      } else {
        // Fall back to demo data
        this.isConfigured = false;
        this.contactsCache = this.generateSampleContacts();
        this.groupsCache = this.generateSampleGroups();
        
        return {
          success: true,
          message: '配置成功，但未找到有效的微信数据库，使用示例数据',
          status: this.getStatus()
        };
      }
    } catch (error) {
      console.error('Python module error:', error.message);
      
      // Fall back to demo data
      this.isConfigured = false;
      this.contactsCache = this.generateSampleContacts();
      this.groupsCache = this.generateSampleGroups();
      
      return {
        success: true,
        message: `配置成功，但无法读取微信数据库 (${error.message})，使用示例数据`,
        status: this.getStatus()
      };
    }
  }

  async loadInitialData() {
    if (!this.dataPath) {
      this.contactsCache = this.generateSampleContacts();
      this.groupsCache = this.generateSampleGroups();
      return;
    }

    try {
      // Load contacts using Python
      const contacts = await this.executePython('contacts', [this.dataPath]);
      if (Array.isArray(contacts) && contacts.length > 0) {
        this.contactsCache = contacts;
      } else {
        this.contactsCache = this.generateSampleContacts();
      }

      // Load groups using Python
      const groups = await this.executePython('groups', [this.dataPath]);
      if (Array.isArray(groups) && groups.length > 0) {
        this.groupsCache = groups;
      } else {
        this.groupsCache = this.generateSampleGroups();
      }

      console.log(`Loaded ${this.contactsCache.length} contacts and ${this.groupsCache.length} groups from WeChat database`);
    } catch (error) {
      console.error('Failed to load data from WeChat database:', error.message);
      this.contactsCache = this.generateSampleContacts();
      this.groupsCache = this.generateSampleGroups();
    }
  }

  generateSampleContacts() {
    return [
      { id: 'wxid_001', name: '张三', avatar: null, type: 'friend' },
      { id: 'wxid_002', name: '李四', avatar: null, type: 'friend' },
      { id: 'wxid_003', name: '王五', avatar: null, type: 'friend' },
      { id: 'wxid_004', name: '赵六', avatar: null, type: 'friend' },
      { id: 'wxid_005', name: '工作伙伴', avatar: null, type: 'friend' }
    ];
  }

  generateSampleGroups() {
    return [
      { id: 'group_001', name: '工作群', memberCount: 25, avatar: null },
      { id: 'group_002', name: '项目讨论组', memberCount: 8, avatar: null },
      { id: 'group_003', name: '技术交流群', memberCount: 120, avatar: null },
      { id: 'group_004', name: '家庭群', memberCount: 6, avatar: null }
    ];
  }

  async getContacts() {
    if (!this.isConfigured) {
      return this.generateSampleContacts();
    }
    
    // Refresh from database if cache is empty
    if (this.contactsCache.length === 0) {
      try {
        const contacts = await this.executePython('contacts', [this.dataPath]);
        if (Array.isArray(contacts) && contacts.length > 0) {
          this.contactsCache = contacts;
        }
      } catch (error) {
        console.error('Failed to refresh contacts:', error.message);
      }
    }
    
    return this.contactsCache;
  }

  async getGroups() {
    if (!this.isConfigured) {
      return this.generateSampleGroups();
    }
    
    // Refresh from database if cache is empty
    if (this.groupsCache.length === 0) {
      try {
        const groups = await this.executePython('groups', [this.dataPath]);
        if (Array.isArray(groups) && groups.length > 0) {
          this.groupsCache = groups;
        }
      } catch (error) {
        console.error('Failed to refresh groups:', error.message);
      }
    }
    
    return this.groupsCache;
  }

  async getMessages(chatId, limit = 100, offset = 0) {
    if (!this.isConfigured) {
      const sampleMessages = this.generateSampleMessages(chatId, limit);
      return {
        messages: sampleMessages,
        total: 1000,
        hasMore: offset + limit < 1000
      };
    }

    try {
      const result = await this.executePython('messages', [
        this.dataPath,
        chatId,
        String(limit),
        String(offset)
      ]);

      if (result && Array.isArray(result.messages)) {
        const total = typeof result.total === 'number'
          ? result.total
          : result.messages.length;
        const hasMore = typeof result.hasMore === 'boolean'
          ? result.hasMore
          : offset + result.messages.length < total;

        return {
          messages: result.messages,
          total,
          hasMore
        };
      }

      return {
        messages: [],
        total: 0,
        hasMore: false
      };
    } catch (error) {
      console.error('Failed to get messages from database:', error.message);
      return {
        messages: [],
        total: 0,
        hasMore: false
      };
    }
  }

  generateSampleMessages(chatId, count) {
    const messages = [];
    const senders = ['我', '张三', '李四', '王五'];
    const contents = [
      '好的，明天下午3点开会讨论项目进度',
      '收到，我会准备好PPT',
      '记得把上周的数据分析报告发给我',
      '@所有人 本周五前提交季度总结',
      '会议室已经预定好了',
      '有人看到我的文件了吗？',
      '明天的客户拜访需要准备什么材料？',
      '项目截止日期是下周三',
      '请查收邮件中的合同草案',
      '周末有空一起打球吗？'
    ];

    for (let i = 0; i < count; i++) {
      const isMe = Math.random() > 0.6;
      messages.push({
        id: `msg_${chatId}_${i}`,
        chatId,
        sender: isMe ? '我' : senders[Math.floor(Math.random() * senders.length)],
        content: contents[Math.floor(Math.random() * contents.length)],
        timestamp: Date.now() - (count - i) * 60000 * 5,
        type: 'text',
        isMe
      });
    }

    return messages;
  }

  async startMonitoring(groupIds, callback) {
    if (this.monitoringActive) {
      this.stopMonitoring();
    }

    this.monitoringActive = true;
    this.monitorCallback = callback;
    this.lastMessageTime = Math.floor(Date.now() / 1000);

    // If we have real database access, poll for new messages
    // Otherwise, simulate new messages for demo
    if (this.isConfigured) {
      this.monitorInterval = setInterval(() => {
        this.pollForNewMessages(groupIds);
      }, MONITOR_INTERVAL_MS);
    } else {
      // For demo, we simulate new messages periodically
      this.monitorInterval = setInterval(() => {
        this.simulateNewMessage(groupIds);
      }, MONITOR_INTERVAL_MS);
    }

    return { success: true };
  }

  async pollForNewMessages(groupIds) {
    if (!this.monitorCallback || groupIds.length === 0) return;

    for (const groupId of groupIds) {
      try {
        // Get latest messages
        const result = await this.executePython('messages', [
          this.dataPath,
          groupId,
          '10',  // Get last 10 messages
          '0'
        ]);

        if (result.messages && result.messages.length > 0) {
          const group = this.groupsCache.find(g => g.id === groupId);
          
          // Get the last message time for this specific group
          // Fallback to global lastMessageTime if not found in Map
          let lastCheckTime = this.groupLastMessageTimes.get(groupId);
          if (lastCheckTime === undefined) {
             lastCheckTime = this.lastMessageTime;
             this.groupLastMessageTimes.set(groupId, lastCheckTime);
          }

          console.log(`Polled ${result.messages.length} messages for group ${groupId}. Last check time: ${lastCheckTime}`);
          
          for (const msg of result.messages) {
            // msg.timestamp is already in milliseconds from Python
            // this.lastMessageTime is in seconds (Unix timestamp)
            const msgTimeSeconds = Math.floor(msg.timestamp / 1000);
            
            // Log for debugging
            // console.log(`Msg time: ${msgTimeSeconds}, Last check: ${lastCheckTime}, Is me: ${msg.isMe}`);
            
            if (msgTimeSeconds > lastCheckTime && !msg.isMe) {
              console.log(`Found new message: ${msg.id} from ${msgTimeSeconds}`);
              
              // Update the time for this group
              lastCheckTime = msgTimeSeconds;
              this.groupLastMessageTimes.set(groupId, lastCheckTime);
              
              const newMessage = {
                id: msg.id,
                chatId: groupId,
                groupName: group?.name || '未知群组',
                sender: msg.sender,
                content: msg.content,
                timestamp: msg.timestamp,
                type: msg.type,
                isMe: false
              };

              this.monitorCallback(newMessage);
            }
          }
        }
      } catch (error) {
        console.error(`Error polling messages for ${groupId}:`, error.message);
      }
    }
  }

  simulateNewMessage(groupIds) {
    if (!this.monitorCallback || groupIds.length === 0) return;

    // Randomly decide if there's a new message
    if (Math.random() > SIMULATE_MESSAGE_CHANCE) return;

    const groupId = groupIds[Math.floor(Math.random() * groupIds.length)];
    const group = this.groupsCache.find(g => g.id === groupId);
    const senders = ['张三', '李四', '王五', '赵六'];
    const contents = [
      '大家好，今天的会议改到下午4点',
      '请注意查收刚发的邮件',
      '有人能帮我review一下代码吗？',
      '提醒：明天是项目deadline',
      '周五下班前记得提交周报'
    ];

    const newMessage = {
      id: `msg_${Date.now()}`,
      chatId: groupId,
      groupName: group?.name || '未知群组',
      sender: senders[Math.floor(Math.random() * senders.length)],
      content: contents[Math.floor(Math.random() * contents.length)],
      timestamp: Date.now(),
      type: 'text',
      isMe: false
    };

    this.monitorCallback(newMessage);
  }

  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.monitoringActive = false;
    this.monitorCallback = null;
  }

  /**
   * Parse WeChat database path from system
   * On Windows, WeChat typically stores data in:
   * - %USERPROFILE%\Documents\WeChat Files\{wxid}\
   * - For WeChat 4.0: %USERPROFILE%\Documents\xwechat_files\{wxid}\db_storage\
   */
  static findWeChatDataPath() {
    if (process.platform === 'win32') {
      const userProfile = process.env.USERPROFILE;
      
      // Check WeChat 4.0 path first
      const wechat4Path = path.join(userProfile, 'Documents', 'xwechat_files');
      if (fs.existsSync(wechat4Path)) {
        const dirs = fs.readdirSync(wechat4Path);
        const wxidDirs = dirs.filter(d => d.startsWith('wxid_'));
        if (wxidDirs.length > 0) {
          const dbStorage = path.join(wechat4Path, wxidDirs[0], 'db_storage');
          if (fs.existsSync(dbStorage)) {
            return dbStorage;
          }
        }
      }
      
      // Fall back to older WeChat path
      const defaultPath = path.join(userProfile, 'Documents', 'WeChat Files');
      if (fs.existsSync(defaultPath)) {
        const dirs = fs.readdirSync(defaultPath);
        const wxidDirs = dirs.filter(d => d.startsWith('wxid_'));
        if (wxidDirs.length > 0) {
          return path.join(defaultPath, wxidDirs[0]);
        }
      }
    }
    return null;
  }
}

module.exports = WeChatService;
