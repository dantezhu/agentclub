/* ── State ── */
let currentUser = null;
let socket = null;
let currentChat = null; // { type: 'group'|'direct', id, name }
let chats = { groups: [], directs: [] };
let oldestTimestamp = {};
let typingTimeout = null;

/* ── Init ── */
async function init() {
    try {
        const res = await fetch('/api/me');
        if (!res.ok) { window.location.href = '/'; return; }
        currentUser = await res.json();
    } catch { window.location.href = '/'; return; }

    marked.setOptions({
        highlight: function(code, lang) {
            if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(code, { language: lang }).value;
            }
            return hljs.highlightAuto(code).value;
        },
        breaks: true,
    });

    connectSocket();
    await loadChats();
    setupInputHandlers();
}

/* ── Socket.IO ── */
function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('auth_ok', (data) => {
        console.log('Authenticated:', data);
    });

    socket.on('new_message', (msg) => {
        if (currentChat && msg.chat_type === currentChat.type && msg.chat_id === currentChat.id) {
            appendMessage(msg);
            scrollToBottom();
            socket.emit('mark_read', { chat_type: msg.chat_type, chat_id: msg.chat_id });
        }
        updateChatPreview(msg);
    });

    socket.on('offline_messages', (messages) => {
        // Group offline messages by chat
        for (const msg of messages) {
            if (currentChat && msg.chat_type === currentChat.type && msg.chat_id === currentChat.id) {
                appendMessage(msg);
            }
        }
        if (currentChat) scrollToBottom();
    });

    socket.on('typing', (data) => {
        if (currentChat && data.chat_type === currentChat.type && data.chat_id === currentChat.id) {
            showTyping(data.display_name);
        }
    });

    socket.on('presence', (data) => {
        updatePresence(data);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected');
    });
}

/* ── Load Chats ── */
async function loadChats() {
    const [groupsRes, directsRes] = await Promise.all([
        fetch('/api/groups'),
        fetch('/api/direct-chats'),
    ]);
    chats.groups = await groupsRes.json();
    chats.directs = await directsRes.json();
    renderChatList();
}

function renderChatList() {
    const el = document.getElementById('chatList');
    let html = '';

    if (chats.groups.length) {
        html += '<div class="section-label">群组</div>';
        for (const g of chats.groups) {
            const isActive = currentChat && currentChat.type === 'group' && currentChat.id === g.id;
            const initial = g.name.charAt(0);
            html += `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('group','${g.id}','${escHtml(g.name)}')">
                <div class="avatar">${g.avatar ? `<img src="${escHtml(g.avatar)}">` : initial}</div>
                <div class="chat-item-info">
                    <div class="name">${escHtml(g.name)}</div>
                    <div class="preview" id="preview_group_${g.id}"></div>
                </div>
            </div>`;
        }
    }

    if (chats.directs.length) {
        html += '<div class="section-label">私聊</div>';
        for (const d of chats.directs) {
            const isActive = currentChat && currentChat.type === 'direct' && currentChat.id === d.id;
            const initial = (d.peer_name || '?').charAt(0);
            const dot = d.peer_online ? '<span class="online-dot"></span>' : '';
            html += `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('direct','${d.id}','${escHtml(d.peer_name)}')">
                <div class="avatar">${d.peer_avatar ? `<img src="${escHtml(d.peer_avatar)}">` : initial}</div>
                <div class="chat-item-info">
                    <div class="name">${dot}${escHtml(d.peer_name)}</div>
                    <div class="preview" id="preview_direct_${d.id}"></div>
                </div>
            </div>`;
        }
    }

    if (!chats.groups.length && !chats.directs.length) {
        html = '<div style="padding:20px;text-align:center;color:#999;font-size:13px;">还没有对话<br>在管理面板中创建群组</div>';
    }

    el.innerHTML = html;
}

/* ── Open Chat ── */
async function openChat(type, id, name) {
    currentChat = { type, id, name };
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('chatContainer').classList.remove('hidden');
    document.getElementById('chatTitle').textContent = name;
    document.getElementById('messageList').innerHTML = '';
    document.getElementById('loadMoreBtn').classList.add('hidden');
    delete oldestTimestamp[`${type}_${id}`];

    // Join room
    socket.emit('join_chat', { chat_type: type, chat_id: id });

    // Load history
    await loadMessages(type, id);
    scrollToBottom();
    renderChatList();

    // Update subtitle
    if (type === 'group') {
        const members = await (await fetch(`/api/groups/${id}/members`)).json();
        document.getElementById('chatSubtitle').textContent = `${members.length} 名成员`;
        document.getElementById('chatMembersBtn').classList.remove('hidden');
    } else {
        document.getElementById('chatSubtitle').textContent = '';
        document.getElementById('chatMembersBtn').classList.add('hidden');
    }

    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.add('hidden');

    document.getElementById('messageInput').focus();
}

