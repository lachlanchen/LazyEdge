export { CHAT_MARKDOWN_JS } from "./chat-markdown.js";
export {
  CHAT_ASSET_VERSION,
  CHAT_ICON_192,
  CHAT_ICON_512,
  CHAT_MANIFEST,
  CHAT_SERVICE_WORKER,
} from "./chat-pwa.js";

export const CHAT_HTML = `<!doctype html>
<html lang="en" data-theme="bright">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta id="theme-color" name="theme-color" content="#f7faf9">
  <meta name="application-name" content="LocalLLM">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="LocalLLM">
  <title>LocalLLM Private Chat</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png">
  <link rel="apple-touch-icon" href="/assets/icon-192.png">
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <div class="ambient ambient-one" aria-hidden="true"></div>
  <div class="ambient ambient-two" aria-hidden="true"></div>

  <section id="login-view" class="login-shell" aria-labelledby="login-title">
    <div class="login-tools">
      <button class="quiet-button install-app" type="button" hidden>Install app</button>
      <label class="compact-field">Theme
        <select class="theme-select" aria-label="Color theme">
          <option value="bright">Bright</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
      </label>
    </div>
    <div class="login-card">
      <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <p class="eyebrow">Private compute · LazyEdge</p>
      <h1 id="login-title">Your quiet place to think.</h1>
      <p class="login-copy">Sign in to chat with the models running on your own GPU.</p>
      <form id="login-form" method="post" action="/chat/api/login" autocomplete="on">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <label class="remember-row" for="remember-session">
          <input id="remember-session" name="remember" type="checkbox" value="yes" checked>
          <span><strong>Keep me signed in</strong><small>Your browser password manager can securely remember the password.</small></span>
        </label>
        <button class="primary-button" type="submit">
          <span>Continue</span><span aria-hidden="true">→</span>
        </button>
        <p id="login-error" class="form-error" role="alert"></p>
      </form>
      <p class="privacy-note"><span aria-hidden="true">●</span> Credentials stay in the edge session or your browser password manager. Chats stay in this browser.</p>
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
        <div class="topbar-actions">
          <button class="quiet-button install-app" type="button" hidden>Install</button>
          <label class="compact-field theme-field">Theme
            <select class="theme-select" aria-label="Color theme">
              <option value="bright">Bright</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </label>
          <div class="topbar-meta">
            <span id="connection-state"><span class="status-dot"></span>Ready</span>
            <span id="signed-in-user"></span>
          </div>
        </div>
      </header>

      <div id="update-banner" class="update-banner" role="status" hidden>
        <span>A fresh LocalLLM app is ready.</span>
        <button id="apply-update" class="quiet-button" type="button">Update safely</button>
      </div>

      <div id="chat-scroll" class="chat-scroll">
        <section id="welcome" class="welcome" aria-labelledby="welcome-title">
          <div class="welcome-orbit" aria-hidden="true"><span></span></div>
          <p class="eyebrow">Local intelligence</p>
          <h1 id="welcome-title">What are we exploring?</h1>
          <p>Ask, build, reason, write, or work through equations with a model running on your private compute.</p>
          <div class="prompt-grid" aria-label="Prompt ideas">
            <button class="prompt-card" type="button" data-prompt="Help me think through a difficult decision step by step.">
              <span>Think clearly</span><small>Work through a decision</small>
            </button>
            <button class="prompt-card" type="button" data-prompt="Explain and solve this using Markdown and clear mathematical notation: ">
              <span>Explore mathematics</span><small>Render steps and equations</small>
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
            <button id="stop-generation" class="stop-button" type="button" hidden aria-label="Stop generating"><span aria-hidden="true">■</span><span>Stop</span></button>
            <button id="send-message" class="send-button" type="submit" aria-label="Send message">↑</button>
          </div>
        </form>
        <p class="footer-note">Private by design · Markdown and math supported · Responses may be inaccurate</p>
      </footer>
    </main>
  </div>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/assets/markdown.js"></script>
  <script src="/assets/app.js" defer></script>
</body>
</html>
`;

