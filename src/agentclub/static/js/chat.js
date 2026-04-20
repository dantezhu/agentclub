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
        let sidebarDirty = false;
        for (const d of chats.directs) {
            const row = byId.get(d.peer_id);
            const next = row ? !!row.is_online : false;
            const prev = !!d.peer_online;
            // Keep last_active_at in sync too — the chat header's
            // offline subtitle ("X 分钟前在线") reads from it, so if we
            // only updated is_online the header relative-time would
            // drift until the next openChat().
            if (row) d.peer_last_active_at = row.last_active_at;
            if (prev !== next) {
                d.peer_online = next ? 1 : 0;
                sidebarDirty = true;
            }
        }
        if (sidebarDirty) renderChatList();
        // Live-refresh the header subtitle when the currently open chat
        // is a direct chat — do it unconditionally (not only on change)
        // so the relative "X 分钟前在线" text ticks forward every poll
        // cycle without waiting for a state flip.
        if (currentChat && currentChat.type === 'direct') {
            const open = chats.directs.find(c => c.id === currentChat.id);
            if (open) {
                document.getElementById('chatSubtitle').innerHTML =
                    renderPresenceSubtitle(!!open.peer_online, open.peer_last_active_at);
            }
        }
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

// Order chats within one section by "activation time", newest first.
// Activation time = timestamp of the last message, or — for chats that
// haven't received any message yet (freshly created group, new direct
// chat) — the chat's own `created_at`. Both columns are unix seconds
// (REAL) on the server, so they compose into a single ordering without
// unit conversion. This keeps a just-created group near the top until
// it either gets a message (real activation) or gets pushed down by
// newer chats, instead of stranding it at the bottom.
function sortBySectionLastMsg(items, keyPrefix) {
    const withTime = items.map((it, i) => {
        const lastMsgTs = lastMessages[`${keyPrefix}_${it.id}`]?.created_at;
        return { it, i, ts: lastMsgTs ?? it.created_at ?? 0 };
    });
    withTime.sort((a, b) => (b.ts - a.ts) || (a.i - b.i));
    return withTime.map((e) => e.it);
}

