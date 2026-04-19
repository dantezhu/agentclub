/* ── State ── */
let currentUser = null;
let socket = null;
let currentChat = null; // { type: 'group'|'direct', id, name }
let chats = { groups: [], directs: [] };
let oldestTimestamp = {};
let typingTimeout = null;
let heartbeatTimer = null;
let presencePollTimer = null;
let presencePollIntervalMs = 30_000;
let unreadCounts = {};
let lastMessages = {};
let pendingImages = []; // Files queued for preview before sending

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
    unreadCounts = await (await fetch('/api/unread-counts')).json();
    await loadChats();
    setupInputHandlers();

    // Only show admin link for admins
    const adminLink = document.getElementById('adminLink');
    if (adminLink && currentUser.role !== 'admin') adminLink.style.display = 'none';

    // On mobile, the sidebar is a hidden drawer and the empty-state view has
    // no menu button of its own — so open the drawer on first load when no
    // chat is selected, otherwise the user would face a dead-end screen.
    if (window.matchMedia('(max-width: 768px)').matches) {
        document.getElementById('sidebar').classList.add('open');
        syncMobileOverlay();
    }
}

/* ── Socket.IO ── */
function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('auth_ok', (data) => {
        console.log('Authenticated:', data);
        startHeartbeat(data.heartbeat_interval);
        startPresencePolling(data.presence_poll_interval);
    });

    socket.on('new_message', (msg) => {
        if (currentChat && msg.chat_type === currentChat.type && msg.chat_id === currentChat.id) {
            appendMessage(msg);
            scrollToBottom();
            socket.emit('mark_read', { chat_type: msg.chat_type, chat_id: msg.chat_id });
        }
        updateChatPreview(msg);
    });

    socket.on('unread_updated', async () => {
        unreadCounts = await (await fetch('/api/unread-counts')).json();
        renderChatList();
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

    socket.on('chat_list_updated', () => {
        loadChats();
    });

    socket.on('disconnect', () => {
        console.log('Disconnected');
    });
}

/* ── Heartbeat ── */
// Application-level heartbeat. The server records our `last_active_at`
// on every inbound signal (heartbeat, send_message, mark_read, ...) and
// derives online-ness from it vs `ACTIVE_TIMEOUT`. If we stop
// heartbeating (tab frozen, TCP silently dead) peers polling
// `/api/presence` will see us flip to offline without needing a clean
// disconnect. The interval comes from the server
// (`auth_ok.heartbeat_interval`) so a single Config change propagates
// to all clients on reconnect.
function startHeartbeat(intervalSeconds) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const sec = Number(intervalSeconds);
    const ms = (Number.isFinite(sec) && sec > 0 ? sec : 30) * 1000;
    heartbeatTimer = setInterval(() => {
        if (socket && socket.connected) socket.emit('heartbeat');
    }, ms);
}

/* ── Presence polling ──
 *
 * Online status is NOT pushed over Socket.IO anymore — the server only
 * records `last_active_at` and derives `is_online` from `ACTIVE_TIMEOUT`.
 * We poll `/api/presence` on a timer so the sidebar's green dots stay
 * fresh without relying on an explicit `disconnect` signal from peers
 * (browser close / network drop often fail to fire one).
 *
 * Scope: direct-chat peers only. Group member presence isn't surfaced in
 * real time — the members panel fetches a one-shot snapshot when opened.
 *
 * We suspend polling when the tab is hidden (the UI isn't visible anyway,
 * and the browser may throttle timers). On visibilitychange back to
 * visible, we refresh immediately so the user sees accurate state on return.
 */
function startPresencePolling(intervalSeconds) {
    const sec = Number(intervalSeconds);
    presencePollIntervalMs = (Number.isFinite(sec) && sec > 0 ? sec : 30) * 1000;
    schedulePresencePoll();
    refreshPresence();
}

function schedulePresencePoll() {
    if (presencePollTimer) clearInterval(presencePollTimer);
    presencePollTimer = setInterval(() => {
        if (document.hidden) return;
        refreshPresence();
    }, presencePollIntervalMs);
}

async function refreshPresence() {
    if (!chats.directs.length) return;
    try {
        const res = await fetch('/api/presence');
        if (!res.ok) return;
        const rows = await res.json();
        const byId = new Map(rows.map((r) => [r.user_id, r]));
        let changed = false;
        for (const d of chats.directs) {
            const row = byId.get(d.peer_id);
            const next = row ? !!row.is_online : false;
            const prev = !!d.peer_online;
            if (prev !== next) {
                d.peer_online = next ? 1 : 0;
                changed = true;
            }
        }
        if (changed) renderChatList();
    } catch {
        // Network blip — ignore; next tick will try again.
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshPresence();
});

