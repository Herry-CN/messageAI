#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
WeChat Data Reader for WeChat AI Assistant
Based on https://github.com/TC999/WeChatMsg implementation

Supports WeChat 4.0 with database version 4.
"""

import hashlib
import json
import os
import sqlite3
import sys
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime


# Message types matching WeChat's internal type codes
class MessageType:
    TEXT = 1
    IMAGE = 3
    VOICE = 34
    CONTACT_CARD = 42
    VIDEO = 43
    EMOJI = 47
    LOCATION = 48
    LINK = 49
    VOIP = 50
    SYSTEM = 10000
    REVOKE = 10002


@dataclass
class Contact:
    """Contact/Person data model"""
    wxid: str
    nickname: str
    remark: str
    alias: str = ''
    small_head_img_url: str = ''
    type: str = 'friend'
    is_chatroom: bool = False
    member_count: int = 0

    def to_dict(self) -> dict:
        return {
            'id': self.wxid,
            'name': self.remark or self.nickname or self.wxid,
            'alias': self.alias,
            'avatar': self.small_head_img_url or None,
            'type': 'group' if self.is_chatroom else 'friend',
            'memberCount': self.member_count
        }


@dataclass
class Message:
    """Message data model"""
    local_id: int
    server_id: int
    msg_type: int
    sender_username: str
    create_time: int
    content: str
    is_sender: bool
    talker: str

    def to_dict(self, contact_map: Dict[str, str] = None) -> dict:
        sender_name = '我' if self.is_sender else (
            contact_map.get(self.sender_username, self.sender_username) if contact_map else self.sender_username
        )
        return {
            'id': f'msg_{self.local_id}',
            'chatId': self.talker,
            'sender': sender_name,
            'content': self.content or '',
            'timestamp': self.create_time * 1000,  # Convert to milliseconds
            'type': self._get_type_name(),
            'isMe': self.is_sender
        }

    def _get_type_name(self) -> str:
        types = {
            MessageType.TEXT: 'text',
            MessageType.IMAGE: 'image',
            MessageType.VOICE: 'voice',
            MessageType.CONTACT_CARD: 'contact',
            MessageType.VIDEO: 'video',
            MessageType.EMOJI: 'emoji',
            MessageType.LOCATION: 'location',
            MessageType.LINK: 'link',
            MessageType.SYSTEM: 'system',
            MessageType.REVOKE: 'revoke'
        }
        return types.get(self.msg_type, 'unknown')


class WeChatDatabaseV4:
    """
    WeChat database reader for version 4 (WeChat 4.0+)
    Based on https://github.com/TC999/WeChatMsg implementation
    """

    def __init__(self, db_dir: str):
        self.db_dir = db_dir
        self.contact_db = None
        self.session_db = None
        self.message_dbs: List[sqlite3.Connection] = []
        self.contacts_map: Dict[str, Contact] = {}
        self._initialized = False

    def init_database(self) -> bool:
        """Initialize database connections"""
        try:
            # Contact database - WeChat 4.0 structure
            contact_db_path = os.path.join(self.db_dir, 'contact', 'contact.db')
            flat_contact_db_path = os.path.join(self.db_dir, 'contact.db')
            
            if os.path.exists(contact_db_path):
                self.contact_db = sqlite3.connect(contact_db_path)
                self.contact_db.row_factory = sqlite3.Row
            elif os.path.exists(flat_contact_db_path):
                # Try flat structure (contact.db in root)
                self.contact_db = sqlite3.connect(flat_contact_db_path)
                self.contact_db.row_factory = sqlite3.Row
            else:
                # Try alternative path (direct MicroMsg.db)
                micromsg_path = os.path.join(self.db_dir, 'MicroMsg.db')
                if os.path.exists(micromsg_path):
                    self.contact_db = sqlite3.connect(micromsg_path)
                    self.contact_db.row_factory = sqlite3.Row
                else:
                    # Try Msg subdirectory
                    msg_micromsg_path = os.path.join(self.db_dir, 'Msg', 'MicroMsg.db')
                    if os.path.exists(msg_micromsg_path):
                        self.contact_db = sqlite3.connect(msg_micromsg_path)
                        self.contact_db.row_factory = sqlite3.Row

            # Session database
            session_db_path = os.path.join(self.db_dir, 'session', 'session.db')
            flat_session_db_path = os.path.join(self.db_dir, 'session.db')
            
            if os.path.exists(session_db_path):
                self.session_db = sqlite3.connect(session_db_path)
                self.session_db.row_factory = sqlite3.Row
            elif os.path.exists(flat_session_db_path):
                self.session_db = sqlite3.connect(flat_session_db_path)
                self.session_db.row_factory = sqlite3.Row

            # Message databases - WeChat 4.0 uses message_0.db, message_1.db, etc.
            message_dir = os.path.join(self.db_dir, 'message')
            flat_message_path_exists = False
            
            # Check for flat message_*.db files
            if os.path.exists(os.path.join(self.db_dir, 'message_0.db')):
                flat_message_path_exists = True
                for i in range(100):
                    msg_db_path = os.path.join(self.db_dir, f'message_{i}.db')
                    if os.path.exists(msg_db_path):
                        db = sqlite3.connect(msg_db_path)
                        db.row_factory = sqlite3.Row
                        self.message_dbs.append(db)
                    else:
                        break
            
            if not flat_message_path_exists and os.path.exists(message_dir):
                for i in range(100):  # Check up to message_99.db
                    msg_db_path = os.path.join(message_dir, f'message_{i}.db')
                    if os.path.exists(msg_db_path):
                        db = sqlite3.connect(msg_db_path)
                        db.row_factory = sqlite3.Row
                        self.message_dbs.append(db)
                    else:
                        break  # Stop when we don't find the next file
            elif not flat_message_path_exists:
                # Try MSG*.db format for older structure
                msg_folder = os.path.join(self.db_dir, 'Msg')
                if os.path.exists(msg_folder):
                    for filename in os.listdir(msg_folder):
                        if filename.startswith('MSG') and filename.endswith('.db'):
                            msg_db_path = os.path.join(msg_folder, filename)
                            db = sqlite3.connect(msg_db_path)
                            db.row_factory = sqlite3.Row
                            self.message_dbs.append(db)

            self._initialized = self.contact_db is not None
            return self._initialized

        except Exception as e:
            print(f"Error initializing database: {e}", file=sys.stderr)
            return False

    def close(self):
        """Close all database connections"""
        if self.contact_db:
            self.contact_db.close()
        if self.session_db:
            self.session_db.close()
        for db in self.message_dbs:
            db.close()

    def get_contacts(self) -> List[Contact]:
        """
        Get all contacts from the database
        WeChat 4.0 contact table structure
        """
        if not self.contact_db:
            return []

        contacts = []
        try:
            cursor = self.contact_db.cursor()
            
            # Try WeChat 4.0 structure first
            try:
                cursor.execute("""
                    SELECT username, alias, local_type, flag, remark, nick_name, 
                           small_head_url, big_head_url
                    FROM contact
                    WHERE (local_type=1 OR local_type=2 OR local_type=5)
                    ORDER BY nick_name
                """)
                rows = cursor.fetchall()
                
                for row in rows:
                    wxid = row['username']
                    is_chatroom = wxid.endswith('@chatroom')
                    contact = Contact(
                        wxid=wxid,
                        nickname=row['nick_name'] or wxid,
                        remark=row['remark'] or row['nick_name'] or wxid,
                        alias=row['alias'] or '',
                        small_head_img_url=row['small_head_url'] or '',
                        is_chatroom=is_chatroom
                    )
                    contacts.append(contact)
                    self.contacts_map[wxid] = contact

            except sqlite3.OperationalError:
                # Fall back to older WeChat structure (MicroMsg.db)
                cursor.execute("""
                    SELECT UserName, Alias, NickName, Type, Remark
                    FROM Contact
                    WHERE Type != 4
                      AND UserName NOT LIKE 'gh_%'
                      AND UserName != 'filehelper'
                      AND UserName != 'floatbottle'
                      AND UserName != 'medianote'
                      AND UserName != 'fmessage'
                    ORDER BY NickName
                """)
                rows = cursor.fetchall()
                
                for row in rows:
                    wxid = row['UserName']
                    is_chatroom = wxid.endswith('@chatroom')
                    contact = Contact(
                        wxid=wxid,
                        nickname=row['NickName'] or wxid,
                        remark=row['Remark'] or row['NickName'] or wxid,
                        alias=row['Alias'] or '',
                        is_chatroom=is_chatroom
                    )
                    contacts.append(contact)
                    self.contacts_map[wxid] = contact

        except Exception as e:
            print(f"Error getting contacts: {e}", file=sys.stderr)

        return contacts

    def get_groups(self) -> List[Contact]:
        """Get all group chats (chatrooms)"""
        if not self.contact_db:
            return []

        groups = []
        try:
            cursor = self.contact_db.cursor()
            
            # Try WeChat 4.0 structure
            try:
                cursor.execute("""
                    SELECT c.username, c.alias, c.nick_name, c.remark,
                           c.small_head_url
                    FROM contact c
                    WHERE c.username LIKE '%@chatroom'
                    ORDER BY c.nick_name
                """)
                rows = cursor.fetchall()
                
                for row in rows:
                    wxid = row['username']
                    # Get member count from chat_room table
                    member_count = self._get_chatroom_member_count(wxid)
                    
                    group = Contact(
                        wxid=wxid,
                        nickname=row['nick_name'] or wxid,
                        remark=row['remark'] or row['nick_name'] or wxid,
                        alias=row['alias'] or '',
                        small_head_img_url=row['small_head_url'] or '',
                        is_chatroom=True,
                        member_count=member_count
                    )
                    groups.append(group)
                    self.contacts_map[wxid] = group

            except sqlite3.OperationalError:
                # Fall back to older structure
                cursor.execute("""
                    SELECT UserName, Alias, NickName, Remark
                    FROM Contact
                    WHERE UserName LIKE '%@chatroom'
                    ORDER BY NickName
                """)
                rows = cursor.fetchall()
                
                for row in rows:
                    wxid = row['UserName']
                    group = Contact(
                        wxid=wxid,
                        nickname=row['NickName'] or wxid,
                        remark=row['Remark'] or row['NickName'] or wxid,
                        alias=row['Alias'] or '',
                        is_chatroom=True,
                        member_count=0
                    )
                    groups.append(group)
                    self.contacts_map[wxid] = group

        except Exception as e:
            print(f"Error getting groups: {e}", file=sys.stderr)

        return groups

    def _get_chatroom_member_count(self, chatroom_name: str) -> int:
        """Get member count for a chatroom"""
        try:
            cursor = self.contact_db.cursor()
            cursor.execute("""
                SELECT ext_buffer FROM chat_room WHERE username = ?
            """, (chatroom_name,))
            row = cursor.fetchone()
            if row and row['ext_buffer']:
                # Parse protobuf to get member count - simplified version
                # In full implementation, would use protobuf parser
                return 0
        except (sqlite3.Error, KeyError):
            pass
        return 0

    def get_messages(self, username: str, limit: int = 100, offset: int = 0, start_time: int = 0) -> Tuple[List[Message], int]:
        """
        Get messages for a specific chat
        WeChat 4.0 uses table name format: Msg_{md5(username)}
        """
        if not self.message_dbs:
            return [], 0

        # Build contact name map
        contact_map = {c.wxid: c.remark or c.nickname for c in self.contacts_map.values()}

        all_messages = []
        # Generate table name from MD5 hash - this is safe as it only contains hex chars
        table_name = f'Msg_{hashlib.md5(username.encode("utf-8")).hexdigest()}'
        
        # Validate table name format to prevent SQL injection (must be Msg_ followed by 32 hex chars)
        import re
        if not re.match(r'^Msg_[a-f0-9]{32}$', table_name):
            print(f"Invalid table name format: {table_name}", file=sys.stderr)
            return [], 0

        for db in self.message_dbs:
            try:
                cursor = db.cursor()
                
                # Check if table exists using parameterized query
                cursor.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    (table_name,)
                )
                if not cursor.fetchone():
                    continue

                # WeChat 4.0 message table structure
                # Note: table_name is validated above to only contain safe characters
                # Try to get messages with Name2Id join for sender info
                try:
                    query = f"""
                        SELECT msg.local_id, msg.server_id, msg.local_type, 
                               Name2Id.user_name as sender_username,
                               msg.create_time, msg.message_content, 
                               CASE WHEN Name2Id.user_name = ? THEN 1 ELSE 0 END as is_sender
                        FROM {table_name} as msg
                        LEFT JOIN Name2Id ON msg.real_sender_id = Name2Id.rowid
                    """
                    params = [self._get_my_wxid()]
                    
                    if start_time > 0:
                        query += " WHERE msg.create_time >= ?"
                        params.append(start_time)
                        
                    query += " ORDER BY msg.create_time DESC LIMIT ? OFFSET ?"
                    params.extend([limit, offset])
                    
                    cursor.execute(query, params)
                except sqlite3.OperationalError:
                    # Fallback without Name2Id join
                    query = f"""
                        SELECT local_id, server_id, local_type,
                               '' as sender_username,
                               create_time, message_content,
                               0 as is_sender
                        FROM {table_name}
                    """
                    params = []
                    
                    if start_time > 0:
                        query += " WHERE create_time >= ?"
                        params.append(start_time)
                        
                    query += " ORDER BY create_time DESC LIMIT ? OFFSET ?"
                    params.extend([limit, offset])
                    
                    cursor.execute(query, params)

                rows = cursor.fetchall()

                for row in rows:
                    # Decompress content if needed (WeChat 4.0 uses zstd compression)
                    content = row['message_content']
                    if isinstance(content, bytes):
                        try:
                            import zstandard as zstd
                            dctx = zstd.ZstdDecompressor()
                            content = dctx.decompress(content).decode('utf-8')
                        except (ImportError, Exception) as e:
                            # zstandard not installed or decompression failed
                            content = content.decode('utf-8', errors='ignore') if content else ''

                    msg = Message(
                        local_id=row['local_id'],
                        server_id=row['server_id'] if row['server_id'] else 0,
                        msg_type=row['local_type'],
                        sender_username=row['sender_username'] or '',
                        create_time=row['create_time'],
                        content=content if isinstance(content, str) else '',
                        is_sender=bool(row['is_sender']),
                        talker=username
                    )
                    all_messages.append(msg)

            except Exception as e:
                print(f"Error getting messages from {db}: {e}", file=sys.stderr)
                continue

        # Sort by timestamp and return
        all_messages.sort(key=lambda m: m.create_time)
        return all_messages, len(all_messages)

    def _get_my_wxid(self) -> str:
        """Get the current user's wxid from info.json or database"""
        info_path = os.path.join(self.db_dir, 'info.json')
        if os.path.exists(info_path):
            try:
                with open(info_path, 'r', encoding='utf-8') as f:
                    info = json.load(f)
                    return info.get('username', '')
            except:
                pass
        return ''

    def get_status(self) -> dict:
        """Get database status"""
        return {
            'initialized': self._initialized,
            'hasContactDb': self.contact_db is not None,
            'hasSessionDb': self.session_db is not None,
            'messageDbCount': len(self.message_dbs),
            'contactCount': len(self.contacts_map),
            'dbVersion': 4
        }