export const CHAT_CSS = `:root {
  --ink: #172326;
  --muted: #627174;
  --muted-strong: #405154;
  --bg: #f4f7f6;
  --bg-raised: #ffffff;
  --panel: rgba(255, 255, 255, 0.91);
  --panel-solid: #ffffff;
  --sidebar: rgba(246, 249, 248, 0.94);
  --line: rgba(27, 72, 72, 0.11);
  --line-strong: rgba(27, 72, 72, 0.2);
  --accent: #147d75;
  --accent-strong: #0d625c;
  --accent-soft: #dff3ef;
  --accent-contrast: #ffffff;
  --danger: #b7404b;
  --danger-soft: #fff0f1;
  --shadow: 0 26px 80px rgba(34, 66, 65, 0.14);
  --code-bg: #eef3f2;
  --user-bg: #e9f6f3;
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--bg);
  font-synthesis: none;
}

:root[data-theme="dark"] {
  --ink: #ecf5f5;
  --muted: #91a3a6;
  --muted-strong: #b7c6c7;
  --bg: #071016;
  --bg-raised: #0d1b23;
  --panel: rgba(11, 22, 29, 0.92);
  --panel-solid: #0b161d;
  --sidebar: rgba(5, 13, 18, 0.88);
  --line: rgba(174, 225, 222, 0.12);
  --line-strong: rgba(174, 225, 222, 0.22);
  --accent: #72e0d1;
  --accent-strong: #a8f3e8;
  --accent-soft: #123e3d;
  --accent-contrast: #06201e;
  --danger: #ff8e91;
  --danger-soft: rgba(255, 142, 145, 0.08);
  --shadow: 0 28px 90px rgba(0, 0, 0, 0.42);
  --code-bg: #071218;
  --user-bg: rgba(114, 224, 209, 0.065);
  color-scheme: dark;
}

@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    --ink: #ecf5f5;
    --muted: #91a3a6;
    --muted-strong: #b7c6c7;
    --bg: #071016;
    --bg-raised: #0d1b23;
    --panel: rgba(11, 22, 29, 0.92);
    --panel-solid: #0b161d;
    --sidebar: rgba(5, 13, 18, 0.88);
    --line: rgba(174, 225, 222, 0.12);
    --line-strong: rgba(174, 225, 222, 0.22);
    --accent: #72e0d1;
    --accent-strong: #a8f3e8;
    --accent-soft: #123e3d;
    --accent-contrast: #06201e;
    --danger: #ff8e91;
    --danger-soft: rgba(255, 142, 145, 0.08);
    --shadow: 0 28px 90px rgba(0, 0, 0, 0.42);
    --code-bg: #071218;
    --user-bg: rgba(114, 224, 209, 0.065);
    color-scheme: dark;
  }
}

* { box-sizing: border-box; }
html, body { min-height: 100%; }
body {
  margin: 0;
  overflow: hidden;
  color: var(--ink);
  background:
    radial-gradient(circle at 50% -20%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 42%),
    linear-gradient(160deg, var(--bg) 0%, color-mix(in srgb, var(--bg) 94%, var(--accent) 6%) 48%, var(--bg) 100%);
}
button, input, textarea, select { font: inherit; }
button { color: inherit; }
button, select { cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, a:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 34%, transparent);
  outline-offset: 2px;
}
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
  opacity: .1;
}
.ambient-one { top: -20vw; right: -10vw; background: var(--accent); }
.ambient-two { bottom: -28vw; left: -12vw; background: #4c8db7; }

.login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 76px 28px 28px;
  position: relative;
  z-index: 1;
}
.login-tools { position: fixed; top: 18px; right: 20px; z-index: 3; display: flex; align-items: center; gap: 9px; }
.login-card {
  width: min(100%, 470px);
  padding: clamp(30px, 6vw, 52px);
  border: 1px solid var(--line-strong);
  border-radius: 30px;
  background: linear-gradient(150deg, var(--panel), color-mix(in srgb, var(--panel-solid) 88%, var(--accent-soft) 12%));
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
  border: 1px solid color-mix(in srgb, var(--accent) 36%, transparent);
  border-radius: 17px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent) 4%, transparent));
  box-shadow: inset 0 1px rgba(255, 255, 255, .2);
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
.eyebrow { margin: 28px 0 10px; color: var(--accent); font-size: 12px; font-weight: 760; letter-spacing: .16em; text-transform: uppercase; }
.login-card h1, .welcome h1 { margin: 0; font-size: clamp(34px, 7vw, 54px); line-height: 1.04; letter-spacing: -.045em; font-weight: 640; }
.login-copy { margin: 18px 0 32px; color: var(--muted); line-height: 1.65; }
label { color: var(--muted-strong); font-size: 13px; font-weight: 650; }
input[type="text"], input[type="password"] {
  display: block;
  width: 100%;
  margin: 8px 0 18px;
  padding: 14px 15px;
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  outline: none;
  background: color-mix(in srgb, var(--panel-solid) 88%, var(--bg) 12%);
  transition: border-color .2s, box-shadow .2s, background .2s;
}
input:focus, textarea:focus, select:focus { border-color: color-mix(in srgb, var(--accent) 72%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent); }
.remember-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; gap: 10px; margin: 2px 0 20px; cursor: pointer; }
.remember-row input { width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--accent); }
.remember-row strong, .remember-row small { display: block; }
.remember-row strong { color: var(--ink); font-size: 13px; }
.remember-row small { margin-top: 3px; color: var(--muted); font-size: 11px; font-weight: 450; line-height: 1.4; }
.primary-button { width: 100%; display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding: 15px 17px; border: 0; border-radius: 13px; color: var(--accent-contrast); background: linear-gradient(135deg, var(--accent-strong), var(--accent)); font-weight: 780; box-shadow: 0 12px 34px color-mix(in srgb, var(--accent) 21%, transparent); }
.primary-button:hover { filter: brightness(1.05); }
.primary-button:disabled { cursor: wait; filter: saturate(.4); opacity: .7; }
.form-error { min-height: 20px; margin: 12px 0 0; color: var(--danger); font-size: 13px; }
.privacy-note { margin: 26px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.privacy-note span { margin-right: 7px; color: var(--accent); font-size: 9px; }

.app-shell { height: 100vh; display: grid; grid-template-columns: 276px minmax(0, 1fr); position: relative; z-index: 1; }
.sidebar { height: 100vh; display: flex; flex-direction: column; padding: 18px 14px 14px; border-right: 1px solid var(--line); background: var(--sidebar); backdrop-filter: blur(26px); }
.sidebar-head { height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 6px; }
.wordmark { display: flex; align-items: center; gap: 11px; color: var(--ink); text-decoration: none; font-weight: 720; }
.new-chat { display: flex; align-items: center; gap: 10px; width: 100%; margin: 18px 0 16px; padding: 11px 13px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--accent-soft); font-weight: 650; text-align: left; }
.new-chat:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); filter: brightness(.99); }
.conversation-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.conversation-item { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 30px; align-items: center; gap: 5px; margin: 3px 0; padding: 4px 5px 4px 12px; border: 1px solid transparent; border-radius: 11px; background: transparent; color: var(--muted); }
.conversation-item:hover, .conversation-item.active { background: color-mix(in srgb, var(--accent-soft) 65%, transparent); color: var(--ink); }
.conversation-item.active { border-color: var(--line); }
.conversation-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; font-size: 13px; }
.delete-chat { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); opacity: 0; }
.conversation-item:hover .delete-chat, .conversation-item:focus-within .delete-chat { opacity: 1; }
.delete-chat:hover { color: var(--danger); background: var(--danger-soft); }
.sidebar-foot { display: flex; align-items: center; justify-content: space-between; padding: 12px 7px 2px; border-top: 1px solid var(--line); }
.private-badge, #connection-state { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.status-dot { width: 7px; height: 7px; display: inline-block; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 65%, transparent); }
.status-dot.inactive { background: var(--muted); box-shadow: none; }
.text-button { padding: 6px; border: 0; background: transparent; color: var(--muted); font-size: 12px; }
.text-button:hover { color: var(--ink); }

.chat-shell { min-width: 0; height: 100vh; display: grid; grid-template-rows: 68px auto minmax(0, 1fr) auto; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 clamp(18px, 4vw, 42px); border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 84%, transparent); backdrop-filter: blur(18px); }
.model-control { display: flex; align-items: center; gap: 10px; }
.model-control label, .compact-field { color: var(--muted); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
select { max-width: min(42vw, 330px); padding: 8px 30px 8px 11px; border: 1px solid var(--line); border-radius: 10px; outline: none; color: var(--muted-strong); background: var(--panel-solid); }
.compact-field { display: flex; align-items: center; gap: 7px; }
.compact-field select { max-width: 115px; padding: 7px 25px 7px 9px; font-size: 12px; letter-spacing: normal; text-transform: none; }
.topbar-actions, .topbar-meta { display: flex; align-items: center; gap: 13px; }
.topbar-meta { color: var(--muted); font-size: 12px; }
.quiet-button { padding: 7px 10px; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--panel-solid); color: var(--muted-strong); font-size: 12px; }
.quiet-button:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--ink); }
.update-banner { display: flex; align-items: center; justify-content: center; gap: 14px; min-height: 43px; padding: 7px 16px; border-bottom: 1px solid var(--line); background: var(--accent-soft); color: var(--muted-strong); font-size: 12px; }
.chat-scroll { min-height: 0; overflow-y: auto; scroll-behavior: smooth; scrollbar-width: thin; }
.welcome { width: min(900px, calc(100% - 36px)); margin: clamp(56px, 10vh, 112px) auto 34px; text-align: center; }
.welcome .eyebrow { margin-top: 18px; }
.welcome > p:last-of-type { margin: 18px auto 0; max-width: 650px; color: var(--muted); line-height: 1.7; }
.welcome-orbit { width: 58px; height: 58px; display: grid; place-items: center; margin: 0 auto; border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); border-radius: 50%; box-shadow: 0 0 60px color-mix(in srgb, var(--accent) 12%, transparent); }
.welcome-orbit::before, .welcome-orbit span { content: ""; display: block; border-radius: 50%; }
.welcome-orbit::before { width: 28px; height: 28px; border: 1px solid color-mix(in srgb, var(--accent) 52%, transparent); }
.welcome-orbit span { position: absolute; width: 8px; height: 8px; background: var(--accent); box-shadow: 0 0 14px var(--accent); }
.prompt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 40px; text-align: left; }
.prompt-card { padding: 18px; border: 1px solid var(--line); border-radius: 15px; background: color-mix(in srgb, var(--panel) 82%, transparent); box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 5%, transparent); transition: transform .18s, border-color .18s; }
.prompt-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.prompt-card span, .prompt-card small { display: block; }
.prompt-card span { font-weight: 650; }
.prompt-card small { margin-top: 6px; color: var(--muted); }

.messages { width: min(850px, calc(100% - 32px)); margin: 0 auto; padding: 34px 0 22px; }
.message { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 15px; padding: 20px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 65%, transparent); }
.message:last-child { border-bottom: 0; }
.message-avatar { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid var(--line-strong); border-radius: 11px; color: var(--accent); background: var(--accent-soft); font-size: 12px; font-weight: 780; }
.message.user .message-avatar { color: var(--muted-strong); background: var(--panel-solid); }
.message-body { min-width: 0; padding-top: 5px; }
.message-label { margin-bottom: 8px; color: var(--muted); font-size: 11px; font-weight: 720; letter-spacing: .09em; text-transform: uppercase; }
.message-content { min-width: 0; color: var(--ink); font: 400 15px/1.72 Inter, ui-sans-serif, system-ui, sans-serif; overflow-wrap: anywhere; }
.message.user .message-content { padding: 10px 13px; border-radius: 13px; background: var(--user-bg); }
.message-content > :first-child { margin-top: 0; }
.message-content > :last-child { margin-bottom: 0; }
.message-content p { margin: 0 0 .9em; white-space: pre-wrap; }
.message-content h1, .message-content h2, .message-content h3, .message-content h4, .message-content h5, .message-content h6 { margin: 1.3em 0 .55em; line-height: 1.25; letter-spacing: -.018em; }
.message-content h1 { font-size: 1.55em; }
.message-content h2 { font-size: 1.35em; }
.message-content h3 { font-size: 1.18em; }
.message-content ul, .message-content ol { margin: .6em 0 1em; padding-left: 1.6em; }
.message-content li { margin: .28em 0; }
.message-content blockquote { margin: 1em 0; padding: .15em 0 .15em 1em; border-left: 3px solid var(--accent); color: var(--muted-strong); }
.message-content a { color: var(--accent-strong); text-decoration-thickness: .08em; text-underline-offset: .16em; }
.message-content hr { margin: 1.35em 0; border: 0; border-top: 1px solid var(--line-strong); }
.inline-code { padding: .14em .36em; border: 1px solid var(--line); border-radius: 6px; background: var(--code-bg); font: .9em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.code-block, .markdown-fallback, .math-fallback { max-width: 100%; margin: 1em 0; padding: 14px 16px; overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--code-bg); color: var(--ink); font: 13px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
.code-block code { font: inherit; white-space: pre; }
.table-scroll { max-width: 100%; margin: 1em 0; overflow-x: auto; }
.message-content table { width: 100%; border-collapse: collapse; font-size: 13px; }
.message-content th, .message-content td { padding: 9px 11px; border: 1px solid var(--line-strong); text-align: left; }
.message-content th { background: var(--accent-soft); font-weight: 700; }
.message-content [data-align="center"] { text-align: center; }
.message-content [data-align="right"] { text-align: right; }
.math-inline { display: inline-block; max-width: 100%; margin: 0 .12em; vertical-align: -.15em; }
.math-display { max-width: 100%; margin: 1.1em 0; padding: .35em 0; overflow-x: auto; text-align: center; }
.math-inline math, .math-display math { font-size: 1.06em; }
.message-actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; min-height: 29px; }
.message-action { padding: 5px 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--muted); font-size: 11px; }
.message-action:hover { border-color: var(--line); background: var(--panel-solid); color: var(--ink); }
.message.streaming .message-content::after { content: ""; display: inline-block; width: 7px; height: 17px; margin-left: 4px; vertical-align: -3px; background: var(--accent); animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: .18; } }

.composer-wrap { padding: 12px clamp(16px, 4vw, 40px) max(13px, env(safe-area-inset-bottom)); background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 97%, transparent) 23%); }
.composer { width: min(850px, 100%); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 10px; margin: 0 auto; padding: 11px 11px 11px 17px; border: 1px solid var(--line-strong); border-radius: 19px; background: var(--panel-solid); box-shadow: 0 18px 50px color-mix(in srgb, var(--ink) 10%, transparent); }
textarea { width: 100%; max-height: 180px; resize: none; overflow-y: auto; padding: 8px 0; border: 0; outline: 0; color: var(--ink); background: transparent; line-height: 1.55; }
textarea::placeholder { color: var(--muted); }
.composer-actions { display: flex; align-items: center; gap: 8px; }
.composer-hint { color: var(--muted); font-size: 10px; white-space: nowrap; }
.send-button, .stop-button, .icon-button { display: grid; place-items: center; border: 0; }
.send-button { width: 38px; height: 38px; border-radius: 12px; color: var(--accent-contrast); background: var(--accent); font-size: 19px; font-weight: 800; }
.send-button:disabled { cursor: not-allowed; opacity: .35; }
.stop-button { grid-auto-flow: column; gap: 6px; height: 38px; padding: 0 11px; border-radius: 12px; color: var(--ink); background: var(--accent-soft); font-size: 11px; font-weight: 700; }
.footer-note { margin: 8px auto 0; color: var(--muted); font-size: 10px; text-align: center; }
.icon-button { width: 36px; height: 36px; border-radius: 10px; background: var(--accent-soft); font-size: 18px; }
.toast { position: fixed; left: 50%; bottom: 25px; z-index: 20; transform: translate(-50%, 20px); max-width: min(90vw, 520px); padding: 10px 14px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--panel-solid); box-shadow: var(--shadow); color: var(--muted-strong); font-size: 12px; text-align: center; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; }
.toast.visible { opacity: 1; transform: translate(-50%, 0); }
.sidebar-scrim { position: fixed; inset: 0; z-index: 7; background: rgba(0, 0, 0, .48); }
.mobile-only { display: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 900px) {
  .theme-field { display: none; }
  .topbar-actions { gap: 8px; }
}
@media (max-width: 760px) {
  .app-shell { grid-template-columns: 1fr; }
  .mobile-only { display: grid; }
  .sidebar { position: fixed; inset: 0 auto 0 0; z-index: 8; width: min(86vw, 310px); transform: translateX(-102%); transition: transform .22s ease; box-shadow: var(--shadow); }
  .sidebar.open { transform: translateX(0); }
  .topbar { padding: 0 14px; }
  .topbar-meta #signed-in-user { display: none; }
  .model-control label { display: none; }
  select { max-width: 42vw; }
  .welcome { margin-top: 46px; }
  .prompt-grid { grid-template-columns: 1fr; margin-top: 28px; }
  .prompt-card { padding: 14px 16px; }
  .composer-hint { display: none; }
  .message { grid-template-columns: 31px minmax(0, 1fr); gap: 11px; }
  .message-avatar { width: 30px; height: 30px; border-radius: 9px; }
  .login-shell { padding-inline: 16px; }
  .login-tools { right: 12px; }
  .topbar .install-app { display: none !important; }
}
@media (max-width: 430px) {
  .login-card { padding: 28px 23px; border-radius: 23px; }
  .login-card h1 { font-size: 37px; }
  .topbar-meta { display: none; }
  .messages { width: calc(100% - 24px); }
  .message-actions { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
}
`;