/* ── Load Chats ── */
async function loadChats() {
    const [groupsRes, directsRes, lastMsgRes] = await Promise.all([
        fetch('/api/groups'),
        fetch('/api/direct-chats'),
        fetch('/api/last-messages'),
    ]);
    chats.groups = await groupsRes.json();
    chats.directs = await directsRes.json();
    lastMessages = await lastMsgRes.json();
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
            const isCreator = g.created_by === currentUser.id;
            const menuAction = isCreator
                ? `showChatMenu(event,'group','${g.id}','dissolve')`
                : `showChatMenu(event,'group','${g.id}','leave')`;
            const gUnread = unreadCounts[`group_${g.id}`] || 0;
            const gBadge = gUnread ? `<span class="badge">${gUnread > 99 ? '99+' : gUnread}</span>` : '';
            const gAvatarStyle = g.avatar ? '' : ` style="${AgentClubUI.avatarStyle(g.name)}"`;
            html += `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('group','${g.id}','${escHtml(g.name)}')" oncontextmenu="${menuAction}">
                <div class="avatar"${gAvatarStyle}>${g.avatar ? `<img src="${escHtml(g.avatar)}">` : initial}</div>
                <div class="chat-item-info">
                    <div class="name">${escHtml(g.name)}</div>
                    <div class="preview" id="preview_group_${g.id}">${escHtml(previewText(lastMessages['group_' + g.id]))}</div>
                </div>
                ${gBadge}
            </div>`;
        }
    }

    if (chats.directs.length) {
        html += '<div class="section-label">私聊</div>';
        for (const d of chats.directs) {
            const isActive = currentChat && currentChat.type === 'direct' && currentChat.id === d.id;
            const initial = (d.peer_name || '?').charAt(0);
            const dot = d.peer_online ? '<span class="online-dot"></span>' : '';
            const dUnread = unreadCounts[`direct_${d.id}`] || 0;
            const dBadge = dUnread ? `<span class="badge">${dUnread > 99 ? '99+' : dUnread}</span>` : '';
            const isAgent = !!d.peer_is_agent;
            const avatarClass = isAgent ? 'avatar agent' : 'avatar';
            const agentTag = isAgent ? ' <span class="chat-tag agent">Agent</span>' : '';
            const dAvatarStyle = d.peer_avatar ? '' : ` style="${AgentClubUI.avatarStyle(d.peer_name || d.id)}"`;
            html += `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('direct','${d.id}','${escHtml(d.peer_name)}',${isAgent})" oncontextmenu="showChatMenu(event,'direct','${d.id}','delete')">
                <div class="${avatarClass}"${dAvatarStyle}>${d.peer_avatar ? `<img src="${escHtml(d.peer_avatar)}">` : initial}</div>
                <div class="chat-item-info">
                    <div class="name">${dot}${escHtml(d.peer_name)}${agentTag}</div>
                    <div class="preview" id="preview_direct_${d.id}">${escHtml(previewText(lastMessages['direct_' + d.id]))}</div>
                </div>
                ${dBadge}
            </div>`;
        }
    }

    if (!chats.groups.length && !chats.directs.length) {
        html = '<div style="padding:20px;text-align:center;color:#999;font-size:13px;">还没有对话<br>点击右上角菜单创建</div>';
    }

    el.innerHTML = html;
}

