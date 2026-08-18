export const CHAT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#091018">
  <title>LocalLLM Private Chat</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div class="ambient ambient-one" aria-hidden="true"></div>
  <div class="ambient ambient-two" aria-hidden="true"></div>

  <section id="login-view" class="login-shell" aria-labelledby="login-title">
    <div class="login-card">
      <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="eyebrow">Private compute · LazyEdge</p>
      <h1 id="login-title">Your quiet place to think.</h1>
      <p class="login-copy">Sign in to chat with the models running on your own GPU.</p>
      <form id="login-form" method="post" action="/chat/api/login" autocomplete="on">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="primary-button" type="submit">
          <span>Continue</span><span aria-hidden="true">→</span>
        </button>
        <p id="login-error" class="form-error" role="alert"></p>
      </form>
      <p class="privacy-note"><span aria-hidden="true">●</span> Credentials stay on this host. Your chats stay in this browser.</p>
    </div>
  </section>

  <div id="app-view" class="app-shell" hidden>
    <aside id="sidebar" class="sidebar" aria-label="Conversations">
      <div class="sidebar-head">
        <a class="wordmark" href="/" aria-label="LocalLLM home">
          <span class="brand-mark small" aria-hidden="true"><span></span><span></span><span></span></span>
          <span>LocalLLM</span>
        </a>
        <button id="close-sidebar" class="icon-button mobile-only" type="button" aria-label="Close conversations">×</button>
      </div>
      <button id="new-chat" class="new-chat" type="button"><span aria-hidden="true">＋</span> New chat</button>
      <nav id="conversation-list" class="conversation-list" aria-label="Saved conversations"></nav>
      <div class="sidebar-foot">
        <div class="private-badge"><span class="status-dot"></span><span>Private edge</span></div>
        <button id="logout" class="text-button" type="button">Sign out</button>
      </div>
    </aside>

    <div id="sidebar-scrim" class="sidebar-scrim" hidden></div>

    <main class="chat-shell">
      <header class="topbar">
        <button id="open-sidebar" class="icon-button mobile-only" type="button" aria-label="Open conversations">☰</button>
        <div class="model-control">
          <label for="model-select">Model</label>
          <select id="model-select" aria-label="Choose a model"></select>
        </div>
        <div class="topbar-meta">
          <span id="connection-state"><span class="status-dot"></span>Ready</span>
          <span id="signed-in-user"></span>
        </div>
      </header>

      <div id="chat-scroll" class="chat-scroll">
        <section id="welcome" class="welcome" aria-labelledby="welcome-title">
          <div class="welcome-orbit" aria-hidden="true"><span></span></div>
          <p class="eyebrow">Local intelligence</p>
          <h1 id="welcome-title">What are we exploring?</h1>
          <p>Ask, build, reason, or write with a model running on your private compute.</p>
          <div class="prompt-grid" aria-label="Prompt ideas">
            <button class="prompt-card" type="button" data-prompt="Help me think through a difficult decision step by step.">
              <span>Think clearly</span><small>Work through a decision</small>
            </button>
            <button class="prompt-card" type="button" data-prompt="Review this idea critically and identify the strongest next steps: ">
              <span>Shape an idea</span><small>Critique and improve</small>
            </button>
            <button class="prompt-card" type="button" data-prompt="Write a clean implementation plan for: ">
              <span>Plan a build</span><small>Turn intent into steps</small>
            </button>
          </div>
        </section>
        <section id="messages" class="messages" aria-label="Conversation" aria-live="polite"></section>
      </div>

      <footer class="composer-wrap">
        <form id="composer" class="composer">
          <label class="sr-only" for="message-input">Message LocalLLM</label>
          <textarea id="message-input" rows="1" maxlength="32000" placeholder="Message LocalLLM" required></textarea>
          <div class="composer-actions">
            <span class="composer-hint">Shift + Enter for a new line</span>
            <button id="stop-generation" class="stop-button" type="button" hidden aria-label="Stop generating">■</button>
            <button id="send-message" class="send-button" type="submit" aria-label="Send message">↑</button>
          </div>
        </form>
        <p class="footer-note">Private by design · Responses may be inaccurate</p>
      </footer>
    </main>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script src="/assets/app.js" defer></script>