function renderChatList() {
    const el = document.getElementById('chatList');
    let html = '';

    const sortedGroups = sortBySectionLastMsg(chats.groups, 'group');
    const sortedDirects = sortBySectionLastMsg(chats.directs, 'direct');

    if (sortedGroups.length) {
        html += '<div class="section-label">群组</div>';
        for (const g of sortedGroups) {
            const isActive = currentChat && currentChat.type === 'group' && currentChat.id === g.id;
            const initial = g.name.charAt(0);
            const gUnread = unreadCounts[`group_${g.id}`] || 0;
            const gBadge = gUnread ? `<span class="badge">${gUnread > 99 ? '99+' : gUnread}</span>` : '';
            const gAvatarStyle = g.avatar ? '' : ` style="${AgentClubUI.avatarStyle(g.name)}"`;
            // No right-click / long-press menu on sidebar rows — destructive
            // actions (退出群组 / 解散群组 / 群组设置) all live behind the
            // chat header's kebab (#chatActionsBtn, showChatActionsMenu) so
            // there is exactly one entry point that works on every device.
            html += `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('group','${g.id}','${escHtml(g.name)}')">
                <div class="avatar"${gAvatarStyle}>${g.avatar ? `<img src="${escHtml(g.avatar)}">` : initial}</div>
                <div class="chat-item-info">
                    <div class="name">${escHtml(g.name)}</div>
                    <div class="preview" id="preview_group_${g.id}">${escHtml(previewText(lastMessages['group_' + g.id]))}</div>
                </div>
                ${gBadge}
            </div>`;
        }
    }

    if (sortedDirects.length) {
        html += '<div class="section-label">私聊</div>';
        for (const d of sortedDirects) {
            const isActive = currentChat && currentChat.type === 'direct' && currentChat.id === d.id;
            const initial = (d.peer_name || '?').charAt(0);
            const dot = d.peer_online ? '<span class="online-dot"></span>' : '';
            const dUnread = unreadCounts[`direct_${d.id}`] || 0;
            const dBadge = dUnread ? `<span class="badge">${dUnread > 99 ? '99+' : dUnread}</span>` : '';
            const isAgent = !!d.peer_is_agent;
            const avatarClass = isAgent ? 'avatar agent' : 'avatar';
            const agentTag = isAgent ? ' <span class="chat-tag agent">Agent</span>' : '';
            const dAvatarStyle = d.peer_avatar ? '' : ` style="${AgentClubUI.avatarStyle(d.peer_name || d.id)}"`;
            // See note above on groups: no right-click on sidebar rows.
            // 删除会话 is reachable from the chat header kebab instead.
            html += `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('direct','${d.id}','${escHtml(d.peer_name)}',${isAgent})">
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
        document.getElementById('chatActionsBtn').classList.remove('hidden');
        // Stash creator so showChatActionsMenu() can decide between
        // creator items (群组设置 + 解散群组) and member items (退出群组)
        // without re-fetching /api/groups on every menu open.
        currentChat.created_by = group.created_by;

        const initial = name.charAt(0);
        avatarEl.innerHTML = group.avatar ? `<img src="${escHtml(group.avatar)}">` : initial;
        avatarEl.style.background = group.avatar ? '' : AgentClubUI.avatarColor(name);
        avatarEl.classList.remove('hidden');
        // Header avatar opens the read-only group-info modal — symmetric
        // to clicking a peer's avatar in a direct chat. Editing still
        // lives behind the members-panel "群组设置" button so we don't
        // overload this affordance with two different actions.
        avatarEl.classList.remove('editable');
        avatarEl.classList.add('clickable');
        avatarEl.title = '查看群组信息';
        avatarEl.onclick = () => openGroupInfoModal(id);
    } else {
        // Direct-chat header: surface peer avatar + presence. We read the
        // peer's online state from the sidebar's chats.directs cache
        // rather than re-fetching, so the header always agrees with the
        // sidebar's green dot (both are driven by the same
        // /api/presence polling loop in refreshPresence).
        //
        // Subtitle used to show the agent description for agent directs
        // and nothing for user directs — inconsistent and low-signal
        // (description already lives one tap away in the profile modal).
        // Now every direct chat, agent or human, shows presence here.
        const peer = (chats.directs || []).find(c => c.id === id);
        const peerAvatar = peer && peer.peer_avatar;
        const peerName = (peer && peer.peer_name) || name;
        const peerId = peer && peer.peer_id;
        const peerOnline = !!(peer && peer.peer_online);
        const peerLastActive = peer && peer.peer_last_active_at;
        document.getElementById('chatSubtitle').innerHTML = renderPresenceSubtitle(peerOnline, peerLastActive);
        document.getElementById('chatMembersBtn').classList.add('hidden');
        document.getElementById('chatActionsBtn').classList.remove('hidden');
        // Render the peer avatar in the same slot the group avatar uses
        // so the header layout stays consistent across chat types.
        // Click opens the profile modal — no edit affordance, the peer
        // isn't ours to rename.
        avatarEl.innerHTML = peerAvatar
            ? `<img src="${escHtml(peerAvatar)}">`
            : (peerName || '?').charAt(0);
        avatarEl.style.background = peerAvatar
            ? '' : AgentClubUI.avatarColor(peerName);
        avatarEl.classList.remove('hidden');
        avatarEl.classList.remove('editable');
        if (peerId) {
            avatarEl.classList.add('clickable');
            avatarEl.title = '查看个人信息';
            avatarEl.onclick = () => openProfileModal(peerId);
        } else {
            avatarEl.classList.remove('clickable');
            avatarEl.title = '';
            avatarEl.onclick = null;
        }
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
    }
    // Page size = 50; anything short means we hit the top of history.
    // The previous version only *showed* the button on a full page and
    // never hid it, so clicking "load more" when < 50 older messages
    // remained left the button stuck on screen forever.
    document.getElementById('loadMoreBtn').classList.toggle('hidden', messages.length < 50);

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

    // Images + videos lay out async. The initial scrollToBottom() in the
    // caller runs before either has real dimensions, so the pin would use
    // the element's placeholder height; once metadata loads the true size
    // pushes content down and the tail of the message gets clipped. Re-
    // scroll on each media element's load/metadata event to keep the view
    // pinned to bottom. Mirrors scrollToBottomWhenReady() which handles
    // the same issue on initial chat open.
    const lastMessage = list.lastElementChild;
    if (lastMessage) {
        const rescroll = () => scrollToBottom();
        lastMessage.querySelectorAll('img').forEach(img => {
            if (img.complete && img.naturalHeight > 0) return;
            img.addEventListener('load', rescroll, { once: true });
            img.addEventListener('error', rescroll, { once: true });
        });
        lastMessage.querySelectorAll('video').forEach(video => {
            // readyState ≥ 1 means metadata (including videoWidth/Height) is
            // already available and layout is final; no re-scroll needed.
            if (video.readyState >= 1 && video.videoHeight > 0) return;
            video.addEventListener('loadedmetadata', rescroll, { once: true });
            video.addEventListener('error', rescroll, { once: true });
        });
    }
}

/* ── Render Message ── */
function renderMessage(msg) {
    const isSelf = msg.sender_id === currentUser.id;
    const isAgent = msg.sender_is_agent;
    const initial = (msg.sender_name || '?').charAt(0);
    // Self avatars are not clickable: there's no point opening your own
    // profile from your own message (and the modal would hide its CTA
    // anyway). Peer avatars get .clickable for the hover ring + cursor.
    const avatarClass = `msg-avatar${isAgent ? ' agent' : ''}${isSelf ? '' : ' clickable'}`;
    const avatarContent = msg.sender_avatar ? `<img src="${escHtml(msg.sender_avatar)}">` : initial;
    const avatarStyle = msg.sender_avatar
        ? ''
        : ` style="${AgentClubUI.avatarStyle(msg.sender_name || msg.sender_id)}"`;
    const avatarOnclick = isSelf
        ? ''
        : ` onclick="openProfileModal('${msg.sender_id}')" title="查看个人信息"`;
    const nameClass = isAgent ? 'msg-sender agent-name' : 'msg-sender';
    const time = formatTime(msg.created_at);
    const content = renderContent(msg);

    return `<div class="message ${isSelf ? 'self' : ''}">
        <div class="${avatarClass}"${avatarStyle}${avatarOnclick}>${avatarContent}</div>
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
    await sendFiles([file]);
}

/* ── Image handling ──
 *
 * WeChat-style "pick and it's gone" UX: no preview bar, no confirm-to-send
 * step. Matches the behaviour of `handleFileSelect` for non-image files, so
 * the two attachment buttons feel the same to users. If we ever want a
 * Telegram-style preview + caption flow it should cover files too, not just
 * images — a half-baked preview that only applies to one mime class is
 * worse than no preview at all (users get confused by the inconsistency).
 */

async function handleImageSelect(event) {
    const files = Array.from(event.target.files).filter(f => f.type.startsWith('image/'));
    event.target.value = '';
    if (!files.length || !currentChat) return;
    await sendFiles(files);
}

/* Upload-and-send pipeline used by three entry points: drop, paste
 * image, and (image / file) toolbar button. The server inspects the
 * filename extension and returns the right content_type (image / audio
 * / video / file), so the caller doesn't need to know or care — we
 * just forward whatever came back in the send_message payload. Keeping
 * a single helper (instead of duplicated "image" / "file" variants)
 * means drag-drop and the paperclip button share the exact same code
 * path, which is what the user actually expects.
 *
 * Errors are intentionally opaque ("上传失败") — the set of things that
 * can fail here (too-big, wrong type, network, disk full on server)
 * isn't actionable per-file, and the toast spam we'd get from per-
 * item error messages when a multi-file drop fails is worse than the
 * generic string. */
async function sendFiles(files) {
    for (const file of files) {
        await uploadAndSendFile(file);
    }
}

async function uploadAndSendFile(file) {
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
                sendFiles(imageFiles);
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
        if (currentChat && hasDraggedFiles(e)) {
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
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
            sendFiles(files);
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

/* Gate for the drag-drop overlay: show it whenever the drag payload
 * contains any file(s). We intentionally do NOT narrow to images — the
 * drop handler forwards the full set to /api/upload, and the server's
 * allow-list decides what's accepted per-extension. Narrowing here
 * would just reintroduce the old "overlay said send, drop silently
 * ignored non-images" bug. */
function hasDraggedFiles(e) {
    return !!e.dataTransfer?.types?.includes('Files');
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
    const prevTs = lastMessages[key]?.created_at ?? null;
    // Keep `created_at` in the cache — the chat-list sort reads it, and
    // earlier revisions dropped it here, so a live app would keep chats
    // frozen in the order the initial `/api/last-messages` returned.
    lastMessages[key] = {
        sender_name: msg.sender_name,
        content: msg.content,
        content_type: msg.content_type,
        created_at: msg.created_at,
    };
    const previewEl = document.getElementById(`preview_${key}`);
    if (previewEl) {
        previewEl.textContent = previewText(lastMessages[key]);
    }
    // Only re-render when the order could actually change. An echo of
    // the chat that's already at the top of its section would do useless
    // work every keystroke. The cheap check: if this message is newer
    // than what we had, the position might move, so re-render.
    if (msg.created_at != null && (prevTs == null || msg.created_at > prevTs)) {
        renderChatList();
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

/* ── Members panel ──
 * _membersById caches the latest fetched member list keyed by user id
 * so the kebab handler (showMemberMenu) can look up display_name and
 * is_agent for the 发起私聊 action without inflating the onclick
 * string with escape-prone fields. Refreshed on every render. */
let _membersById = {};
async function renderMembersPanel() {
    if (!currentChat || currentChat.type !== 'group') return;

    const [membersRes, groupRes] = await Promise.all([
        fetch(`/api/groups/${currentChat.id}/members`),
        fetch(`/api/groups/${currentChat.id}`),
    ]);
    const members = await membersRes.json();
    const group = await groupRes.json();
    _membersById = Object.fromEntries(members.map(m => [m.id, m]));
    const canManage = currentUser.role === 'admin' || group.created_by === currentUser.id;

    // Keep the chat header's "X 名成员" in sync. The subtitle was only
    // written once in selectChat(); without this line, add/remove member
    // would leave stale counts in the header until the user re-selects
    // the group.
    document.getElementById('chatSubtitle').textContent = `${members.length} 名成员`;

    // Members-panel header only carries "添加成员" — it's the one action
    // that's about *the member list itself*. 群组设置 / 退出群组 / 解散
    // 群组 are about *the chat*, so they live in the chat header's kebab
    // (#chatActionsBtn) instead. Splitting by responsibility keeps each
    // surface uncluttered and gives every device a single tappable entry
    // point (we no longer bind context menus on sidebar rows).
    const headerActions = document.getElementById('membersHeaderActions');
    if (canManage) {
        headerActions.innerHTML = `
            <button class="icon-action" onclick="showAddMember('${currentChat.id}')" title="添加成员" aria-label="添加成员">${AgentClubUI.iconHTML('user-plus')}</button>
        `;
    } else {
        headerActions.innerHTML = '';
    }

    let html = '';
    for (const m of members) {
        const initial = (m.display_name || '?').charAt(0);
        // Avatar is clickable to open the profile modal — same affordance
        // as message author avatars and direct-chat header avatars.
        const avatarClass = `member-avatar${m.is_agent ? ' agent' : ''} clickable`;
        // Group member presence is intentionally not shown in real time —
        // the panel is a transient view and we don't poll for it. If you
        // need to know whether a specific peer is online right now, open
        // a direct chat with them (the sidebar does poll).
        let tag = '';
        if (m.role === 'admin') tag = '<span class="member-tag admin">管理员</span>';
        else if (m.is_agent) tag = '<span class="member-tag agent">Agent</span>';

        // Row actions live behind a kebab (⋯) instead of a bare X — the
        // kebab is a familiar "more actions" affordance (Slack/Linear/
        // Feishu all use it) and gives us room to add future operations
        // (mute, promote, …) without further visual clutter. The actual
        // dropdown is the existing #contextMenu element, populated on
        // click via showMemberMenu(). Every row gets a kebab — the
        // menu's contents (查看信息 always; 移除成员 only when
        // canManage and not the creator) are decided at click time so
        // we don't need separate code paths here.
        const canRemove = canManage && m.id !== group.created_by;
        const actionBtn = `<button class="icon-btn member-kebab" onclick="showMemberMenu(event,'${currentChat.id}','${m.id}',${canRemove})" title="更多" aria-label="更多操作">${AgentClubUI.iconHTML('more-horizontal')}</button>`;

        const memberAvatarStyle = ` style="${AgentClubUI.avatarStyle(m.display_name || m.id)}"`;
        html += `<div class="member-item">
            <div class="${avatarClass}"${memberAvatarStyle} onclick="openProfileModal('${m.id}')" title="查看个人信息">${initial}</div>
            <span class="member-name">${escHtml(m.display_name)}</span>
            ${tag}${actionBtn}
        </div>`;
    }
    document.getElementById('membersList').innerHTML = html;
}

/* Open the contextMenu dropdown anchored under a member's kebab button.
 * Reuses the same #contextMenu element used by the chat-header kebab
 * (showChatActionsMenu) so we don't duplicate styles or document-click
 * handlers.
 *
 * Items (rendered in this order, each gated):
 *   • 查看信息  → opens the read-only profile modal (always)
 *   • 发起私聊  → 1:1 chat with this member (hidden when row is self)
 *   • 移除成员  → destructive (only when canRemove)
 *
 * Display name / is_agent for 发起私聊 come from _membersById, which
 * renderMembersPanel populates — avoids escaping member names through
 * the onclick string. */
function showMemberMenu(event, groupId, userId, canRemove) {
    event.preventDefault();
    event.stopPropagation();
    const menu = document.getElementById('contextMenu');
    const isSelf = userId === currentUser.id;
    let html = `<button onclick="closeContextMenu();openProfileModal('${userId}')">查看信息</button>`;
    if (!isSelf) {
        html += `<button onclick="startDirectChatFromMember('${userId}')">发起私聊</button>`;
    }
    if (canRemove) {
        html += `<button class="danger" onclick="removeMember('${groupId}','${userId}')">移除成员</button>`;
    }
    menu.innerHTML = html;
    // Position right-aligned below the kebab so the dropdown opens
    // toward the panel's interior (members panel sits on the right edge,
    // a left-anchored menu would clip on narrow viewports).
    const rect = event.currentTarget.getBoundingClientRect();
    menu.classList.remove('hidden');
    // Force layout so we can read the dropdown width before positioning.
    const menuW = menu.offsetWidth || 140;
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.left = Math.max(8, rect.right - menuW) + 'px';
}

function closeContextMenu() {
    document.getElementById('contextMenu').classList.add('hidden');
}

/* Kebab → "发起私聊" handler. Resolves display_name / is_agent from
 * the cached members map so we can pre-populate the chat header
 * before /api/direct-chats responds; falls back to a placeholder if
 * the member somehow isn't in cache (defensive — shouldn't happen
 * because the kebab is rendered from that same list). If the user is
 * already in a 1:1 with this peer we just close the menu — clicking
 * 发起私聊 on yourself is hidden at render time. */
function startDirectChatFromMember(userId) {
    closeContextMenu();
    const m = _membersById[userId];
    const name = (m && m.display_name) || userId;
    const isAgent = !!(m && m.is_agent);
    startDirectChat(userId, name, isAgent);
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
    document.getElementById('contextMenu').classList.add('hidden');
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
            <button class="icon-action" onclick="addMember('${groupId}','${u.id}',this)" title="添加到群组" aria-label="添加到群组">${AgentClubUI.iconHTML('user-plus')}</button>
        </div>`;
    }
    document.getElementById('addMemberUserList').innerHTML = html || '<div style="color:#999;font-size:13px;padding:12px">所有用户都已在群组中</div>';
    document.getElementById('addMemberModal').classList.remove('hidden');
}

async function addMember(groupId, userId, btn) {
    // The trigger is now an icon button (.icon-action), so we can't
    // swap text any more. In-flight = disabled + half-opacity; on
    // failure we restore the original SVG markup.
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    try {
        const res = await fetch(`/api/groups/${groupId}/members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            btn.disabled = false;
            btn.style.opacity = '';
            btn.innerHTML = originalHTML;
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

/* Chat-header kebab → dropdown for the *currently open* chat. This is
 * the single entry point for destructive chat actions on every device
 * (desktop and mobile alike) — we deliberately don't bind right-click
 * / long-press menus on sidebar rows. Items are decided here at click
 * time based on currentChat:
 *
 *   direct                         → 删除会话
 *   group, regular member          → 退出群组
 *   group, creator (or admin)      → 群组设置 + 解散群组
 *
 * Reuses the same #contextMenu element used by the member kebab
 * dropdowns, so a single document-click handler dismisses both. */
function showChatActionsMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!currentChat) return;
    const menu = document.getElementById('contextMenu');
    let html = '';
    if (currentChat.type === 'direct') {
        html = `<button class="danger" onclick="deleteDirectChat('${currentChat.id}')">删除会话</button>`;
    } else if (currentChat.type === 'group') {
        const isCreator = currentChat.created_by === currentUser.id;
        const canManage = isCreator || currentUser.role === 'admin';
        if (canManage) {
            html += `<button onclick="closeContextMenu();openGroupSettings('${currentChat.id}')">群组设置</button>`;
        }
        if (isCreator) {
            html += `<button class="danger" onclick="dissolveGroup('${currentChat.id}')">解散群组</button>`;
        } else {
            html += `<button class="danger" onclick="leaveGroup('${currentChat.id}')">退出群组</button>`;
        }
    }
    menu.innerHTML = html;
    // Anchor the menu under the kebab button rather than at the raw tap
    // coordinates — the kebab sits in a fixed corner so this keeps the
    // dropdown predictable across taps. Right-edge alignment so it
    // doesn't overflow the viewport on mobile.
    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    menu.classList.remove('hidden');
    // Remove first then read offsetWidth — needs to be visible to measure.
    const menuWidth = menu.offsetWidth || 160;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    menu.style.left = left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
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
        description: group.description || '',
    };
    document.getElementById('groupSettingsTitle').textContent = '群组设置';
    document.getElementById('groupSettingsSaveBtn').textContent = '保存';
    document.getElementById('groupSettingsName').value = group.name || '';
    document.getElementById('groupSettingsDescription').value = group.description || '';
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
    const description = document.getElementById('groupSettingsDescription').value.trim();
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
                description,
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
    groupSettingsState = { groupId: null, name: '', avatar: '', description: '' };
    document.getElementById('groupSettingsTitle').textContent = '创建群组';
    document.getElementById('groupSettingsSaveBtn').textContent = '创建';
    document.getElementById('groupSettingsName').value = '';
    document.getElementById('groupSettingsDescription').value = '';
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
            <button class="icon-action" onclick="startDirectChat('${u.id}','${escHtml(u.display_name)}',${!!u.is_agent})" title="发起私聊" aria-label="发起私聊">${AgentClubUI.iconHTML('message-square')}</button>
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

/* ── Profile view modal ──
 * Opened from anywhere a peer's avatar is shown:
 *   • chat-header avatar in direct chats          (bindHeaderAvatarProfile)
 *   • message author avatar in any chat           (renderMessage onclick)
 *   • group members panel kebab → 查看信息       (showMemberMenu)
 * The "发起私聊" button is hidden when the viewer is looking at their
 * own profile (you can't 1:1-chat yourself). For agents the button is
 * still labelled 发起私聊 — same UX as the sidebar "+" picker. */
let _profileViewState = null; // { id, display_name, is_agent }

async function openProfileModal(userId) {
    if (!userId) return;
    let user;
    try {
        const res = await fetch(`/api/users/${userId}`);
        if (!res.ok) { alert('加载用户信息失败'); return; }
        user = await res.json();
    } catch (e) {
        alert('加载用户信息失败');
        return;
    }
    _profileViewState = user;

    // Avatar: same render rules as everywhere else (image if set,
    // hashed-color initial otherwise).
    const avatarEl = document.getElementById('profileViewAvatar');
    if (user.avatar) {
        avatarEl.innerHTML = `<img src="${escHtml(user.avatar)}">`;
        avatarEl.style.background = '';
    } else {
        const fullName = user.display_name || user.username || '?';
        avatarEl.textContent = fullName.charAt(0);
        avatarEl.style.background = AgentClubUI.avatarColor(fullName);
    }
    document.getElementById('profileViewName').textContent =
        user.display_name || user.username || '';
    document.getElementById('profileViewUsername').textContent =
        '@' + user.username;

    // Tags: role/agent + online pill. Order matters: identity tags
    // first, then status. Empty container hides itself via CSS.
    const tagsEl = document.getElementById('profileViewTags');
    let tagsHtml = '';
    if (user.role === 'admin') tagsHtml += '<span class="member-tag admin">管理员</span>';
    if (user.is_agent) tagsHtml += '<span class="member-tag agent">Agent</span>';
    if (user.is_online) {
        tagsHtml += '<span class="online-pill">在线</span>';
    } else {
        // Offline: reuse the same cascading relative-time label used in
        // the chat header subtitle (刚刚在线 / X分钟前在线 / 最近在线：…).
        // Presented as a neutral "last-seen" pill so it sits naturally
        // next to the admin/agent tags.
        const lastSeen = formatLastActive(user.last_active_at);
        if (lastSeen) {
            tagsHtml += `<span class="last-seen-pill">${escHtml(lastSeen)}</span>`;
        }
    }
    tagsEl.innerHTML = tagsHtml;

    document.getElementById('profileViewDesc').textContent = user.description || '';

    // Hide the "start chat" CTA when viewing self — clicking it would
    // hit /api/direct-chats with own user_id which the backend would
    // (rightly) reject.
    const chatBtn = document.getElementById('profileViewChatBtn');
    if (user.id === currentUser.id) {
        chatBtn.classList.add('hidden');
    } else {
        chatBtn.classList.remove('hidden');
    }

    document.getElementById('profileViewModal').classList.remove('hidden');
}

/* Open the read-only group-info modal for a given group id. Mirrors
 * openProfileModal()'s shape (fetch → populate → show) so the two
 * info cards stay symmetric. The endpoint returns the group row plus
 * member_count and created_by_name — see _group_with_meta() in
 * routes.py. */
async function openGroupInfoModal(groupId) {
    if (!groupId) return;
    let group;
    try {
        const res = await fetch(`/api/groups/${groupId}`);
        if (!res.ok) { alert('加载群组信息失败'); return; }
        group = await res.json();
    } catch (e) {
        alert('加载群组信息失败');
        return;
    }
    const name = group.name || '';
    const avatarEl = document.getElementById('groupInfoAvatar');
    if (group.avatar) {
        avatarEl.innerHTML = `<img src="${escHtml(group.avatar)}">`;
        avatarEl.style.background = '';
    } else {
        avatarEl.textContent = (name || '?').charAt(0);
        avatarEl.style.background = AgentClubUI.avatarColor(name || group.id);
    }
    document.getElementById('groupInfoName').textContent = name;

    // Single "群组" tag — keeps visual parity with the profile card,
    // which has role/agent/online tags. We deliberately don't surface
    // member_count here; it has its own meta row below.
    document.getElementById('groupInfoTags').innerHTML =
        '<span class="member-tag agent">群组</span>';

    document.getElementById('groupInfoDesc').textContent = group.description || '';

    // Meta as a single horizontal "·"-separated line (creator · member
    // count · created time). Reads like a card subtitle rather than a
    // settings table; only items with data are included. Wraps on
    // narrow screens via flex-wrap in CSS.
    const metaEl = document.getElementById('groupInfoMeta');
    const items = [];
    if (group.created_by_name) {
        items.push(`创建者 <strong>${escHtml(group.created_by_name)}</strong>`);
    }
    if (typeof group.member_count === 'number') {
        items.push(`<strong>${group.member_count}</strong> 名成员`);
    }
    if (group.created_at) {
        items.push(`创建于 ${escHtml(formatDateTime(group.created_at))}`);
    }
    metaEl.innerHTML = items
        .map(s => `<span>${s}</span>`)
        .join('<span class="meta-sep">·</span>');

    document.getElementById('groupInfoModal').classList.remove('hidden');
}

async function startChatFromProfile() {
    if (!_profileViewState) return;
    const u = _profileViewState;
    closeModal('profileViewModal');
    // If we're already inside a direct chat with this peer, no need
    // to reopen — startDirectChat() is idempotent on the server but
    // the openChat() jump would still be redundant noise.
    if (currentChat && currentChat.type === 'direct') {
        const peer = (chats.directs || []).find(c => c.id === currentChat.id);
        if (peer && peer.peer_id === u.id) {
            _profileViewState = null;
            return;
        }
    }
    await startDirectChat(u.id, u.display_name || u.username, !!u.is_agent);
    _profileViewState = null;
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
 * Scroll to the bottom now AND re-scroll as any currently-pending media
 * finish laying out. Called on chat open so that history containing
 * images, videos, etc. still lands at the bottom after all media have
 * measurable dimensions. Without this the initial `scrollToBottom()`
 * runs against a list whose media boxes are still 0-height, so the
 * final resting position is several items short of the real end.
 *
 * Three element types are tracked:
 *   - <img>: `load`/`error` — dimensions known after decode.
 *   - <video preload="metadata">: `loadedmetadata`/`error` — dimensions
 *     known once the container/codec header is parsed. Earlier revisions
 *     only handled <img>, which is why chats with videos would "sometimes"
 *     fail to pin to the bottom.
 *   - <audio>/<file card>: fixed CSS size, no async layout shift, so
 *     intentionally not tracked.
 */
function scrollToBottomWhenReady() {
    scrollToBottom();
    const list = document.getElementById('messageList');
    if (!list) return;
    const rescroll = () => scrollToBottom();
    list.querySelectorAll('img').forEach((img) => {
        if (img.complete && img.naturalHeight > 0) return;
        img.addEventListener('load', rescroll, { once: true });
        img.addEventListener('error', rescroll, { once: true });
    });
    list.querySelectorAll('video').forEach((video) => {
        // readyState >= 1 (HAVE_METADATA) means dimensions are already
        // known, nothing to wait for on this element.
        if (video.readyState >= 1 && video.videoHeight > 0) return;
        video.addEventListener('loadedmetadata', rescroll, { once: true });
        video.addEventListener('error', rescroll, { once: true });
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

/* Absolute date-time used by info cards (group info, future user info)
 * where "yesterday 14:30"-style relative formats are confusing — the
 * caller wants to know exactly when. Always YYYY-MM-DD HH:MM, no
 * locale-dependent slashes. Kept separate from formatTime() because
 * message timestamps still want the relative collapse. */
function formatDateTime(ts) {
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
         + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* Format a "last active" timestamp for the offline-state subtitle.
 * Rules (flat, relative up to a week then switches to an absolute
 * prefix so the reader doesn't need to do "what day is 20 天前?" math):
 *
 *   < 1 min     → "刚刚在线"
 *   1–59 min    → "X分钟前在线"
 *   1–23 h      → "X小时前在线"
 *   1–6 days    → "X天前在线"
 *   ≥ 7 days    → "最近在线：YYYY年M月D日 HH:mm"
 *
 * Returns "离线" when ts is missing/zero (agent that has never
 * connected, or a user whose last_active_at was never recorded).
 *
 * Intentionally separate from formatTime() — that one is for message
 * timestamps (chronological scanning); this one is for presence (quick
 * social read of "how recently was this person around?"). */
function formatLastActive(ts) {
    if (!ts) return '离线';
    const now = Math.floor(Date.now() / 1000);
    const diffSec = Math.max(0, now - ts);
    if (diffSec < 60) return '刚刚在线';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前在线`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前在线`;
    if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)}天前在线`;
    const d = new Date(ts * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `最近在线：${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 `
         + `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* HTML fragment for the direct-chat header subtitle. Online → green
 * pill matching the profile modal's badge style; offline → plain gray
 * text with a relative last-active timestamp. Returning HTML (rather
 * than plain text) lets the caller feed it straight into the
 * #chatSubtitle span's innerHTML without an extra DOM dance.
 *
 * NOT used in the sidebar — that view keeps its compact "dot before
 * name" convention and has no room for prose. */
function renderPresenceSubtitle(isOnline, lastActiveAt) {
    if (isOnline) return '<span class="online-pill">在线</span>';
    return escHtml(formatLastActive(lastActiveAt));
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