/* ── Open Chat ── */
async function openChat(type, id, name, isAgent = false) {
    currentChat = { type, id, name, isAgent };
    invalidateMentionMembers();
    hideMentionPicker();
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('chatContainer').classList.remove('hidden');
    document.getElementById('membersPanel').classList.add('hidden');
    // On mobile, picking a chat from the sidebar drawer should close the
    // drawer so the chat view is visible.
    document.getElementById('sidebar').classList.remove('open');
    syncMobileOverlay();
    const titleAgentTag = (type === 'direct' && isAgent)
        ? '<span class="chat-tag agent">Agent</span>'
        : '';
    document.getElementById('chatTitle').innerHTML = escHtml(name) + titleAgentTag;
    document.getElementById('messageList').innerHTML = '';
    document.getElementById('loadMoreBtn').classList.add('hidden');
    delete oldestTimestamp[`${type}_${id}`];

    // Join room & clear unread
    socket.emit('join_chat', { chat_type: type, chat_id: id });
    delete unreadCounts[`${type}_${id}`];
    renderChatList();

    // Load history
    await loadMessages(type, id);
    scrollToBottomWhenReady();
    renderChatList();

    // Update header
    const avatarEl = document.getElementById('chatHeaderAvatar');
    if (type === 'group') {
        const [members, group] = await Promise.all([
            (await fetch(`/api/groups/${id}/members`)).json(),
            (await fetch(`/api/groups/${id}`)).json(),
        ]);
        document.getElementById('chatSubtitle').textContent = `${members.length} 名成员`;
        document.getElementById('chatMembersBtn').classList.remove('hidden');

        const initial = name.charAt(0);
        avatarEl.innerHTML = group.avatar ? `<img src="${escHtml(group.avatar)}">` : initial;
        avatarEl.style.background = group.avatar ? '' : AgentClubUI.avatarColor(name);
        avatarEl.classList.remove('hidden');
        // Header avatar is display-only now. Editing (name + avatar) lives
        // in the members panel's "群组设置" button → groupSettingsModal,
        // mirroring the profile-settings UX.
        avatarEl.classList.remove('editable');
        avatarEl.title = '';
        avatarEl.onclick = null;
    } else {
        // Subtitle for direct chats with agents shows the bot's
        // description (if any). We look it up from the in-memory chat
        // list rather than threading the value through openChat()'s
        // string-concat call site — keeps the onclick handler simple
        // and side-steps single-quote escaping.
        let subtitle = '';
        if (isAgent) {
            const peer = (chats.directs || []).find(c => c.id === id);
            subtitle = (peer && peer.peer_description) || '';
        }
        document.getElementById('chatSubtitle').textContent = subtitle;
        document.getElementById('chatMembersBtn').classList.add('hidden');
        avatarEl.classList.add('hidden');
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

function appendMessage(msg) {
    const list = document.getElementById('messageList');
    list.insertAdjacentHTML('beforeend', renderMessage(msg));
    list.querySelectorAll('pre code:not([data-highlighted])').forEach(el => hljs.highlightElement(el));

    // Images load asynchronously, so the initial scrollToBottom happens before
    // the image has a measurable height. Re-scroll once each image in the
    // newly-appended message finishes loading so the view stays pinned to the
    // bottom.
    const lastMessage = list.lastElementChild;
    if (lastMessage) {
        lastMessage.querySelectorAll('img').forEach(img => {
            if (img.complete && img.naturalHeight > 0) return;
            const rescroll = () => scrollToBottom();
            img.addEventListener('load', rescroll, { once: true });
            img.addEventListener('error', rescroll, { once: true });
        });
    }
}

/* ── Render Message ── */
function renderMessage(msg) {
    const isSelf = msg.sender_id === currentUser.id;
    const isAgent = msg.sender_is_agent;
    const initial = (msg.sender_name || '?').charAt(0);
    const avatarClass = isAgent ? 'msg-avatar agent' : 'msg-avatar';
    const avatarContent = msg.sender_avatar ? `<img src="${escHtml(msg.sender_avatar)}">` : initial;
    const avatarStyle = msg.sender_avatar
        ? ''
        : ` style="${AgentClubUI.avatarStyle(msg.sender_name || msg.sender_id)}"`;
    const nameClass = isAgent ? 'msg-sender agent-name' : 'msg-sender';
    const time = formatTime(msg.created_at);
    const content = renderContent(msg);

    return `<div class="message ${isSelf ? 'self' : ''}">
        <div class="${avatarClass}"${avatarStyle}>${avatarContent}</div>
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
            return `<div class="image-message"><img src="${escHtml(msg.file_url)}" alt="${escHtml(msg.file_name)}" onclick="openLightbox(this.src)" loading="lazy"></div>`;
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
    // Pull out `<at user_id="...">name</at>` tokens BEFORE Markdown parsing
    // (otherwise `marked` would try to interpret them as unknown HTML and
    // either drop them or escape them inconsistently). We replace each
    // match with a placeholder sentinel, parse Markdown, then splice the
    // styled mention pill back in via plain string replacement. Placeholders
    // are short random tokens so Markdown never rewrites them.
    const pills = [];
    const prepared = String(text || '').replace(
        /<at user_id="([^"]+)">([^<]*)<\/at>/g,
        (_, uid, rawName) => {
            const cls = uid === currentUser.id || uid === 'all'
                ? 'mention-tag mention-self'
                : 'mention-tag';
            // serializeInput XML-escapes `< > &` inside the name so malicious
            // display names can't forge a tag; reverse that here before
            // running through escHtml so the pill text renders correctly.
            const decoded = rawName
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            const labelName = (decoded && decoded.trim()) || (uid === 'all' ? '所有人' : uid);
            const label = uid === 'all' ? '所有人' : labelName;
            const pill = `<span class="${cls}" data-user-id="${escHtml(uid)}">@${escHtml(label)}</span>`;
            // Use Unicode Private-Use-Area delimiters so marked's parser
            // doesn't touch them (NUL and ASCII punctuation both risk being
            // rewritten, escaped, or interpreted as emphasis markers).
            const token = `\uE000MENTION${pills.length}\uE001`;
            pills.push(pill);
            return token;
        },
    );
    let html;
    try {
        html = marked.parse(prepared);
    } catch {
        html = escHtml(prepared);
    }
    return html.replace(/\uE000MENTION(\d+)\uE001/g, (_, i) => pills[Number(i)] || '');
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
    // Map common file extensions to a lucide file-type icon. Anything we
    // don't recognise falls back to the generic file outline.
    const iconMap = {
        pdf: 'file-text', doc: 'file-text', docx: 'file-text',
        xls: 'file-spreadsheet', xlsx: 'file-spreadsheet',
        ppt: 'file-text', pptx: 'file-text',
        zip: 'file-archive', tar: 'file-archive', gz: 'file-archive', '7z': 'file-archive', rar: 'file-archive',
        md: 'file-text', txt: 'file-text', json: 'file-text', csv: 'file-text',
    };
    const icon = AgentClubUI.iconHTML(iconMap[ext] || 'file');
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

/**
 * Serialize the contenteditable input to the wire format:
 *   - plain text nodes → literal text
 *   - <span class="mention-tag" data-user-id="..."> → <at user_id="...">name</at>
 *   - <br> / block boundaries → \n
 *
 * The returned `content` preserves the exact `<at user_id="...">name</at>`
 * token used by the agentclub/feishu mention protocol, and `mentions` is
 * the dedup'd array of user_ids (uuid or the literal "all") we saw.
 */
function serializeInput(root) {
    const mentions = [];
    const seen = new Set();
    let out = '';

    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.nodeValue;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName;
        if (tag === 'BR') {
            out += '\n';
            return;
        }
        if (node.classList && node.classList.contains('mention-tag')) {
            const uid = node.dataset.userId || '';
            const rawName = (node.textContent || '').replace(/^@/, '') || uid;
            // Escape `<`, `>`, `&` so a user whose display name contains
            // these characters can't forge a malformed `<at>` tag. `"` is
            // safe here because it only appears inside attribute values,
            // and user_id is backend-controlled (uuid or "all").
            const name = rawName
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            if (uid) {
                out += `<at user_id="${uid}">${name}</at>`;
                if (!seen.has(uid)) {
                    seen.add(uid);
                    mentions.push(uid);
                }
            } else {
                out += node.textContent || '';
            }
            return;
        }

        // Prepend a newline before each non-first block-level child so that
        // multi-paragraph pastes round-trip through send/render.
        const isBlock = tag === 'DIV' || tag === 'P';
        if (isBlock && out.length && !out.endsWith('\n')) {
            out += '\n';
        }
        for (const child of node.childNodes) walk(child);
    };

    for (const child of root.childNodes) walk(child);
    return { text: out.replace(/\n+$/, ''), mentions };
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    if (!currentChat) return;

    // Send pending images first
    if (pendingImages.length > 0) {
        sendPendingImages();
    }

    const { text, mentions } = serializeInput(input);
    if (!text.trim()) return;

    socket.emit('send_message', {
        chat_type: currentChat.type,
        chat_id: currentChat.id,
        content: text,
        content_type: 'text',
        mentions,
    });

    input.innerHTML = '';
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

/* ── Image handling ── */

function handleImageSelect(event) {
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length || !currentChat) return;
    addImagesToPending(files.filter(f => f.type.startsWith('image/')));
}

function addImagesToPending(files) {
    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const id = Math.random().toString(36).slice(2);
        const objectUrl = URL.createObjectURL(file);
        pendingImages.push({ id, file, objectUrl });
    }
    renderImagePreview();
}

function renderImagePreview() {
    const bar = document.getElementById('imagePreviewBar');
    const list = document.getElementById('imagePreviewList');
    if (!pendingImages.length) {
        bar.classList.add('hidden');
        list.innerHTML = '';
        return;
    }
    bar.classList.remove('hidden');
    list.innerHTML = pendingImages.map(img =>
        `<div class="image-preview-item" id="preview_${img.id}">
            <img src="${img.objectUrl}" alt="">
            <button class="image-preview-remove" onclick="removeImagePreview('${img.id}')" title="移除">${AgentClubUI.iconHTML('x')}</button>
        </div>`
    ).join('');
}

function removeImagePreview(id) {
    const idx = pendingImages.findIndex(img => img.id === id);
    if (idx >= 0) {
        URL.revokeObjectURL(pendingImages[idx].objectUrl);
        pendingImages.splice(idx, 1);
    }
    renderImagePreview();
}

function clearImagePreviews() {
    for (const img of pendingImages) {
        URL.revokeObjectURL(img.objectUrl);
    }
    pendingImages = [];
    renderImagePreview();
}