</body>
</html>
`;

export const CHAT_CSS = `:root {
  --ink: #ecf5f5;
  --muted: #91a3a6;
  --muted-strong: #b7c6c7;
  --bg: #071016;
  --panel: rgba(11, 22, 29, 0.91);
  --panel-solid: #0b161d;
  --line: rgba(174, 225, 222, 0.12);
  --line-strong: rgba(174, 225, 222, 0.22);
  --accent: #72e0d1;
  --accent-strong: #a8f3e8;
  --accent-deep: #123e3d;
  --danger: #ff8e91;
  --shadow: 0 28px 90px rgba(0, 0, 0, 0.42);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--bg);
  font-synthesis: none;
}

* { box-sizing: border-box; }

html, body { min-height: 100%; }

body {
  margin: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 50% -20%, rgba(57, 129, 124, 0.18), transparent 42%),
    linear-gradient(160deg, #071016 0%, #09131a 48%, #071016 100%);
}

button, input, textarea, select { font: inherit; }
button { color: inherit; }
button, select { cursor: pointer; }
[hidden] { display: none !important; }

.ambient {
  position: fixed;
  width: 40vw;
  height: 40vw;
  min-width: 360px;
  min-height: 360px;
  border-radius: 50%;
  filter: blur(120px);
  pointer-events: none;
  opacity: .12;
}
.ambient-one { top: -20vw; right: -10vw; background: #54d5c3; }
.ambient-two { bottom: -28vw; left: -12vw; background: #2f7894; }

.login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px;
  position: relative;
  z-index: 1;
}

.login-card {
  width: min(100%, 460px);
  padding: clamp(30px, 6vw, 52px);
  border: 1px solid var(--line-strong);
  border-radius: 30px;
  background: linear-gradient(150deg, rgba(16, 31, 40, .96), rgba(8, 18, 24, .94));
  box-shadow: var(--shadow);
  backdrop-filter: blur(28px);
}

.brand-mark {
  width: 52px;
  height: 52px;
  display: flex;
  align-items: end;
  gap: 5px;
  padding: 13px;
  border: 1px solid rgba(114, 224, 209, .32);
  border-radius: 17px;
  background: linear-gradient(145deg, rgba(114, 224, 209, .16), rgba(114, 224, 209, .04));
  box-shadow: inset 0 1px rgba(255, 255, 255, .08);
}
.brand-mark span { width: 6px; border-radius: 8px; background: var(--accent); }
.brand-mark span:nth-child(1) { height: 14px; opacity: .58; }
.brand-mark span:nth-child(2) { height: 26px; }
.brand-mark span:nth-child(3) { height: 20px; opacity: .78; }
.brand-mark.small { width: 36px; height: 36px; padding: 8px; border-radius: 12px; gap: 3px; }
.brand-mark.small span { width: 4px; }
.brand-mark.small span:nth-child(1) { height: 9px; }
.brand-mark.small span:nth-child(2) { height: 17px; }
.brand-mark.small span:nth-child(3) { height: 13px; }

.eyebrow {
  margin: 28px 0 10px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 760;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.login-card h1, .welcome h1 {
  margin: 0;
  font-size: clamp(34px, 7vw, 54px);
  line-height: 1.04;
  letter-spacing: -.045em;
  font-weight: 630;
}
.login-copy { margin: 18px 0 32px; color: var(--muted); line-height: 1.65; }

label { color: var(--muted-strong); font-size: 13px; font-weight: 650; }
input {
  display: block;
  width: 100%;
  margin: 8px 0 18px;
  padding: 14px 15px;
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  outline: none;
  background: rgba(4, 11, 15, .54);
  transition: border-color .2s, box-shadow .2s, background .2s;
}
input:focus, textarea:focus, select:focus {
  border-color: rgba(114, 224, 209, .7);
  box-shadow: 0 0 0 3px rgba(114, 224, 209, .11);
}
.primary-button {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding: 15px 17px;
  border: 0;
  border-radius: 13px;
  color: #06201e;
  background: linear-gradient(135deg, var(--accent-strong), var(--accent));
  font-weight: 780;
  box-shadow: 0 12px 34px rgba(74, 202, 185, .18);
}
.primary-button:hover { filter: brightness(1.05); }
.primary-button:disabled { cursor: wait; filter: saturate(.4); opacity: .7; }
.form-error { min-height: 20px; margin: 12px 0 0; color: var(--danger); font-size: 13px; }
.privacy-note { margin: 26px 0 0; color: #6f8286; font-size: 12px; line-height: 1.5; }
.privacy-note span { margin-right: 7px; color: var(--accent); font-size: 9px; }

.app-shell { height: 100vh; display: grid; grid-template-columns: 276px minmax(0, 1fr); position: relative; z-index: 1; }
.sidebar {
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 18px 14px 14px;
  border-right: 1px solid var(--line);
  background: rgba(5, 13, 18, .82);
  backdrop-filter: blur(26px);
}
.sidebar-head { height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px; }
.wordmark { display: flex; align-items: center; gap: 11px; color: var(--ink); text-decoration: none; font-weight: 720; }
.new-chat {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin: 18px 0 16px;
  padding: 11px 13px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: rgba(114, 224, 209, .055);
  font-weight: 650;
  text-align: left;
}
.new-chat:hover { border-color: rgba(114, 224, 209, .42); background: rgba(114, 224, 209, .09); }
.conversation-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.conversation-item {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 30px;
  align-items: center;
  gap: 5px;
  margin: 3px 0;
  padding: 4px 5px 4px 12px;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: var(--muted);
}
.conversation-item:hover, .conversation-item.active { background: rgba(255, 255, 255, .045); color: var(--ink); }
.conversation-item.active { border-color: var(--line); }
.conversation-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: 13px; }
.delete-chat { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: #708286; opacity: 0; }
.conversation-item:hover .delete-chat, .conversation-item:focus-within .delete-chat { opacity: 1; }
.delete-chat:hover { color: var(--danger); background: rgba(255, 142, 145, .08); }
.sidebar-foot { display: flex; align-items: center; justify-content: space-between; padding: 12px 7px 2px; border-top: 1px solid var(--line); }
.private-badge, #connection-state { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.status-dot { width: 7px; height: 7px; display: inline-block; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px rgba(114, 224, 209, .65); }
.status-dot.inactive { background: #77888b; box-shadow: none; }
.text-button { padding: 6px; border: 0; background: transparent; color: var(--muted); font-size: 12px; }
.text-button:hover { color: var(--ink); }

.chat-shell { min-width: 0; height: 100vh; display: grid; grid-template-rows: 68px minmax(0, 1fr) auto; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 clamp(18px, 4vw, 42px);
  border-bottom: 1px solid var(--line);
  background: rgba(7, 16, 22, .7);
  backdrop-filter: blur(18px);
}
.model-control { display: flex; align-items: center; gap: 10px; }
.model-control label { color: #708286; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
select {
  max-width: min(42vw, 330px);
  padding: 8px 30px 8px 11px;
  border: 1px solid var(--line);
  border-radius: 10px;
  outline: none;
  color: var(--muted-strong);
  background: var(--panel-solid);
}
.topbar-meta { display: flex; align-items: center; gap: 18px; color: #708286; font-size: 12px; }
.chat-scroll { min-height: 0; overflow-y: auto; scroll-behavior: smooth; scrollbar-width: thin; }
.welcome { width: min(900px, calc(100% - 36px)); margin: clamp(56px, 10vh, 112px) auto 34px; text-align: center; }
.welcome .eyebrow { margin-top: 18px; }
.welcome > p:last-of-type { margin: 18px auto 0; max-width: 620px; color: var(--muted); line-height: 1.7; }
.welcome-orbit {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  margin: 0 auto;
  border: 1px solid rgba(114, 224, 209, .28);
  border-radius: 50%;
  box-shadow: 0 0 60px rgba(114, 224, 209, .12);
}
.welcome-orbit::before, .welcome-orbit span { content: ""; display: block; border-radius: 50%; }
.welcome-orbit::before { width: 28px; height: 28px; border: 1px solid rgba(114, 224, 209, .52); }
.welcome-orbit span { position: absolute; width: 8px; height: 8px; background: var(--accent); box-shadow: 0 0 14px var(--accent); }
.prompt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 40px; text-align: left; }
.prompt-card { padding: 18px; border: 1px solid var(--line); border-radius: 15px; background: rgba(13, 27, 35, .62); }
.prompt-card:hover { transform: translateY(-2px); border-color: rgba(114, 224, 209, .34); background: rgba(18, 38, 47, .78); }
.prompt-card span, .prompt-card small { display: block; }
.prompt-card span { font-weight: 650; }
.prompt-card small { margin-top: 6px; color: var(--muted); }

.messages { width: min(850px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 22px; }
.message { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 15px; padding: 18px 0; }
.message-avatar {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  color: var(--accent);
  background: rgba(114, 224, 209, .07);
  font-size: 12px;
  font-weight: 780;
}
.message.user .message-avatar { color: #d9e5e6; background: rgba(255, 255, 255, .06); }
.message-body { min-width: 0; padding-top: 5px; }
.message-label { margin-bottom: 8px; color: var(--muted); font-size: 11px; font-weight: 720; letter-spacing: .09em; text-transform: uppercase; }
.message-content { margin: 0; color: #dbe8e8; font: 400 15px/1.75 Inter, ui-sans-serif, system-ui, sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.streaming .message-content::after { content: ""; display: inline-block; width: 7px; height: 17px; margin-left: 4px; vertical-align: -3px; background: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: .18; } }

.composer-wrap { padding: 12px clamp(16px, 4vw, 40px) max(13px, env(safe-area-inset-bottom)); background: linear-gradient(transparent, rgba(7, 16, 22, .97) 23%); }
.composer { width: min(850px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 10px; margin: 0 auto; padding: 11px 11px 11px 17px; border: 1px solid var(--line-strong); border-radius: 19px; background: rgba(13, 27, 35, .96); box-shadow: 0 18px 50px rgba(0, 0, 0, .22); }
textarea { width: 100%; max-height: 180px; resize: none; overflow-y: auto; padding: 8px 0; border: 0; outline: 0; color: var(--ink); background: transparent; line-height: 1.55; }
textarea::placeholder { color: #6f8185; }
.composer-actions { display: flex; align-items: center; gap: 8px; }
.composer-hint { color: #617377; font-size: 10px; white-space: nowrap; }
.send-button, .stop-button, .icon-button { display: grid; place-items: center; border: 0; }
.send-button, .stop-button { width: 38px; height: 38px; border-radius: 12px; font-weight: 800; }
.send-button { color: #06201e; background: var(--accent); font-size: 19px; }
.send-button:disabled { cursor: not-allowed; opacity: .35; }
.stop-button { color: var(--ink); background: rgba(255, 255, 255, .09); font-size: 11px; }
.footer-note { margin: 8px auto 0; color: #5c6f73; font-size: 10px; text-align: center; }
.icon-button { width: 36px; height: 36px; border-radius: 10px; background: rgba(255, 255, 255, .05); font-size: 18px; }
.toast { position: fixed; left: 50%; bottom: 25px; z-index: 20; transform: translate(-50%, 20px); padding: 10px 14px; border: 1px solid var(--line-strong); border-radius: 10px; background: #12232b; box-shadow: var(--shadow); color: var(--muted-strong); font-size: 12px; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.toast.visible { opacity: 1; transform: translate(-50%, 0); }
.sidebar-scrim { position: fixed; inset: 0; z-index: 7; background: rgba(0, 0, 0, .48); }
.mobile-only { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 760px) {
  .app-shell { grid-template-columns: 1fr; }
  .mobile-only { display: grid; }
  .sidebar { position: fixed; inset: 0 auto 0 0; z-index: 8; width: min(86vw, 310px); transform: translateX(-102%); transition: transform .22s ease; box-shadow: var(--shadow); }
  .sidebar.open { transform: translateX(0); }
  .topbar { padding: 0 14px; }
  .topbar-meta #signed-in-user { display: none; }
  .model-control label { display: none; }
  select { max-width: 47vw; }
  .welcome { margin-top: 46px; }
  .prompt-grid { grid-template-columns: 1fr; margin-top: 28px; }
  .prompt-card { padding: 14px 16px; }
  .composer-hint { display: none; }
  .message { grid-template-columns: 31px minmax(0, 1fr); gap: 11px; }
  .message-avatar { width: 30px; height: 30px; border-radius: 9px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}
`;

export const CHAT_JS = `"use strict";

(function () {
  var storageKey = "lazyedge.private-chat.v1:" + window.location.host;
  var maxConversationCharacters = 128000;
  var maxPromptCharacters = 96000;
  var maxStoredCharacters = 1500000;
  var state = {
    csrf: "",
    username: "",
    models: [],
    model: "",
    conversations: [],
    activeId: "",
    controller: null
  };

  var elements = {
    loginView: document.getElementById("login-view"),
    appView: document.getElementById("app-view"),
    loginForm: document.getElementById("login-form"),
    loginError: document.getElementById("login-error"),
    username: document.getElementById("username"),
    password: document.getElementById("password"),
    model: document.getElementById("model-select"),
    connection: document.getElementById("connection-state"),
    signedInUser: document.getElementById("signed-in-user"),
    list: document.getElementById("conversation-list"),
    welcome: document.getElementById("welcome"),
    messages: document.getElementById("messages"),
    scroll: document.getElementById("chat-scroll"),
    composer: document.getElementById("composer"),
    input: document.getElementById("message-input"),
    send: document.getElementById("send-message"),
    stop: document.getElementById("stop-generation"),
    newChat: document.getElementById("new-chat"),
    logout: document.getElementById("logout"),
    sidebar: document.getElementById("sidebar"),
    scrim: document.getElementById("sidebar-scrim"),
    openSidebar: document.getElementById("open-sidebar"),
    closeSidebar: document.getElementById("close-sidebar"),
    toast: document.getElementById("toast")
  };

  function identifier() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function loadLocalState() {
    try {
      var parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (Array.isArray(parsed.conversations)) {
        state.conversations = parsed.conversations.map(normalizeConversation).filter(Boolean).slice(0, 40);
      }
      if (typeof parsed.activeId === "string") state.activeId = parsed.activeId;
      if (typeof parsed.model === "string") state.model = parsed.model;
      if (!state.conversations.some(function (item) { return item.id === state.activeId; })) {
        state.activeId = state.conversations[0] ? state.conversations[0].id : "";
      }
    } catch (_) {
      state.conversations = [];
    }
  }

  function recentMessageSuffix(messages, maximumCharacters, maximumMessages) {
    if (!Array.isArray(messages)) return [];
    var result = [];
    var total = 0;
    for (var index = messages.length - 1; index >= 0 && result.length < maximumMessages; index -= 1) {
      var message = messages[index];
      if (!message || (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" || message.content.length < 1 ||
        message.content.length > 32000) continue;
      if (total + message.content.length > maximumCharacters) break;
      total += message.content.length;
      result.unshift({ role: message.role, content: message.content });
    }
    return result;
  }

  function normalizeConversation(value) {
    if (!value || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 80 ||
      typeof value.title !== "string" || value.title.length < 1 || value.title.length > 80 ||
      !Array.isArray(value.messages)) return null;
    return {
      id: value.id,
      title: value.title,
      createdAt: typeof value.createdAt === "string" ? value.createdAt.slice(0, 64) : "",
      messages: recentMessageSuffix(value.messages, maxConversationCharacters, 64)
    };
  }

  function saveLocalState() {
    try {
      var evicted = false;
      var encoded = "";
      while (true) {
        encoded = JSON.stringify({
          conversations: state.conversations.slice(0, 40),
          activeId: state.activeId,
          model: state.model
        });
        if (encoded.length <= maxStoredCharacters) break;
        var removeIndex = -1;
        for (var index = state.conversations.length - 1; index >= 0; index -= 1) {
          if (state.conversations[index].id !== state.activeId) {
            removeIndex = index;
            break;
          }
        }
        if (removeIndex === -1) break;
        state.conversations.splice(removeIndex, 1);
        evicted = true;
      }
      localStorage.setItem(storageKey, encoded);
      if (evicted) showToast("Older browser conversations were removed to keep storage bounded");
    } catch (_) {
      showToast("Browser storage is unavailable");
    }
  }

  function activeConversation() {
    return state.conversations.find(function (conversation) {
      return conversation.id === state.activeId;
    }) || null;
  }

  function createConversation() {
    var conversation = {
      id: identifier(),
      title: "New conversation",
      createdAt: new Date().toISOString(),
      messages: []
    };
    state.conversations.unshift(conversation);
    if (state.conversations.length > 40) {
      state.conversations = state.conversations.slice(0, 40);
      showToast("The oldest browser conversation was removed");
    }
    state.activeId = conversation.id;
    saveLocalState();
    render();
    elements.input.focus();
    closeSidebar();
    return conversation;
  }

  function chooseConversation(id) {
    if (!state.conversations.some(function (item) { return item.id === id; })) return;
    state.activeId = id;
    saveLocalState();
    render();
    closeSidebar();
  }

  function removeConversation(id) {
    state.conversations = state.conversations.filter(function (item) { return item.id !== id; });
    if (state.activeId === id) state.activeId = state.conversations[0] ? state.conversations[0].id : "";
    saveLocalState();
    render();
  }

  function conversationButton(conversation) {
    var wrapper = document.createElement("div");
    wrapper.className = "conversation-item" + (conversation.id === state.activeId ? " active" : "");
    var choose = document.createElement("button");
    choose.className = "conversation-title text-button";
    choose.type = "button";
    choose.textContent = conversation.title;
    choose.setAttribute("aria-label", "Open " + conversation.title);
    choose.addEventListener("click", function () { chooseConversation(conversation.id); });
    var remove = document.createElement("button");
    remove.className = "delete-chat";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Delete " + conversation.title);
    remove.addEventListener("click", function () { removeConversation(conversation.id); });
    wrapper.appendChild(choose);
    wrapper.appendChild(remove);
    return wrapper;
  }

  function messageNode(message, streaming) {
    var article = document.createElement("article");
    article.className = "message " + message.role + (streaming ? " streaming" : "");
    var avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = message.role === "user" ? "You" : "AI";
    avatar.setAttribute("aria-hidden", "true");
    var body = document.createElement("div");
    body.className = "message-body";
    var label = document.createElement("div");
    label.className = "message-label";
    label.textContent = message.role === "user" ? "You" : "LocalLLM";
    var content = document.createElement("pre");
    content.className = "message-content";
    content.textContent = message.content || (streaming ? "Thinking" : "");
    body.appendChild(label);
    body.appendChild(content);
    article.appendChild(avatar);
    article.appendChild(body);
    return article;
  }

  function render() {
    elements.list.replaceChildren();
    state.conversations.forEach(function (conversation) {
      elements.list.appendChild(conversationButton(conversation));
    });
    elements.messages.replaceChildren();
    var conversation = activeConversation();
    var messages = conversation ? conversation.messages : [];
    elements.welcome.hidden = messages.length > 0;
    messages.forEach(function (message, index) {
      elements.messages.appendChild(messageNode(
        message,
        Boolean(state.controller && index === messages.length - 1 && message.role === "assistant")
      ));
    });
  }

  function scrollToEnd() {
    window.requestAnimationFrame(function () {
      elements.scroll.scrollTop = elements.scroll.scrollHeight;
    });
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      elements.toast.classList.remove("visible");
    }, 2400);
  }

  function setConnection(label, active) {
    elements.connection.replaceChildren();
    var dot = document.createElement("span");
    dot.className = "status-dot";
    if (!active) dot.classList.add("inactive");
    elements.connection.appendChild(dot);
    elements.connection.appendChild(document.createTextNode(label));
  }

  async function api(path, options) {
    var response = await fetch(path, Object.assign({ credentials: "same-origin" }, options || {}));
    if (response.status === 401 && path !== "/chat/api/login") showLogin();
    return response;
  }

  function showLogin() {
    if (state.controller) state.controller.abort();
    state.csrf = "";
    state.controller = null;
    elements.appView.hidden = true;
    elements.loginView.hidden = false;
    elements.password.value = "";
    elements.username.focus();
  }

  async function establishSession() {
    try {
      var response = await api("/chat/api/session");
      if (!response.ok) return showLogin();
      var session = await response.json();
      if (!session.authenticated) return showLogin();
      state.csrf = session.csrfToken;
      state.username = session.username;
      elements.signedInUser.textContent = session.username;
      elements.loginView.hidden = true;
      elements.appView.hidden = false;
      await loadModels();
      render();
      elements.input.focus();
    } catch (_) {
      elements.loginError.textContent = "The private chat service is unavailable.";
      showLogin();
    }
  }

  async function login(event) {
    event.preventDefault();
    elements.loginError.textContent = "";
    var button = elements.loginForm.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      var response = await api("/chat/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: elements.username.value, password: elements.password.value })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        elements.loginError.textContent = response.status === 401
          ? "The username or password is incorrect."
          : (response.status === 429
            ? "Too many attempts. Wait a moment and try again."
            : "The private chat service is unavailable.");
        return;
      }
      state.csrf = result.csrfToken;
      state.username = result.username;
      elements.signedInUser.textContent = result.username;
      elements.password.value = "";
      elements.loginView.hidden = true;
      elements.appView.hidden = false;
      await loadModels();
      render();
      elements.input.focus();
    } catch (_) {
      elements.loginError.textContent = "Unable to reach the private chat service.";
    } finally {
      button.disabled = false;
    }
  }

  async function logout() {
    if (state.controller) state.controller.abort();
    try {
      var response = await api("/chat/api/logout", {
        method: "POST",
        headers: { "x-lazyedge-csrf": state.csrf }
      });
      if (response.ok || response.status === 401) {
        showLogin();
        return;
      }
      showToast("Sign out failed. Your session is still active.");
    } catch (_) {
      showToast("Sign out failed. Check the connection and try again.");
    }
  }

  async function loadModels() {
    setConnection("Connecting", false);
    try {
      var response = await api("/chat/api/models");
      if (!response.ok) throw new Error("models unavailable");
      var body = await response.json();
      state.models = Array.isArray(body.models) ? body.models.filter(function (entry) {
        return entry && (entry.id === "deep" || entry.id === "fast" || entry.id === "code") &&
          typeof entry.label === "string";
      }) : [];
      elements.model.replaceChildren();
      state.models.forEach(function (model) {
        var option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.label;
        elements.model.appendChild(option);
      });
      if (state.models.some(function (entry) { return entry.id === state.model; })) {
        elements.model.value = state.model;
      } else {
        var preferred = state.models.find(function (entry) { return entry.default; });
        state.model = preferred ? preferred.id : (state.models[0] ? state.models[0].id : "");
        elements.model.value = state.model;
      }
      elements.send.disabled = state.models.length === 0;
      setConnection(state.models.length ? "Ready" : "No models", state.models.length > 0);
      saveLocalState();
    } catch (_) {
      elements.model.replaceChildren();
      elements.send.disabled = true;
      setConnection("Model service offline", false);
      showToast("Models are currently unavailable");
    }
  }

  function resizeComposer() {
    elements.input.style.height = "auto";
    elements.input.style.height = Math.min(elements.input.scrollHeight, 180) + "px";
  }

  function normalizedMessages(conversation) {
    return recentMessageSuffix(conversation.messages, maxPromptCharacters, 64).map(function (message) {
      return { role: message.role, content: message.content };
    });
  }

  function consumeEvent(block, assistant) {
    block.split("\\n").forEach(function (line) {
      if (line.slice(0, 5) !== "data:") return;
      var data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      try {
        var parsed = JSON.parse(data);
        var choice = parsed.choices && parsed.choices[0];
        var content = choice && choice.delta && choice.delta.content;
        if (typeof content === "string" && assistant.content.length < 32000) {
          assistant.content += content.slice(0, 32000 - assistant.content.length);
        }
      } catch (_) {
        return;
      }
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.controller || !state.model) return;
    var text = elements.input.value.trim();
    if (!text) return;
    var conversation = activeConversation() || createConversation();
    conversation.messages = conversation.messages.slice(-62);
    conversation.messages.push({ role: "user", content: text });
    if (conversation.messages.length === 1) {
      conversation.title = text.replace(/\\s+/g, " ").slice(0, 54) || "New conversation";
    }
    var assistant = { role: "assistant", content: "" };
    conversation.messages.push(assistant);
    elements.input.value = "";
    resizeComposer();
    var controller = new AbortController();
    state.controller = controller;
    elements.stop.hidden = false;
    elements.send.disabled = true;
    setConnection("Generating", true);
    saveLocalState();
    render();
    scrollToEnd();
    try {
      var response = await api("/chat/api/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lazyedge-csrf": state.csrf
        },
        body: JSON.stringify({ model: state.model, messages: normalizedMessages(conversation) }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error("request failed");
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      while (true) {
        var next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }).replace(/\\r\\n/g, "\\n");
        var boundary;
        while ((boundary = buffer.indexOf("\\n\\n")) !== -1) {
          consumeEvent(buffer.slice(0, boundary), assistant);
          buffer = buffer.slice(boundary + 2);
        }
        render();
        scrollToEnd();
      }
      if (buffer.trim()) consumeEvent(buffer, assistant);
      if (!assistant.content) assistant.content = "The model returned an empty response.";
    } catch (error) {
      if (error.name === "AbortError") {
        if (!assistant.content) assistant.content = "Generation stopped.";
      } else {
        if (!assistant.content) assistant.content = "I could not reach the model. Please try again.";
        showToast("The model request failed");
      }
    } finally {
      conversation.messages = recentMessageSuffix(
        conversation.messages,
        maxConversationCharacters,
        64
      );
      saveLocalState();
      if (state.controller !== controller) return;
      state.controller = null;
      elements.stop.hidden = true;
      elements.send.disabled = state.models.length === 0;
      setConnection(state.models.length ? "Ready" : "No models", state.models.length > 0);
      render();
      scrollToEnd();
    }
  }

  function openSidebar() {
    elements.sidebar.classList.add("open");
    elements.scrim.hidden = false;
  }

  function closeSidebar() {
    elements.sidebar.classList.remove("open");
    elements.scrim.hidden = true;
  }

  elements.loginForm.addEventListener("submit", login);
  elements.logout.addEventListener("click", logout);
  elements.newChat.addEventListener("click", createConversation);
  elements.composer.addEventListener("submit", sendMessage);
  elements.stop.addEventListener("click", function () {
    if (state.controller) state.controller.abort();
  });
  elements.model.addEventListener("change", function () {
    state.model = elements.model.value;
    saveLocalState();
  });
  elements.input.addEventListener("input", resizeComposer);
  elements.input.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });
  document.querySelectorAll("[data-prompt]").forEach(function (button) {
    button.addEventListener("click", function () {
      elements.input.value = button.getAttribute("data-prompt") || "";
      resizeComposer();
      elements.input.focus();
    });
  });
  elements.openSidebar.addEventListener("click", openSidebar);
  elements.closeSidebar.addEventListener("click", closeSidebar);
  elements.scrim.addEventListener("click", closeSidebar);

  loadLocalState();
  establishSession();
}());
`;