async function loadMessages(type, id, before) {
    let url = `/api/messages/${type}/${id}?limit=50`;
    if (before) url += `&before=${before}`;

    const res = await fetch(url);
    const messages = await res.json();

    if (messages.length > 0) {
        const key = `${type}_${id}`;
        oldestTimestamp[key] = messages[0].created_at;
        if (messages.length >= 50) {
            document.getElementById('loadMoreBtn').classList.remove('hidden');
        }
    }

    const list = document.getElementById('messageList');
    if (before) {
        const frag = document.createDocumentFragment();
        const temp = document.createElement('div');
        for (const msg of messages) {
            temp.innerHTML = renderMessage(msg);
            frag.appendChild(temp.firstElementChild);
        }
        list.insertBefore(frag, list.firstChild);
    } else {
        list.innerHTML = messages.map(renderMessage).join('');
    }

    // Highlight code blocks
    document.querySelectorAll('#messageList pre code').forEach(el => {
        if (!el.dataset.highlighted) hljs.highlightElement(el);
    });
}

async function loadMoreMessages() {
    if (!currentChat) return;
    const key = `${currentChat.type}_${currentChat.id}`;
    const before = oldestTimestamp[key];
    if (!before) return;
    await loadMessages(currentChat.type, currentChat.id, before);
}

/* ── Render Message ── */
function renderMessage(msg) {
    const isSelf = msg.sender_id === currentUser.id;
    const isAgent = msg.sender_is_agent;
    const initial = (msg.sender_name || '?').charAt(0);
    const avatarClass = isAgent ? 'msg-avatar agent' : 'msg-avatar';
    const avatarContent = msg.sender_avatar ? `<img src="${escHtml(msg.sender_avatar)}">` : initial;
    const nameClass = isAgent ? 'msg-sender agent-name' : 'msg-sender';
    const time = formatTime(msg.created_at);
    const content = renderContent(msg);

    return `<div class="message ${isSelf ? 'self' : ''}">
        <div class="${avatarClass}">${avatarContent}</div>
        <div class="msg-body">
            <div class="msg-header">
                <span class="${nameClass}">${escHtml(msg.sender_name)}</span>
                <span class="msg-time">${time}</span>
            </div>
            <div class="msg-content">${content}</div>
        </div>
    </div>`;
}

function renderContent(msg) {
    switch (msg.content_type) {
        case 'image':
            return `<img src="${escHtml(msg.file_url)}" alt="${escHtml(msg.file_name)}" onclick="window.open(this.src)" loading="lazy">`;
        case 'audio':
            return renderAudioPlayer(msg.file_url, msg.file_name);
        case 'video':
            return `<video controls style="max-width:320px;border-radius:8px" preload="metadata"><source src="${escHtml(msg.file_url)}"></video>`;
        case 'file':
            return renderFileAttachment(msg.file_url, msg.file_name);
        case 'code':
            return `<pre><code>${escHtml(msg.content)}</code></pre>`;
        case 'markdown':
        case 'text':
        default:
            return renderMarkdown(msg.content || '');
    }
}

function renderMarkdown(text) {
    // Process @mentions
    text = text.replace(/@(\S+)/g, '<span class="mention-tag">@$1</span>');
    try {
        return marked.parse(text);
    } catch {
        return escHtml(text);
    }
}

function renderAudioPlayer(url, name) {
    const id = 'audio_' + Math.random().toString(36).slice(2);
    return `<div class="audio-player">
        <button onclick="toggleAudio('${id}')" id="${id}_btn">▶</button>
        <div class="audio-progress" onclick="seekAudio(event,'${id}')">
            <div class="audio-progress-fill" id="${id}_fill"></div>
        </div>
        <span class="audio-time" id="${id}_time">0:00</span>
        <audio id="${id}" src="${escHtml(url)}" preload="metadata"
            ontimeupdate="updateAudioProgress('${id}')"
            onended="document.getElementById('${id}_btn').textContent='▶'"></audio>
    </div>`;
}