async function sendPendingImages() {
    const images = [...pendingImages];
    clearImagePreviews();
    for (const img of images) {
        await uploadAndSendImage(img.file);
    }
}

async function uploadAndSendImage(file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) { alert('图片上传失败'); return; }
        const data = await res.json();
        socket.emit('send_message', {
            chat_type: currentChat.type,
            chat_id: currentChat.id,
            content: '',
            content_type: data.content_type,
            file_url: data.url,
            file_name: data.filename,
        });
    } catch { alert('图片上传失败'); }
}

/* ── Lightbox ── */

function openLightbox(src) {
    const lb = document.getElementById('lightbox');
    const img = document.getElementById('lightboxImg');
    img.src = src;
    lb.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox(event) {
    if (event && event.target.id === 'lightboxImg') return;
    const lb = document.getElementById('lightbox');
    lb.classList.add('hidden');
    document.getElementById('lightboxImg').src = '';
    document.body.style.overflow = '';
}

/* ── Input handlers ── */

// Explicit composition tracking. The native `KeyboardEvent.isComposing` flag
// is unreliable in contenteditable divs — particularly right after inserting
// a `contenteditable=false` pill, Chromium can report `false` on the Enter
// that commits the first IME candidate, which would wrongly fire send()
// and/or collapse the composition back to English. Tracking our own flag
// via `compositionstart` / `compositionend` events is the standard fix.
let imeComposing = false;

function setupInputHandlers() {
    const input = document.getElementById('messageInput');

    input.addEventListener('compositionstart', () => { imeComposing = true; });
    input.addEventListener('compositionend', () => {
        // Defer reset so a keydown fired on the same tick (the Enter/Space
        // that committed the candidate) still sees `imeComposing=true`.
        setTimeout(() => { imeComposing = false; }, 0);
    });

    input.addEventListener('keydown', (e) => {
        // IME composition wins before anything else: Enter pressed while an
        // IME candidate is being selected confirms the candidate — it must
        // not trigger sendMessage() or pick a mention. We check three
        // signals because each browser/IME combination is flaky in its own
        // way: `imeComposing` (our own tracker), `e.isComposing` (native),
        // and `keyCode === 229` (Chromium's sentinel).
        if (imeComposing || e.isComposing || e.keyCode === 229) return;

        // Mention picker gets next crack — its arrow / enter / escape
        // handling only fires while it's visible.
        if (mentionPickerState.open && handleMentionPickerKey(e)) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    input.addEventListener('input', () => {
        maybeShowMentionPicker(input);
        if (currentChat) {
            socket.emit('typing', { chat_type: currentChat.type, chat_id: currentChat.id });
        }
    });

    // Caret-move keys can drop us out of the `@query` region, so re-check
    // the picker state on keyup. BUT: while the picker is open and we just
    // handled ArrowUp/Down inside the picker (to move the highlighted item),
    // we must NOT call `maybeShowMentionPicker` — it would immediately reset
    // `activeIdx` back to 0 and cancel the navigation.
    input.addEventListener('keyup', (e) => {
        if (mentionPickerState.open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            return;
        }
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            maybeShowMentionPicker(input);
        }
    });
    input.addEventListener('click', () => maybeShowMentionPicker(input));
    input.addEventListener('blur', () => {
        // Delay so a click on a picker item can still register.
        setTimeout(hideMentionPicker, 120);
    });

    // Strip rich formatting from pastes — we only want plain text and our
    // own mention pills. Browser-native paste into a contenteditable would
    // otherwise bring in fonts/colors/tables from the source page.
    input.addEventListener('paste', (e) => {
        // Image-paste path: unchanged.
        const items = e.clipboardData?.items;
        if (items) {
            const imageFiles = [];
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) imageFiles.push(file);
                }
            }
            if (imageFiles.length) {
                e.preventDefault();
                addImagesToPending(imageFiles);
                return;
            }
        }
        // Text paste: force plaintext.
        const txt = e.clipboardData?.getData('text/plain');
        if (txt != null) {
            e.preventDefault();
            insertPlainTextAtCaret(txt);
        }
    });

    // Drag & drop images
    const mainArea = document.getElementById('mainArea');
    let dragCounter = 0;

    mainArea.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (currentChat && hasImageFiles(e)) {
            document.getElementById('dropOverlay').classList.remove('hidden');
        }
    });

    mainArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            document.getElementById('dropOverlay').classList.add('hidden');
        }
    });

    mainArea.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    mainArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        document.getElementById('dropOverlay').classList.add('hidden');
        if (!currentChat) return;
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length) {
            addImagesToPending(files);
        }
    });

    // Close lightbox with Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeLightbox();
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

/* ── Mention picker ──
 *
 * Triggered when the caret is immediately to the right of an `@` that begins
 * a new word (start-of-line or after whitespace). We track the `@` position
 * in `mentionPickerState.triggerRange` so that committing a pick can splice
 * the placeholder text (`@que`) out and replace it with a styled pill.
 *
 * Only groups fetch a member list — direct chats get no picker because `@`
 * has no disambiguation value when there's exactly one peer.
 */
const mentionPickerState = {
    open: false,
    items: [],           // [{id, label, is_agent, is_all}]
    filtered: [],
    activeIdx: 0,
    triggerRange: null,  // Range covering the `@` char that opened the picker
    query: '',
    groupId: null,
    members: null,       // Cached members roster for current group
};

async function loadMentionMembers(groupId) {
    if (mentionPickerState.members && mentionPickerState.groupId === groupId) {
        return mentionPickerState.members;
    }
    try {
        const res = await fetch(`/api/groups/${groupId}/members`);
        if (!res.ok) return [];
        const members = await res.json();
        mentionPickerState.groupId = groupId;
        mentionPickerState.members = members;
        return members;
    } catch { return []; }
}

/** Invalidate the cached roster when the group or its membership changes. */
function invalidateMentionMembers() {
    mentionPickerState.members = null;
    mentionPickerState.groupId = null;
}

/**
 * Inspect the caret position and, if it sits in an unfinished `@query`
 * token, show the picker filtered by `query`. Otherwise hide it.
 *
 * The `@` qualifies as a trigger only when preceded by whitespace or
 * start-of-line so that mid-word `@` (emails, handles pasted as plain
 * text) doesn't erroneously open the picker.
 */
