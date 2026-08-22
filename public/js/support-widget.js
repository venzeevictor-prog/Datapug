// Floating support chat widget — embedded on the customer dashboard.
// Polling-based (every 4s while open, every 20s in the background for the unread dot)
// rather than websockets, to keep deployment simple (no sticky sessions needed).

(function () {
  let currentConversation = null;
  let pollInterval = null;
  let backgroundInterval = null;
  let lastMessageId = 0;

  const launcher = document.createElement('button');
  launcher.className = 'chat-launcher';
  launcher.innerHTML = '💬<span class="unread-dot"></span>';
  launcher.setAttribute('aria-label', 'Open support chat');

  const panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.innerHTML = `
    <div class="chat-header">
      <span class="title">Support</span>
      <button class="action-link" id="chat-close-btn" style="margin:0;">Close</button>
    </div>
    <div class="chat-messages" id="chat-messages"></div>
    <div class="chat-input-row">
      <input id="chat-input" type="text" placeholder="Type a message..." maxlength="2000">
      <button id="chat-send-btn">Send</button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const messagesEl = panel.querySelector('#chat-messages');
  const inputEl = panel.querySelector('#chat-input');
  const sendBtn = panel.querySelector('#chat-send-btn');

  function renderMessages(messages, myUserId) {
    messagesEl.innerHTML = messages.map((m) => {
      const mine = m.sender_id === myUserId;
      const time = new Date(m.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="chat-bubble ${mine ? 'mine' : 'theirs'}">
          ${escapeHtml(m.body)}
          <div class="meta">${mine ? 'You' : 'Support'} · ${time}</div>
        </div>
      `;
    }).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (messages.length) lastMessageId = messages[messages.length - 1].id;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function openPanel() {
    panel.classList.add('open');
    launcher.classList.remove('has-unread');
    localStorage.setItem('dataplug_chat_last_seen', new Date().toISOString());

    if (!currentConversation) {
      const mine = await API.get('/support/conversations/mine').catch(() => []);
      currentConversation = mine.find((c) => c.status === 'open') || mine[0] || null;
    }

    if (currentConversation) {
      const messages = await API.get(`/support/conversations/${currentConversation.id}/messages`).catch(() => []);
      const me = API.currentUser();
      renderMessages(messages, me?.id);
    } else {
      messagesEl.innerHTML = `<div style="text-align:center;color:var(--ink-soft);font-size:13px;margin-top:20px;">Send a message to start a conversation with our team.</div>`;
    }

    startPolling();
  }

  function closePanel() {
    panel.classList.remove('open');
    stopPolling();
  }

  function startPolling() {
    stopPolling();
    pollInterval = setInterval(async () => {
      if (!currentConversation) return;
      try {
        const messages = await API.get(`/support/conversations/${currentConversation.id}/messages`);
        const me = API.currentUser();
        renderMessages(messages, me?.id);
      } catch (err) { /* silent — transient poll failures shouldn't interrupt the user */ }
    }, 4000);
  }

  function stopPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      if (!currentConversation) {
        currentConversation = await API.post('/support/conversations', { message: text });
      } else {
        await API.post(`/support/conversations/${currentConversation.id}/messages`, { message: text });
      }
      inputEl.value = '';
      const messages = await API.get(`/support/conversations/${currentConversation.id}/messages`);
      const me = API.currentUser();
      renderMessages(messages, me?.id);
    } catch (err) {
      alert(err.message);
    } finally {
      sendBtn.disabled = false;
    }
  }

  launcher.addEventListener('click', () => {
    panel.classList.contains('open') ? closePanel() : openPanel();
  });
  panel.querySelector('#chat-close-btn').addEventListener('click', closePanel);
  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // Background check for unread messages so the dot appears even when the panel is closed.
  async function checkUnread() {
    if (panel.classList.contains('open')) return;
    try {
      const mine = await API.get('/support/conversations/mine');
      const lastSeen = localStorage.getItem('dataplug_chat_last_seen') || '1970-01-01';
      const hasUnread = mine.some((c) => new Date(c.last_message_at) > new Date(lastSeen));
      launcher.classList.toggle('has-unread', hasUnread);
    } catch (err) { /* silent */ }
  }
  checkUnread();
  backgroundInterval = setInterval(checkUnread, 20000);
})();