function renderFileAttachment(url, name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    const icons = { pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊', ppt: '📽', zip: '📦', tar: '📦', gz: '📦' };
    const icon = icons[ext] || '📁';
    return `<div class="file-attachment">
        <span class="file-icon">${icon}</span>
        <div class="file-info">
            <a href="${escHtml(url)}" download="${escHtml(name)}">
                <div class="file-name">${escHtml(name)}</div>
            </a>
        </div>
    </div>`;
}

/* ── Audio helpers ── */
function toggleAudio(id) {
    const audio = document.getElementById(id);
    const btn = document.getElementById(id + '_btn');
    if (audio.paused) { audio.play(); btn.textContent = '⏸'; }
    else { audio.pause(); btn.textContent = '▶'; }
}

function updateAudioProgress(id) {
    const audio = document.getElementById(id);
    const fill = document.getElementById(id + '_fill');
    const timeEl = document.getElementById(id + '_time');
    if (audio.duration) {
        fill.style.width = (audio.currentTime / audio.duration * 100) + '%';
        const s = Math.floor(audio.currentTime);
        timeEl.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }
}

function seekAudio(event, id) {
    const audio = document.getElementById(id);
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    if (audio.duration) audio.currentTime = ratio * audio.duration;
}

/* ── Send Message ── */
function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || !currentChat) return;

    // Parse @mentions from text
    const mentions = [];
    const mentionRegex = /@(\S+)/g;
    let match;
    while ((match = mentionRegex.exec(text)) !== null) {
        mentions.push(match[1]);
    }

    socket.emit('send_message', {
        chat_type: currentChat.type,
        chat_id: currentChat.id,
        content: text,
        content_type: 'text',
        mentions: mentions,
    });

    input.value = '';
    input.style.height = 'auto';
}

async function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file || !currentChat) return;
    event.target.value = '';

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) { alert('上传失败'); return; }
        const data = await res.json();

        socket.emit('send_message', {
            chat_type: currentChat.type,
            chat_id: currentChat.id,
            content: '',
            content_type: data.content_type,
            file_url: data.url,
            file_name: data.filename,
        });
    } catch { alert('上传失败'); }
}

/* ── Input handlers ── */
function setupInputHandlers() {
    const input = document.getElementById('messageInput');

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 120) + 'px';

        // Typing indicator
        if (currentChat) {
            socket.emit('typing', { chat_type: currentChat.type, chat_id: currentChat.id });
        }
    });

    // Menu toggle
    document.getElementById('menuBtn').addEventListener('click', () => {
        document.getElementById('sidebarMenu').classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('sidebarMenu');
        const btn = document.getElementById('menuBtn');
        if (!menu.contains(e.target) && !btn.contains(e.target)) {
            menu.classList.add('hidden');
        }
    });
}

/* ── Typing indicator ── */
function showTyping(name) {
    const el = document.getElementById('typingIndicator');
    el.textContent = `${name} 正在输入...`;
    el.classList.remove('hidden');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => el.classList.add('hidden'), 3000);
}

/* ── Presence ── */
function updatePresence(data) {
    // Re-render chat list to update online dots
    loadChats();
}

function updateChatPreview(msg) {
    const previewEl = document.getElementById(`preview_${msg.chat_type}_${msg.chat_id}`);
    if (previewEl) {
        let text = msg.content || '';
        if (msg.content_type === 'image') text = '[图片]';
        else if (msg.content_type === 'audio') text = '[语音]';
        else if (msg.content_type === 'video') text = '[视频]';
        else if (msg.content_type === 'file') text = '[文件]';
        previewEl.textContent = `${msg.sender_name}: ${text}`.slice(0, 40);
    }
}

/* ── Sidebar toggle (mobile) ── */
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('hidden');
}

/* ── Members panel ── */
async function toggleMembers() {
    const panel = document.getElementById('membersPanel');
    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        return;
    }
    if (!currentChat || currentChat.type !== 'group') return;

    const res = await fetch(`/api/groups/${currentChat.id}/members`);
    const members = await res.json();

    let html = '';
    if (currentUser.role === 'admin') {
        html += `<div style="padding:8px 12px"><button class="btn-sm" onclick="showAddMember('${currentChat.id}')">+ 添加成员</button></div>`;
    }
    for (const m of members) {
        const initial = (m.display_name || '?').charAt(0);
        const avatarClass = m.is_agent ? 'member-avatar agent' : 'member-avatar';
        const dot = m.is_online ? '<span class="online-dot"></span>' : '';
        let tag = '';
        if (m.role === 'admin') tag = '<span class="member-tag admin">管理员</span>';
        else if (m.is_agent) tag = '<span class="member-tag agent">Agent</span>';

        html += `<div class="member-item">
            <div class="${avatarClass}">${initial}</div>
            <span class="member-name">${dot}${escHtml(m.display_name)}</span>
            ${tag}
        </div>`;
    }
    document.getElementById('membersList').innerHTML = html;
    panel.classList.remove('hidden');
}