async function maybeShowMentionPicker(input) {
    if (!currentChat || currentChat.type !== 'group') {
        hideMentionPicker();
        return;
    }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
        hideMentionPicker();
        return;
    }
    const range = sel.getRangeAt(0);
    if (!input.contains(range.startContainer)) {
        hideMentionPicker();
        return;
    }
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
        hideMentionPicker();
        return;
    }
    const offset = range.startOffset;
    const before = node.nodeValue.slice(0, offset);
    // Match `@query` where `@` is at start-of-text or preceded by whitespace,
    // and `query` contains no whitespace. Query may be empty (just typed `@`).
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) {
        hideMentionPicker();
        return;
    }

    const query = m[2];
    // Index of the `@` character in the text node.
    const atOffset = offset - query.length - 1;
    const atRange = document.createRange();
    atRange.setStart(node, atOffset);
    atRange.setEnd(node, offset);

    const members = await loadMentionMembers(currentChat.id);
    const items = [
        { id: 'all', label: '所有人', is_agent: false, is_all: true },
        ...members
            .filter((u) => u.id !== currentUser.id)
            .map((u) => ({ id: u.id, label: u.display_name, is_agent: !!u.is_agent, is_all: false })),
    ];
    const q = query.toLowerCase();
    const filtered = q
        ? items.filter((it) => it.label.toLowerCase().includes(q))
        : items;

    if (!filtered.length) {
        hideMentionPicker();
        return;
    }

    mentionPickerState.open = true;
    mentionPickerState.items = items;
    mentionPickerState.filtered = filtered;
    mentionPickerState.activeIdx = 0;
    mentionPickerState.triggerRange = atRange;
    mentionPickerState.query = query;
    renderMentionPicker();
    positionMentionPicker(atRange);
}

function renderMentionPicker() {
    const el = document.getElementById('mentionPicker');
    const { filtered, activeIdx } = mentionPickerState;
    el.innerHTML = filtered.map((it, i) => {
        const avatarClass = it.is_all
            ? 'mention-picker-avatar all'
            : it.is_agent ? 'mention-picker-avatar agent' : 'mention-picker-avatar';
        const avatar = it.is_all ? '@' : escHtml(it.label.charAt(0));
        const avatarStyle = it.is_all
            ? ''
            : ` style="${AgentClubUI.avatarStyle(it.label || it.id)}"`;
        const tag = it.is_agent ? '<span class="member-tag agent">Agent</span>' : '';
        return `<div class="mention-picker-item ${i === activeIdx ? 'active' : ''}"
                     data-idx="${i}"
                     onmousedown="selectMentionPickerItem(${i}); return false;">
            <div class="${avatarClass}"${avatarStyle}>${avatar}</div>
            <span class="mention-picker-name">${escHtml(it.label)}</span>
            ${tag}
        </div>`;
    }).join('');
    el.classList.remove('hidden');
}

function positionMentionPicker(range) {
    const el = document.getElementById('mentionPicker');
    const rect = range.getBoundingClientRect();
    const inputArea = document.getElementById('inputArea');
    const areaRect = inputArea.getBoundingClientRect();
    // Anchor the picker above the caret, clamped to the input-area's width.
    const maxW = 280;
    let left = rect.left - areaRect.left;
    left = Math.max(8, Math.min(left, areaRect.width - maxW - 8));
    el.style.left = left + 'px';
    // Put it *above* the input row since there's no space below it. On
    // mobile with the soft keyboard open, `window.innerHeight` stays at the
    // pre-keyboard size on iOS Safari — use `visualViewport` when present
    // so the picker lands above the keyboard, not behind it.
    const vv = window.visualViewport;
    const viewportHeight = vv ? vv.height : window.innerHeight;
    const viewportOffsetTop = vv ? vv.offsetTop : 0;
    el.style.bottom = (viewportHeight + viewportOffsetTop - rect.top + 4) + 'px';
    el.style.top = 'auto';
}

function hideMentionPicker() {
    mentionPickerState.open = false;
    mentionPickerState.triggerRange = null;
    const el = document.getElementById('mentionPicker');
    if (el) el.classList.add('hidden');
}

function handleMentionPickerKey(e) {
    const { filtered } = mentionPickerState;
    if (!filtered.length) return false;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionPickerState.activeIdx = (mentionPickerState.activeIdx + 1) % filtered.length;
        renderMentionPicker();
        return true;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionPickerState.activeIdx = (mentionPickerState.activeIdx - 1 + filtered.length) % filtered.length;
        renderMentionPicker();
        return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMentionPickerItem(mentionPickerState.activeIdx);
        return true;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionPicker();
        return true;
    }
    return false;
}

/**
 * Replace the `@query` placeholder text with a styled mention pill, then
 * move the caret to just after the pill (with a single trailing space so
 * the user doesn't have to manually break out of the pill's inline style).
 */
function selectMentionPickerItem(idx) {
    const item = mentionPickerState.filtered[idx];
    const range = mentionPickerState.triggerRange;
    if (!item || !range) {
        hideMentionPicker();
        return;
    }
    const input = document.getElementById('messageInput');
    input.focus();

    range.deleteContents();

    const pill = document.createElement('span');
    pill.className = 'mention-tag';
    pill.dataset.userId = item.id;
    pill.contentEditable = 'false';
    pill.textContent = '@' + item.label;

    // Chromium has a long-standing bug where IME composition silently fails
    // to engage when the caret sits *adjacent* to a contenteditable=false
    // element (the span above). Symptom: user types pinyin, expects to
    // pick a Chinese character with Enter, but `compositionstart` never
    // fires, the raw pinyin letters land in the DOM as plain ASCII, and
    // our Enter handler then sends them as an English message. Firefox
    // doesn't have this bug.
    //
    // The robust workaround used by Slack/Discord/Lexical is to keep the
    // caret *inside* a plain text node — never at a node boundary next to
    // the pill. We achieve that with a trailing regular space (not NBSP;
    // NBSP further upsets some IMEs) and explicitly `setStart(space, 1)`
    // so the caret is at offset 1 *within* the text node, not between
    // nodes in the parent. `white-space: pre-wrap` on #messageInput keeps
    // the trailing space from collapsing.
    const space = document.createTextNode(' ');

    const frag = document.createDocumentFragment();
    frag.appendChild(pill);
    frag.appendChild(space);
    range.insertNode(frag);

    const newRange = document.createRange();
    newRange.setStart(space, space.length);
    newRange.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(newRange);

    hideMentionPicker();
}