def main():
    """
    Main entry point for CLI usage
    Accepts JSON commands from stdin and outputs JSON responses to stdout
    """
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: wechat_reader.py <command> [args...]'}))
        sys.exit(1)

    command = sys.argv[1]
    
    if command == 'init':
        if len(sys.argv) < 3:
            print(json.dumps({'error': 'Missing db_dir argument'}))
            sys.exit(1)
        
        db_dir = sys.argv[2]
        reader = WeChatDatabaseV4(db_dir)
        success = reader.init_database()
        print(json.dumps({
            'success': success,
            'status': reader.get_status()
        }))
        reader.close()

    elif command == 'contacts':
        if len(sys.argv) < 3:
            print(json.dumps({'error': 'Missing db_dir argument'}))
            sys.exit(1)
        
        db_dir = sys.argv[2]
        reader = WeChatDatabaseV4(db_dir)
        if reader.init_database():
            contacts = reader.get_contacts()
            # Filter out chatrooms for contacts list
            contacts = [c for c in contacts if not c.is_chatroom]
            print(json.dumps([c.to_dict() for c in contacts]))
        else:
            print(json.dumps([]))
        reader.close()

    elif command == 'groups':
        if len(sys.argv) < 3:
            print(json.dumps({'error': 'Missing db_dir argument'}))
            sys.exit(1)
        
        db_dir = sys.argv[2]
        reader = WeChatDatabaseV4(db_dir)
        if reader.init_database():
            groups = reader.get_groups()
            print(json.dumps([g.to_dict() for g in groups]))
        else:
            print(json.dumps([]))
        reader.close()

    elif command == 'messages':
        if len(sys.argv) < 4:
            print(json.dumps({'error': 'Missing arguments: db_dir, username'}))
            sys.exit(1)
        
        db_dir = sys.argv[2]
        username = sys.argv[3]
        limit = int(sys.argv[4]) if len(sys.argv) > 4 else 100
        offset = int(sys.argv[5]) if len(sys.argv) > 5 else 0
        start_time = int(sys.argv[6]) if len(sys.argv) > 6 else 0
        
        reader = WeChatDatabaseV4(db_dir)
        if reader.init_database():
            reader.get_contacts()  # Load contacts for name mapping
            reader.get_groups()
            contact_map = {c.wxid: c.remark or c.nickname for c in reader.contacts_map.values()}
            messages, total = reader.get_messages(username, limit, offset, start_time)
            print(json.dumps({
                'messages': [m.to_dict(contact_map) for m in messages],
                'total': total,
                'hasMore': total > offset + limit
            }))
        else:
            print(json.dumps({'messages': [], 'total': 0, 'hasMore': False}))
        reader.close()

    elif command == 'status':
        if len(sys.argv) < 3:
            print(json.dumps({'error': 'Missing db_dir argument'}))
            sys.exit(1)
        
        db_dir = sys.argv[2]
        reader = WeChatDatabaseV4(db_dir)
        reader.init_database()
        print(json.dumps(reader.get_status()))
        reader.close()

    else:
        print(json.dumps({'error': f'Unknown command: {command}'}))
        sys.exit(1)


if __name__ == '__main__':
    main()