/* ── Admin panel ── */
function showAdminPanel() {
    if (currentUser.role !== 'admin') { alert('需要管理员权限'); return; }
    document.getElementById('adminModal').classList.remove('hidden');
    document.getElementById('sidebarMenu').classList.add('hidden');
    loadAdminData();
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tabs button').forEach((b, i) => {
        b.classList.toggle('active', (tab === 'groups' ? i === 0 : i === 1));
    });
    document.getElementById('adminGroups').classList.toggle('hidden', tab !== 'groups');
    document.getElementById('adminAgents').classList.toggle('hidden', tab !== 'agents');
}

async function loadAdminData() {
    const [groups, agents] = await Promise.all([
        (await fetch('/api/groups')).json(),
        (await fetch('/api/agents')).json(),
    ]);

    let groupHtml = '';
    for (const g of groups) {
        groupHtml += `<div class="admin-group-item">
            <div class="group-info"><strong>${escHtml(g.name)}</strong></div>
            <button class="btn-sm" onclick="showAddMember('${g.id}')">添加成员</button>
        </div>`;
    }
    document.getElementById('adminGroupList').innerHTML = groupHtml || '<div style="color:#999;font-size:13px">暂无群组</div>';

    let agentHtml = '';
    for (const a of agents) {
        const statusDot = a.is_online ? '<span class="online-dot"></span>' : '';
        agentHtml += `<div class="admin-agent-item">
            <div class="agent-info">
                <div>${statusDot}<strong>${escHtml(a.display_name)}</strong> (${escHtml(a.username)})</div>
                <div class="token-display">Token: ${escHtml(a.agent_token)}</div>
            </div>
        </div>`;
    }
    document.getElementById('adminAgentList').innerHTML = agentHtml || '<div style="color:#999;font-size:13px">暂无 Agent</div>';
}

async function createGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    if (!name) return;
    const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (res.ok) {
        document.getElementById('newGroupName').value = '';
        loadAdminData();
        loadChats();
    } else {
        const data = await res.json();
        alert(data.error || '创建失败');
    }
}

async function createAgent() {
    const username = document.getElementById('newAgentUsername').value.trim();
    const displayName = document.getElementById('newAgentDisplayName').value.trim();
    if (!username) return;
    const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, display_name: displayName || username }),
    });
    if (res.ok) {
        document.getElementById('newAgentUsername').value = '';
        document.getElementById('newAgentDisplayName').value = '';
        const data = await res.json();
        alert(`Agent 创建成功！\nToken: ${data.agent_token}\n请妥善保存此 Token`);
        loadAdminData();
    } else {
        const d = await res.json();
        alert(d.error || '创建失败');
    }
}

async function showAddMember(groupId) {
    const users = await (await fetch('/api/users')).json();
    const members = await (await fetch(`/api/groups/${groupId}/members`)).json();
    const memberIds = new Set(members.map(m => m.id));

    let html = '';
    for (const u of users) {
        if (memberIds.has(u.id)) continue;
        const tag = u.is_agent ? ' <span class="member-tag agent">Agent</span>' : '';
        html += `<div class="add-user-item">
            <span>${escHtml(u.display_name)}${tag}</span>
            <button class="btn-sm" onclick="addMember('${groupId}','${u.id}',this)">添加</button>
        </div>`;
    }
    document.getElementById('addMemberUserList').innerHTML = html || '<div style="color:#999;font-size:13px;padding:12px">所有用户都已在群组中</div>';
    document.getElementById('addMemberModal').classList.remove('hidden');
}

async function addMember(groupId, userId, btn) {
    const res = await fetch(`/api/groups/${groupId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
    });
    if (res.ok) {
        btn.parentElement.remove();
        loadChats();
    }
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
}

/* ── Helpers ── */
function scrollToBottom() {
    const area = document.getElementById('messagesArea');
    requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; });
}

function formatTime(ts) {
    const d = new Date(ts * 1000);
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return time;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Start
init();