/**
 * Insert a plain-text string at the current caret position (used by the
 * paste handler). Multi-line text is broken on `\n` boundaries with `<br>`
 * elements so the rendered layout matches the pasted shape.
 */
function insertPlainTextAtCaret(text) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();

    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    lines.forEach((line, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        if (line) frag.appendChild(document.createTextNode(line));
    });
    range.insertNode(frag);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

function hasImageFiles(e) {
    if (e.dataTransfer?.types?.includes('Files')) {
        const items = e.dataTransfer.items;
        if (items) {
            for (const item of items) {
                if (item.type.startsWith('image/')) return true;
            }
        }
        return true; // Can't determine type during dragenter in some browsers
    }
    return false;
}

/* ── Typing indicator ── */
function showTyping(name) {
    const el = document.getElementById('typingIndicator');
    el.textContent = `${name} 正在输入...`;
    el.classList.remove('hidden');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => el.classList.add('hidden'), 3000);
}

function updateChatPreview(msg) {
    const key = `${msg.chat_type}_${msg.chat_id}`;
    lastMessages[key] = { sender_name: msg.sender_name, content: msg.content, content_type: msg.content_type };
    const previewEl = document.getElementById(`preview_${key}`);
    if (previewEl) {
        previewEl.textContent = previewText(lastMessages[key]);
    }
}

/* ── Sidebar toggle (mobile) ── */
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('open');
    syncMobileOverlay();
}

/**
 * Show the dim backdrop whenever any mobile drawer is open (sidebar OR the
 * members panel). Click on the overlay closes whichever drawer is open.
 * This lets one shared `<div id="overlay">` serve both drawers and keeps
 * the backdrop state in sync with the UI.
 */
function syncMobileOverlay() {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    const overlay = document.getElementById('overlay');
    if (!isMobile) {
        overlay.classList.add('hidden');
        return;
    }
    const sidebarOpen = document.getElementById('sidebar').classList.contains('open');
    const membersOpen = !document.getElementById('membersPanel').classList.contains('hidden');
    if (sidebarOpen || membersOpen) overlay.classList.remove('hidden');
    else overlay.classList.add('hidden');
}

function handleOverlayClick() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
    }
    const panel = document.getElementById('membersPanel');
    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
    }
    syncMobileOverlay();
}

/* ── Members panel ── */
async function renderMembersPanel() {
    if (!currentChat || currentChat.type !== 'group') return;

    const [membersRes, groupRes] = await Promise.all([
        fetch(`/api/groups/${currentChat.id}/members`),
        fetch(`/api/groups/${currentChat.id}`),
    ]);
    const members = await membersRes.json();
    const group = await groupRes.json();
    const canManage = currentUser.role === 'admin' || group.created_by === currentUser.id;

    // Keep the chat header's "X 名成员" in sync. The subtitle was only
    // written once in selectChat(); without this line, add/remove member
    // would leave stale counts in the header until the user re-selects
    // the group.
    document.getElementById('chatSubtitle').textContent = `${members.length} 名成员`;

    let html = '';
    if (canManage) {
        html += `<div style="padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn-sm" onclick="showAddMember('${currentChat.id}')">+ 添加成员</button>
            <button class="btn-sm" onclick="openGroupSettings('${currentChat.id}')" title="修改群名称和头像">${AgentClubUI.iconHTML('settings')}群组设置</button>
        </div>`;
    }
    for (const m of members) {
        const initial = (m.display_name || '?').charAt(0);
        const avatarClass = m.is_agent ? 'member-avatar agent' : 'member-avatar';
        // Group member presence is intentionally not shown in real time —
        // the panel is a transient view and we don't poll for it. If you
        // need to know whether a specific peer is online right now, open
        // a direct chat with them (the sidebar does poll).
        let tag = '';
        if (m.role === 'admin') tag = '<span class="member-tag admin">管理员</span>';
        else if (m.is_agent) tag = '<span class="member-tag agent">Agent</span>';

        let removeBtn = '';
        if (canManage && m.id !== group.created_by) {
            removeBtn = `<button class="icon-btn" style="color:var(--color-danger)" onclick="removeMember('${currentChat.id}','${m.id}')" title="移除">${AgentClubUI.iconHTML('x')}</button>`;
        }

        const memberAvatarStyle = ` style="${AgentClubUI.avatarStyle(m.display_name || m.id)}"`;
        html += `<div class="member-item">
            <div class="${avatarClass}"${memberAvatarStyle}>${initial}</div>
            <span class="member-name">${escHtml(m.display_name)}</span>
            ${tag}${removeBtn}
        </div>`;
    }
    document.getElementById('membersList').innerHTML = html;
}

async function toggleMembers() {
    const panel = document.getElementById('membersPanel');
    if (!panel.classList.contains('hidden')) {
        panel.classList.add('hidden');
        syncMobileOverlay();
        return;
    }
    if (!currentChat || currentChat.type !== 'group') return;
    await renderMembersPanel();
    panel.classList.remove('hidden');
    syncMobileOverlay();
}