export const CHAT_JS = String.raw`"use strict";

(function () {
  var storageKey = "lazyedge.private-chat.v1:" + window.location.host;
  var maxConversationCharacters = 128000;
  var maxPromptCharacters = 96000;
  var maxStoredCharacters = 1500000;
  var allowedThemes = ["bright", "dark", "system"];
  var initialized = false;
  var state = {
    csrf: "",
    username: "",
    models: [],
    model: "",
    conversations: [],
    activeId: "",
    theme: "bright",
    rememberSession: true,
    controller: null,
    streamConversationId: "",
    streamAssistant: null,
    streamNode: null,
    renderFrame: 0,
    installPrompt: null,
    waitingWorker: null
  };

  var elements = {
    loginView: document.getElementById("login-view"),
    appView: document.getElementById("app-view"),
    loginForm: document.getElementById("login-form"),
    loginError: document.getElementById("login-error"),
    username: document.getElementById("username"),
    password: document.getElementById("password"),
    remember: document.getElementById("remember-session"),
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
    toast: document.getElementById("toast"),
    themeColor: document.getElementById("theme-color"),
    updateBanner: document.getElementById("update-banner"),
    applyUpdate: document.getElementById("apply-update")
  };

  function identifier() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
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
      result.unshift({
        role: message.role,
        content: message.content,
        error: Boolean(message.error),
        stopped: Boolean(message.stopped)
      });
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

  function loadLocalState() {
    try {
      var parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
      if (Array.isArray(parsed.conversations)) {
        state.conversations = parsed.conversations.map(normalizeConversation).filter(Boolean).slice(0, 40);
      }
      if (typeof parsed.activeId === "string") state.activeId = parsed.activeId;
      if (typeof parsed.model === "string") state.model = parsed.model;
      if (allowedThemes.includes(parsed.theme)) state.theme = parsed.theme;
      if (typeof parsed.rememberSession === "boolean") state.rememberSession = parsed.rememberSession;
      if (!state.conversations.some(function (item) { return item.id === state.activeId; })) {
        state.activeId = state.conversations[0] ? state.conversations[0].id : "";
      }
    } catch (_) {
      state.conversations = [];
    }
    elements.remember.checked = state.rememberSession;
    applyTheme(state.theme);
  }

  function saveLocalState() {
    try {
      var evicted = false;
      var encoded = "";
      while (true) {
        encoded = JSON.stringify({
          conversations: state.conversations.slice(0, 40),
          activeId: state.activeId,
          model: state.model,
          theme: state.theme,
          rememberSession: state.rememberSession
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

  function resolvedDarkTheme() {
    return state.theme === "dark" || (state.theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function applyTheme(value) {
    state.theme = allowedThemes.includes(value) ? value : "bright";
    document.documentElement.dataset.theme = state.theme;
    document.querySelectorAll(".theme-select").forEach(function (picker) {
      picker.value = state.theme;
    });
    elements.themeColor.content = resolvedDarkTheme() ? "#091018" : "#f7faf9";
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
    if (state.streamConversationId === id && state.controller) state.controller.abort();
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

  function paintMarkdown(target, content) {
    if (window.LazyEdgeMarkdown && typeof window.LazyEdgeMarkdown.render === "function") {
      window.LazyEdgeMarkdown.render(target, content);
    } else {
      target.textContent = content;
    }
  }

  async function copyMessage(content) {
    var field = null;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        field = document.createElement("textarea");
        field.value = content;
        field.setAttribute("readonly", "");
        field.className = "sr-only";
        document.body.appendChild(field);
        field.select();
        if (!document.execCommand("copy")) throw new Error("copy rejected");
      }
      showToast("Response copied");
    } catch (_) {
      showToast("Copy was blocked by the browser");
    } finally {
      if (field) field.remove();
    }
  }

  function retryAssistant(conversation, messageIndex) {
    if (state.controller) {
      showToast("Stop the current response before retrying");
      return;
    }
    if (messageIndex < 1 || conversation.messages[messageIndex].role !== "assistant" || conversation.messages[messageIndex - 1].role !== "user") return;
    conversation.messages = conversation.messages.slice(0, messageIndex);
    var assistant = { role: "assistant", content: "" };
    conversation.messages.push(assistant);
    saveLocalState();
    runCompletion(conversation, assistant);
  }

  function messageNode(conversation, message, index, streaming) {
    var article = document.createElement("article");
    article.className = "message " + message.role + (streaming ? " streaming" : "");
    article.setAttribute("aria-busy", streaming ? "true" : "false");
    var avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = message.role === "user" ? "You" : "AI";
    avatar.setAttribute("aria-hidden", "true");
    var body = document.createElement("div");
    body.className = "message-body";
    var label = document.createElement("div");
    label.className = "message-label";
    label.textContent = message.role === "user" ? "You" : "LocalLLM";
    var content = document.createElement("div");
    content.className = "message-content";
    paintMarkdown(content, message.content || (streaming ? "Thinking…" : ""));
    body.appendChild(label);
    body.appendChild(content);
    if (message.role === "assistant") {
      var actions = document.createElement("div");
      actions.className = "message-actions";
      var copy = document.createElement("button");
      copy.className = "message-action";
      copy.type = "button";
      copy.textContent = "Copy";
      copy.disabled = streaming || !message.content;
      copy.setAttribute("aria-label", "Copy this response");
      copy.addEventListener("click", function () { copyMessage(message.content); });
      var retry = document.createElement("button");
      retry.className = "message-action";
      retry.type = "button";
      retry.textContent = "Retry";
      retry.disabled = streaming || Boolean(state.controller);
      retry.setAttribute("aria-label", "Regenerate this response");
      retry.addEventListener("click", function () { retryAssistant(conversation, index); });
      actions.appendChild(copy);
      actions.appendChild(retry);
      if (message.stopped) {
        var stopped = document.createElement("span");
        stopped.className = "message-action";
        stopped.textContent = "Stopped";
        actions.appendChild(stopped);
      }
      body.appendChild(actions);
    }
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
    state.streamNode = null;
    var conversation = activeConversation();
    var messages = conversation ? conversation.messages : [];
    elements.welcome.hidden = messages.length > 0;
    messages.forEach(function (message, index) {
      var streaming = Boolean(
        state.controller && conversation.id === state.streamConversationId &&
        message === state.streamAssistant
      );
      var article = messageNode(conversation, message, index, streaming);
      elements.messages.appendChild(article);
      if (streaming) state.streamNode = article;
    });
  }

  function scrollToEnd(force) {
    var distance = elements.scroll.scrollHeight - elements.scroll.scrollTop - elements.scroll.clientHeight;
    if (!force && distance > 180) return;
    window.requestAnimationFrame(function () {
      elements.scroll.scrollTop = elements.scroll.scrollHeight;
    });
  }

  function paintStreamingMessage() {
    state.renderFrame = 0;
    if (!state.streamNode || !state.streamAssistant || state.activeId !== state.streamConversationId) return;
    var content = state.streamNode.querySelector(".message-content");
    if (content) paintMarkdown(content, state.streamAssistant.content || "Thinking…");
    scrollToEnd(false);
  }

  function scheduleStreamingPaint() {
    if (state.renderFrame) return;
    state.renderFrame = window.requestAnimationFrame(paintStreamingMessage);
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      elements.toast.classList.remove("visible");
    }, 2600);
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

  function showLogin(message) {
    if (state.controller) state.controller.abort();
    state.csrf = "";
    state.controller = null;
    state.streamConversationId = "";
    state.streamAssistant = null;
    state.streamNode = null;
    if (state.renderFrame) {
      window.cancelAnimationFrame(state.renderFrame);
      state.renderFrame = 0;
    }
    elements.stop.hidden = true;
    elements.send.disabled = true;
    elements.appView.hidden = true;
    elements.loginView.hidden = false;
    elements.password.value = "";
    if (message) elements.loginError.textContent = message;
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
      showLogin("The private chat service is unavailable. Reconnect to continue.");
    }
  }

  function storePasswordWithBrowser() {
    if (!elements.remember.checked || !window.PasswordCredential || !navigator.credentials || !navigator.credentials.store) return;
    try {
      var credential = new window.PasswordCredential(elements.loginForm);
      Promise.resolve(navigator.credentials.store(credential)).catch(function () {});
    } catch (_) {
      return;
    }
  }

  async function login(event) {
    event.preventDefault();
    elements.loginError.textContent = "";
    var button = elements.loginForm.querySelector("button[type=submit]");
    var username = elements.username.value;
    var password = elements.password.value;
    state.rememberSession = elements.remember.checked;
    saveLocalState();
    button.disabled = true;
    try {
      var response = await api("/chat/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: username, password: password, remember: state.rememberSession })
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
      storePasswordWithBrowser();
      elements.password.value = "";
      password = "";
      elements.loginView.hidden = true;
      elements.appView.hidden = false;
      await loadModels();
      render();
      elements.input.focus();
    } catch (_) {
      elements.loginError.textContent = "Unable to reach the private chat service.";
    } finally {
      password = "";
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
      elements.send.disabled = state.models.length === 0 || Boolean(state.controller);
      setConnection(state.models.length ? "Ready" : "No models", state.models.length > 0);
      saveLocalState();
    } catch (_) {
      elements.model.replaceChildren();
      elements.send.disabled = true;
      setConnection(navigator.onLine === false ? "Offline" : "Model service offline", false);
      showToast("Models are currently unavailable");
    }
  }

  function resizeComposer() {
    elements.input.style.height = "auto";
    elements.input.style.height = Math.min(elements.input.scrollHeight, 180) + "px";
  }

  function normalizedMessages(conversation) {
    return recentMessageSuffix(conversation.messages, maxPromptCharacters, 64)
      .filter(function (message) { return !message.error; })
      .map(function (message) {
        return { role: message.role, content: message.content };
      });
  }

  function consumeEvent(block, assistant) {
    var changed = false;
    block.split("\n").forEach(function (line) {
      if (line.slice(0, 5) !== "data:") return;
      var data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      try {
        var parsed = JSON.parse(data);
        var choice = parsed.choices && parsed.choices[0];
        var content = choice && choice.delta && choice.delta.content;
        if (typeof content === "string" && assistant.content.length < 32000) {
          assistant.content += content.slice(0, 32000 - assistant.content.length);
          changed = true;
        }
      } catch (_) {
        return;
      }
    });
    return changed;
  }

  async function runCompletion(conversation, assistant) {
    if (state.controller || !state.model) return;
    var controller = new AbortController();
    state.controller = controller;
    state.streamConversationId = conversation.id;
    state.streamAssistant = assistant;
    assistant.error = false;
    assistant.stopped = false;
    elements.stop.hidden = false;
    elements.send.disabled = true;
    setConnection("Generating", true);
    saveLocalState();
    render();
    scrollToEnd(true);
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
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, "\n");
        var boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          if (consumeEvent(buffer.slice(0, boundary), assistant)) scheduleStreamingPaint();
          buffer = buffer.slice(boundary + 2);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() && consumeEvent(buffer, assistant)) scheduleStreamingPaint();
      if (!assistant.content) assistant.content = "The model returned an empty response.";
    } catch (error) {
      if (error.name === "AbortError") {
        assistant.stopped = true;
        if (!assistant.content) assistant.content = "Generation stopped.";
      } else {
        assistant.error = true;
        if (!assistant.content) assistant.content = "I could not reach the model. Please try again.";
        showToast("The model request failed");
      }
    } finally {
      conversation.messages = recentMessageSuffix(conversation.messages, maxConversationCharacters, 64);
      saveLocalState();
      if (state.controller !== controller) return;
      state.controller = null;
      state.streamConversationId = "";
      state.streamAssistant = null;
      state.streamNode = null;
      if (state.renderFrame) {
        window.cancelAnimationFrame(state.renderFrame);
        state.renderFrame = 0;
      }
      elements.stop.hidden = true;
      elements.send.disabled = state.models.length === 0;
      setConnection(state.models.length ? "Ready" : "No models", state.models.length > 0);
      render();
      scrollToEnd(true);
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    if (state.controller || !state.model) return;
    var text = elements.input.value.trim();
    if (!text) return;
    var conversation = activeConversation() || createConversation();
    conversation.messages = conversation.messages.slice(-62);
    conversation.messages.push({ role: "user", content: text });
    if (conversation.messages.length === 1) {
      conversation.title = text.replace(/\s+/g, " ").slice(0, 54) || "New conversation";
    }
    var assistant = { role: "assistant", content: "" };
    conversation.messages.push(assistant);
    elements.input.value = "";
    resizeComposer();
    runCompletion(conversation, assistant);
  }

  function openSidebar() {
    elements.sidebar.classList.add("open");
    elements.scrim.hidden = false;
  }

  function closeSidebar() {
    elements.sidebar.classList.remove("open");
    elements.scrim.hidden = true;
  }

  function showWaitingWorker(worker) {
    state.waitingWorker = worker;
    elements.updateBanner.hidden = false;
  }

  async function registerPwa() {
    if (!("serviceWorker" in navigator) || window.location.protocol !== "https:") return;
    try {
      var registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none"
      });
      if (registration.waiting) showWaitingWorker(registration.waiting);
      registration.addEventListener("updatefound", function () {
        var installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", function () {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            showWaitingWorker(registration.waiting || installing);
          }
        });
      });
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") registration.update().catch(function () {});
      });
    } catch (_) {
      return;
    }
  }

  function installButtons(show) {
    document.querySelectorAll(".install-app").forEach(function (button) {
      button.hidden = !show;
    });
  }

  function initialize() {
    if (initialized) return;
    initialized = true;
    loadLocalState();
    render();
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
    document.querySelectorAll(".theme-select").forEach(function (picker) {
      picker.addEventListener("change", function () {
        applyTheme(picker.value);
        saveLocalState();
      });
    });
    document.querySelectorAll(".install-app").forEach(function (button) {
      button.addEventListener("click", async function () {
        if (!state.installPrompt) return;
        state.installPrompt.prompt();
        await state.installPrompt.userChoice.catch(function () {});
        state.installPrompt = null;
        installButtons(false);
      });
    });
    elements.applyUpdate.addEventListener("click", function () {
      if (!state.waitingWorker) return;
      var reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      }, { once: true });
      state.waitingWorker.postMessage({ type: "SKIP_WAITING" });
    });
    elements.openSidebar.addEventListener("click", openSidebar);
    elements.closeSidebar.addEventListener("click", closeSidebar);
    elements.scrim.addEventListener("click", closeSidebar);
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      state.installPrompt = event;
      installButtons(true);
    });
    window.addEventListener("appinstalled", function () {
      state.installPrompt = null;
      installButtons(false);
      showToast("LocalLLM installed");
    });
    window.addEventListener("offline", function () { setConnection("Offline", false); });
    window.addEventListener("online", function () {
      if (!elements.appView.hidden) loadModels();
    });
    if (window.matchMedia) {
      var systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
      systemTheme.addEventListener && systemTheme.addEventListener("change", function () {
        if (state.theme === "system") applyTheme("system");
      });
    }
    registerPwa();
    establishSession();
  }

  function initializeWhenMarkdownReady() {
    if (window.LazyEdgeMarkdown && typeof window.LazyEdgeMarkdown.render === "function") {
      initialize();
      return;
    }
    window.addEventListener("lazyedge-markdown-ready", initialize, { once: true });
    window.setTimeout(initialize, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeWhenMarkdownReady, { once: true });
  } else {
    initializeWhenMarkdownReady();
  }
}());
`;