async function removeMember(groupId, userId) {
    if (!confirm('确定要移除该成员吗？')) return;
    const res = await fetch(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
    if (res.ok) {
        invalidateMentionMembers();
        await renderMembersPanel();
    } else {
        const data = await res.json();
        alert(data.error || '移除失败');
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
        html += `<div class="add-user-item" data-user-id="${u.id}">
            <span>${escHtml(u.display_name)}${tag}</span>
            <button class="btn-sm" onclick="addMember('${groupId}','${u.id}',this)">添加</button>
        </div>`;
    }
    document.getElementById('addMemberUserList').innerHTML = html || '<div style="color:#999;font-size:13px;padding:12px">所有用户都已在群组中</div>';
    document.getElementById('addMemberModal').classList.remove('hidden');
}

async function addMember(groupId, userId, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '添加中...';
    try {
        const res = await fetch(`/api/groups/${groupId}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            btn.disabled = false;
            btn.textContent = originalText;
            alert(data.error || '添加失败');
            return;
        }

        // Swap the button for a subtle "已添加" marker and strike the row.
        const row = btn.closest('.add-user-item');
        if (row) {
            row.style.opacity = '0.5';
            btn.replaceWith(Object.assign(document.createElement('span'), {
                textContent: '已添加',
                style: 'color:#52c41a;font-size:13px',
            }));
        }

        // Refresh both the right-hand members panel and the sidebar preview
        // (new member may change badge counts / last-message previews).
        invalidateMentionMembers();
        await Promise.all([renderMembersPanel(), loadChats()]);
    } catch (e) {
        btn.disabled = false;
        btn.textContent = originalText;
        alert('添加失败：' + e);
    }
}

function showProfileModal() {
    document.getElementById('sidebarMenu').classList.add('hidden');
    const avatar = document.getElementById('profileAvatar');
    if (currentUser.avatar) {
        avatar.innerHTML = `<img src="${escHtml(currentUser.avatar)}">`;
        avatar.style.background = '';
    } else {
        avatar.textContent = (currentUser.display_name || '?').charAt(0);
        avatar.style.background = AgentClubUI.avatarColor(currentUser.display_name || currentUser.username);
    }
    document.getElementById('profileDisplayName').value = currentUser.display_name || '';
    document.getElementById('profileModal').classList.remove('hidden');
}

async function uploadAvatar(event) {
    const file = event.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) { alert('上传失败'); return; }
    const data = await res.json();
    currentUser.avatar = data.url;
    const el = document.getElementById('profileAvatar');
    el.innerHTML = `<img src="${escHtml(data.url)}">`;
    el.style.background = '';
}

async function saveProfile() {
    const displayName = document.getElementById('profileDisplayName').value.trim();
    const res = await fetch('/api/me', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ display_name: displayName, avatar: currentUser.avatar || '' }),
    });
    if (res.ok) {
        currentUser = await res.json();
        closeModal('profileModal');
        loadChats();
    } else {
        alert('保存失败');
    }
}

/* ── Context menu for chat list ── */
function showChatMenu(event, chatType, chatId, action) {
    event.preventDefault();
    event.stopPropagation();
    const menu = document.getElementById('contextMenu');
    let html = '';
    if (chatType === 'group' && action === 'dissolve') {
        html = `<button class="danger" onclick="dissolveGroup('${chatId}')">解散群组</button>`;
    } else if (chatType === 'group' && action === 'leave') {
        html = `<button class="danger" onclick="leaveGroup('${chatId}')">退出群组</button>`;
    } else if (chatType === 'direct') {
        html = `<button class="danger" onclick="deleteDirectChat('${chatId}')">删除会话</button>`;
    }
    menu.innerHTML = html;
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
    menu.classList.remove('hidden');
}

document.addEventListener('click', () => {
    document.getElementById('contextMenu').classList.add('hidden');
});

async function dissolveGroup(groupId) {
    document.getElementById('contextMenu').classList.add('hidden');
    if (!confirm('确定要解散该群组吗？所有消息将被删除。')) return;
    const res = await fetch(`/api/groups/${groupId}`, { method: 'DELETE' });
    if (res.ok) {
        if (currentChat && currentChat.type === 'group' && currentChat.id === groupId) {
            currentChat = null;
            document.getElementById('chatContainer').classList.add('hidden');
            document.getElementById('emptyState').classList.remove('hidden');
        }
        loadChats();
    } else {
        const data = await res.json();
        alert(data.error || '解散失败');
    }
}

async function leaveGroup(groupId) {
    document.getElementById('contextMenu').classList.add('hidden');
    if (!confirm('确定要退出该群组吗？')) return;
    const res = await fetch(`/api/groups/${groupId}/leave`, { method: 'POST' });
    if (res.ok) {
        if (currentChat && currentChat.type === 'group' && currentChat.id === groupId) {
            currentChat = null;
            document.getElementById('chatContainer').classList.add('hidden');
            document.getElementById('emptyState').classList.remove('hidden');
        }
        loadChats();
    } else {
        const data = await res.json();
        alert(data.error || '退出失败');
    }
}

async function deleteDirectChat(chatId) {
    document.getElementById('contextMenu').classList.add('hidden');
    if (!confirm('确定要删除该会话吗？聊天记录将被清除。')) return;
    const res = await fetch(`/api/direct-chats/${chatId}`, { method: 'DELETE' });
    if (res.ok) {
        if (currentChat && currentChat.type === 'direct' && currentChat.id === chatId) {
            currentChat = null;
            document.getElementById('chatContainer').classList.add('hidden');
            document.getElementById('emptyState').classList.remove('hidden');
        }
        loadChats();
    } else {
        alert('删除失败');
    }
}

/* ── Group settings modal (rename group + change group avatar) ──
 * Mirrors the profile-settings flow: avatar upload only mutates a local
 * staged URL; nothing hits /api/groups until the user clicks Save, which
 * PUTs name+avatar in one go. The original "click header avatar to
 * upload" shortcut was removed in favour of this one entry point. */
let groupSettingsState = null; // { groupId, avatar }

function renderGroupSettingsAvatar() {
    const el = document.getElementById('groupSettingsAvatar');
    if (!groupSettingsState) return;
    if (groupSettingsState.avatar) {
        el.innerHTML = `<img src="${escHtml(groupSettingsState.avatar)}">`;
        el.style.background = '';
    } else {
        const fullName = (
            document.getElementById('groupSettingsName').value
            || groupSettingsState.name
            || '?'
        );
        el.textContent = fullName.charAt(0);
        el.style.background = AgentClubUI.avatarColor(fullName);
    }
}

async function openGroupSettings(groupId) {
    const res = await fetch(`/api/groups/${groupId}`);
    if (!res.ok) { alert('加载群组信息失败'); return; }
    const group = await res.json();
    groupSettingsState = {
        groupId,
        name: group.name || '',
        avatar: group.avatar || '',
    };
    document.getElementById('groupSettingsTitle').textContent = '群组设置';
    document.getElementById('groupSettingsSaveBtn').textContent = '保存';
    document.getElementById('groupSettingsName').value = group.name || '';
    renderGroupSettingsAvatar();
    document.getElementById('groupSettingsModal').classList.remove('hidden');
    // Defer focus until after the modal is painted so the input actually
    // gets it on Safari.
    setTimeout(() => document.getElementById('groupSettingsName').focus(), 0);
}

async function uploadGroupSettingsAvatar(event) {
    if (!groupSettingsState) return;
    const file = event.target.files[0];
    if (!file) return;
    // Reset the input so the same file can be picked twice in a row.
    event.target.value = '';
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || '上传失败');
        return;
    }
    const data = await res.json();
    groupSettingsState.avatar = data.url;
    renderGroupSettingsAvatar();
}

async function saveGroupSettings() {
    if (!groupSettingsState) return;
    const name = document.getElementById('groupSettingsName').value.trim();
    if (!name) { alert('群组名称不能为空'); return; }
    const isCreate = !groupSettingsState.groupId;
    const btn = document.getElementById('groupSettingsSaveBtn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = isCreate ? '创建中…' : '保存中…';
    try {
        const url = isCreate
            ? '/api/groups'
            : `/api/groups/${groupSettingsState.groupId}`;
        const method = isCreate ? 'POST' : 'PUT';
        const res = await fetch(url, {
            method,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name,
                avatar: groupSettingsState.avatar,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || (isCreate ? '创建失败' : '保存失败'));
            return;
        }
        const group = await res.json();
        if (isCreate) {
            // Brand-new group — close the modal, refresh the sidebar so
            // the new entry shows up, then jump straight into it.
            closeModal('groupSettingsModal');
            groupSettingsState = null;
            await loadChats();
            openChat('group', group.id, group.name);
            return;
        }
        // Edit path: refresh header (title + avatar) and the sidebar chat
        // list so the change is visible immediately. If the user is still
        // looking at this group, also refresh the title text shown in the
        // header.
        if (currentChat && currentChat.type === 'group' && currentChat.id === group.id) {
            currentChat.name = group.name;
            const titleEl = document.getElementById('chatTitle');
            if (titleEl) titleEl.textContent = group.name;
            const avatarEl = document.getElementById('chatHeaderAvatar');
            if (avatarEl) {
                avatarEl.innerHTML = group.avatar
                    ? `<img src="${escHtml(group.avatar)}">`
                    : (group.name || '?').charAt(0);
                avatarEl.style.background = group.avatar
                    ? '' : AgentClubUI.avatarColor(group.name);
            }
        }
        closeModal('groupSettingsModal');
        groupSettingsState = null;
        loadChats();
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function showCreateGroupModal() {
    // Close the sidebar "+" menu first so the modal isn't competing for
    // focus with a dropdown that's still open behind it.
    document.getElementById('sidebarMenu').classList.add('hidden');
    // Reuse groupSettingsModal with groupId=null → save handler treats
    // this as a POST (create) instead of PUT (edit). Same UX shape as
    // editing, just different endpoint.
    groupSettingsState = { groupId: null, name: '', avatar: '' };
    document.getElementById('groupSettingsTitle').textContent = '创建群组';
    document.getElementById('groupSettingsSaveBtn').textContent = '创建';
    document.getElementById('groupSettingsName').value = '';
    renderGroupSettingsAvatar();
    document.getElementById('groupSettingsModal').classList.remove('hidden');
    setTimeout(() => document.getElementById('groupSettingsName').focus(), 0);
}

async function showNewChatModal() {
    document.getElementById('sidebarMenu').classList.add('hidden');
    const users = await (await fetch('/api/users')).json();

    let html = '';
    for (const u of users) {
        if (u.id === currentUser.id) continue;
        // No online dot here: the "start new chat" picker is a transient
        // one-shot view, not something we poll. Once the chat is created
        // it shows up in the sidebar which DOES get presence updates.
        const tag = u.is_agent ? ' <span class="member-tag agent">Agent</span>' : '';
        html += `<div class="add-user-item">
            <span>${escHtml(u.display_name)}${tag}</span>
            <button class="btn-sm" onclick="startDirectChat('${u.id}','${escHtml(u.display_name)}',${!!u.is_agent})">聊天</button>
        </div>`;
    }
    document.getElementById('newChatUserList').innerHTML = html || '<div style="color:#999;font-size:13px;padding:12px">暂无其他用户</div>';
    document.getElementById('newChatModal').classList.remove('hidden');
}

async function startDirectChat(userId, userName, isAgent = false) {
    closeModal('newChatModal');
    const res = await fetch('/api/direct-chats', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({user_id: userId}),
    });
    if (!res.ok) { alert('创建对话失败'); return; }
    const chat = await res.json();
    await loadChats();
    openChat('direct', chat.id, userName, isAgent);
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

/**
 * Scroll to the bottom now AND re-scroll as any currently-pending images
 * finish loading. Called on chat open so that history containing images
 * still lands at the bottom after all images have laid out. Without this,
 * `scrollToBottom()` runs before images have measurable height, so the
 * final resting scroll position is several images short.
 */
function scrollToBottomWhenReady() {
    scrollToBottom();
    const list = document.getElementById('messageList');
    if (!list) return;
    list.querySelectorAll('img').forEach((img) => {
        if (img.complete && img.naturalHeight > 0) return;
        const rescroll = () => scrollToBottom();
        img.addEventListener('load', rescroll, { once: true });
        img.addEventListener('error', rescroll, { once: true });
    });
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

function previewText(msg) {
    if (!msg) return '';
    const typeMap = { image: '[图片]', audio: '[语音]', video: '[视频]', file: '[文件]' };
    let text = typeMap[msg.content_type];
    if (!text) {
        // Collapse `<at user_id="uid">name</at>` → `@name` for the sidebar
        // preview so mentions don't render as raw XML next to the chat name.
        const raw = (msg.content || '').replace(
            /<at user_id="(?:[^"]+)">([^<]*)<\/at>/g,
            (_, name) => {
                const decoded = name
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&amp;/g, '&');
                return `@${decoded || '所有人'}`;
            },
        );
        text = raw.replace(/\n/g, ' ').slice(0, 30);
    }
    return msg.sender_name ? `${msg.sender_name}: ${text}` : text;
}

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Start
init();
