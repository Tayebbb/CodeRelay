/*
 * CodeRelay web client.
 *
 * Plain JS on purpose: no framework, no build step, no supply chain. Every
 * piece of server-derived text enters the DOM through textContent — never
 * innerHTML — so hostile agent output or commit messages cannot script this
 * page.
 *
 * Rendering honesty: the agent's own words (final message, tool activity,
 * terminal output) are shown verbatim and visually separated from CodeRelay's
 * system events. Nothing the agent said is paraphrased, and nothing CodeRelay
 * generated is dressed up as the agent.
 */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  tasks: [],
  agents: [],
  selectedProject: null,
  activeTaskId: null,
  activeTask: null,
  activeTab: 'chat',
  mode: 'code',
  followUpTo: null,
  eventSource: null,
  pendingApprovals: new Map(),
  diffCache: new Map(),
  liveLines: 0,
};

const MAX_LIVE_LINES = 400;
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

/* CodeRelay's Telegram decoration; never part of what the agent actually said. */
const EMOJI_PREFIX = /^(🛠|💭|🤖|⚠️|🔍|🔁|🧪|🏗|✅|🧭|🛑|📦|🔒|🔭|👓|🔐|♻️|⏳|🚫|❌|↩️|🔀)\uFE0F?\s*/u;
const stripDecoration = (text) => text.replace(EMOJI_PREFIX, '');

// ------------------------------------------------------------------ theme

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Keep the OS chrome (status bar, title bar) in step with the app surface.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f4f6' : '#0b0b0e');
  try { localStorage.setItem('coderelay-theme', theme); } catch { /* private mode */ }
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('coderelay-theme'); } catch { /* private mode */ }
  const preferred = saved ?? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(preferred);
})();
$('theme-button').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
});

// ------------------------------------------------------------------ fetch

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'X-CodeRelay': '1',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (response.status === 401) {
    showLogin();
    throw new Error('Not signed in');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// ------------------------------------------------------------------ svg helpers

function svgIcon(name, cls = 'icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

// ------------------------------------------------------------------ views

function showLogin() {
  state.eventSource?.close();
  state.eventSource = null;
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('login-password').focus();
}

async function showApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  showSkeletons();
  await Promise.all([loadProjects(), loadAgents(), loadTasks(), refreshStatus()]);
  connectEvents();
}

function showSkeletons() {
  for (const listId of ['project-list', 'task-list']) {
    const list = $(listId);
    if (list.childElementCount > 0) continue;
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li');
      const bone = document.createElement('div');
      bone.className = 'skeleton';
      li.append(bone);
      list.append(li);
    }
  }
}

// ------------------------------------------------------------------ login

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('login-button');
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('login-password').value }) });
    $('login-password').value = '';
    await showApp();
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* session may be gone */ }
  showLogin();
});

// ------------------------------------------------------------------ data

async function loadProjects() {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  if (!state.selectedProject && projects.length > 0) state.selectedProject = projects[0].id;

  const list = $('project-list');
  list.replaceChildren();
  const select = $('project-select');
  select.replaceChildren();

  if (projects.length === 0) {
    const li = document.createElement('li');
    const hint = document.createElement('div');
    hint.className = 'usage-line';
    hint.textContent = 'No projects yet. Register one on the PC:  npm run agent -- projects add';
    li.append(hint);
    list.append(li);
  }

  for (const project of projects) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = project.name;
    button.className = project.id === state.selectedProject ? 'selected' : '';
    button.addEventListener('click', () => {
      state.selectedProject = project.id;
      select.value = project.id;
      updateTopbarProject();
      loadProjects();
      closeDrawer();
    });
    li.append(button);
    list.append(li);

    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    select.append(option);
  }
  if (state.selectedProject) select.value = state.selectedProject;
  select.onchange = () => { state.selectedProject = select.value; updateTopbarProject(); void loadGitPanel(); };
  updateTopbarProject();
  void loadGitPanel();
}

function updateTopbarProject() {
  $('topbar-project').textContent = projectName(state.selectedProject) ?? '';
}

// ------------------------------------------------------------------ git panel

async function loadGitPanel() {
  const panel = $('git-panel');
  if (!state.selectedProject) return panel.classList.add('hidden');
  let git;
  try {
    git = await api(`/api/projects/${encodeURIComponent(state.selectedProject)}/git`);
  } catch {
    return panel.classList.add('hidden');
  }
  if (!git.isRepo) return panel.classList.add('hidden');

  panel.classList.remove('hidden');
  const info = $('git-info');
  info.replaceChildren();
  const branch = document.createElement('div');
  branch.className = 'git-branch';
  branch.textContent = git.branch ?? 'detached HEAD';
  const position = document.createElement('div');
  position.className = 'git-position';
  position.textContent = git.hasRemote
    ? `↑${git.ahead} ↓${git.behind}${git.dirty ? ` · ${git.dirty} uncommitted` : ''}`
    : 'no remote configured';
  info.append(branch, position);
  if (git.error) {
    const err = document.createElement('div');
    err.className = 'git-error';
    err.textContent = git.error;
    info.append(err);
  }
  for (const button of document.querySelectorAll('#git-panel [data-git]')) {
    button.disabled = !git.hasRemote || !!git.error;
  }
}

for (const button of document.querySelectorAll('#git-panel [data-git]')) {
  button.addEventListener('click', async () => {
    const buttons = [...document.querySelectorAll('#git-panel [data-git]')];
    for (const b of buttons) b.disabled = true;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(state.selectedProject)}/git`, {
        method: 'POST',
        body: JSON.stringify({ action: button.dataset.git }),
      });
      note(result.message || 'Done.');
    } catch (err) {
      note(err.message, true);
    } finally {
      await loadGitPanel();
    }
  });
}

async function loadAgents() {
  const { agents, defaultModel } = await api('/api/agents');
  state.agents = agents;
  const select = $('model-select');
  select.replaceChildren();

  for (const agent of agents) {
    const group = document.createElement('optgroup');
    const marker = !agent.installed ? ' — not installed' : !agent.authenticated ? ' — sign-in needed' : '';
    group.label = `${agent.name}${marker}`;
    if (agent.selectable && agent.models.length > 0) {
      for (const model of agent.models) {
        const option = document.createElement('option');
        // Provider travels with the model choice; the server re-validates both.
        option.value = `${agent.id}::${model}`;
        option.dataset.provider = agent.id;
        option.dataset.model = model;
        option.textContent = model;
        if (agent.active && model === defaultModel) option.selected = true;
        group.append(option);
      }
    } else {
      const option = document.createElement('option');
      option.disabled = true;
      option.textContent = agent.installed ? 'sign in on the PC to use this' : 'not available on the PC';
      group.append(option);
    }
    select.append(group);
  }
}

async function loadTasks() {
  const { tasks } = await api('/api/tasks?limit=40');
  state.tasks = tasks;
  renderTaskList();
  renderQueue();
}

function statusDotClass(status) {
  if (status === 'RUNNING' || status === 'TESTING') return 'dot dot-busy pulse';
  if (status === 'COMPLETED') return 'dot dot-ok';
  if (status === 'FAILED' || status === 'TIMED_OUT') return 'dot dot-bad';
  return 'dot';
}

function renderTaskList() {
  const list = $('task-list');
  list.replaceChildren();
  for (const task of state.tasks) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = task.id === state.activeTaskId ? 'selected' : '';

    const line = document.createElement('div');
    line.className = 'task-line';
    const dot = document.createElement('span');
    dot.className = `t-dot ${statusDotClass(task.status)}`;
    const id = document.createElement('span');
    id.className = 't-id';
    id.textContent = `#${task.id}`;
    const prompt = document.createElement('span');
    prompt.className = 't-prompt';
    prompt.textContent = task.prompt;
    line.append(dot, id, prompt);
    button.append(line);
    button.addEventListener('click', () => { openTask(task.id); closeDrawer(); });
    li.append(button);
    list.append(li);
  }
}

function renderQueue() {
  const queued = state.tasks
    .filter((t) => t.status === 'QUEUED' && t.queuePosition)
    .sort((a, b) => a.queuePosition - b.queuePosition);
  $('queue-section').classList.toggle('hidden', queued.length === 0);
  const list = $('queue-list');
  list.replaceChildren();
  for (const task of queued) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    const text = document.createElement('span');
    text.className = 't-prompt';
    text.textContent = task.prompt;
    button.append(text);
    button.addEventListener('click', () => { openTask(task.id); closeDrawer(); });
    li.append(button);
    list.append(li);
  }
}

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    const busy = status.running.length > 0;
    $('conn-dot').className = status.agentReady ? (busy ? 'dot dot-busy pulse' : 'dot dot-ok') : 'dot dot-bad';
    $('conn-text').textContent = busy
      ? `Working on #${status.running.join(', #')}`
      : status.agentReady ? 'Ready' : 'Agent not signed in';
    const cap = status.creditsPerDayCap > 0 ? ` / ${status.creditsPerDayCap}` : '';
    $('usage-line').textContent = `${status.model} · ${status.creditsToday.toFixed(1)}${cap} credits today`;
    syncSendButton();
  } catch { /* transient */ }
}

// ------------------------------------------------------------------ task view

function shortStatus(status) {
  return { WAITING_APPROVAL: 'Waiting', COMPLETED: 'Done', CANCELLED: 'Stopped', TIMED_OUT: 'Timeout', RUNNING: 'Running', TESTING: 'Testing', QUEUED: 'Queued', FAILED: 'Failed' }[status] ?? status;
}

async function openTask(id, { keepTab = false } = {}) {
  state.activeTaskId = id;
  if (!keepTab) state.activeTab = 'chat';
  renderTaskList();

  const { task, events, approvalPending } = await api(`/api/tasks/${id}`);
  state.activeTask = task;
  $('task-header').classList.remove('hidden');
  $('empty-state')?.remove();
  $('task-id-label').textContent = `#${task.id} · ${projectName(task.projectId)}`;
  const pill = $('task-status-pill');
  pill.className = `pill ${task.status}`;
  pill.textContent = shortStatus(task.status);

  const finished = TERMINAL.includes(task.status);
  $('cancel-button').classList.toggle('hidden', finished);
  $('retry-button').classList.toggle('hidden', !finished);
  $('followup-button').classList.toggle('hidden', !finished || !task.canFollowUp);
  $('promote-button').classList.toggle('hidden', task.status !== 'QUEUED');
  // The composer follows the open task: a finished, resumable task makes the
  // next message a follow-up in the same agent session — one conversation, one
  // window. The chip's × (or switching project) starts a fresh task instead.
  if (finished && task.canFollowUp) armFollowUp(task, { focus: false });
  else clearFollowUp();
  syncSendButton();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.tab === state.activeTab);
  }

  const stream = $('stream');
  stream.replaceChildren();
  state.liveLines = 0;

  if (state.activeTab === 'chat') renderChat(stream, task, events, await taskChain(task));
  else if (state.activeTab === 'changes') await renderChanges(stream, task);
  else if (state.activeTab === 'tests') renderTests(stream, task);
  else renderTimeline(stream, events);

  renderApprovalArea(approvalPending ? id : null, task);
  stream.scrollTop = stream.scrollHeight;
}

// ------------------------------------------------------------------ chat rendering

function sysLine(text, ts = null) {
  const row = document.createElement('div');
  row.className = 'sys-line';
  const tag = document.createElement('span');
  tag.className = 'sys-tag';
  tag.textContent = 'CodeRelay';
  const body = document.createElement('span');
  body.className = 'sys-text';
  body.textContent = (ts ? `${timeOf(ts)} · ` : '') + stripDecoration(text);
  row.append(tag, body);
  return row;
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function agentBlock(modelLabel) {
  const block = document.createElement('div');
  block.className = 'agent-block';
  const head = document.createElement('div');
  head.className = 'agent-head';
  head.append(svgIcon('i-relay'));
  const label = document.createElement('span');
  label.textContent = `Agent${modelLabel ? ` · ${modelLabel}` : ''}`;
  head.append(label);
  const activity = document.createElement('div');
  activity.className = 'agent-activity';
  block.append(head, activity);
  return block;
}

function activityLine(text, ts) {
  const stripped = stripDecoration(text);
  const row = document.createElement('div');
  const isTool = /^🛠/u.test(text);
  row.className = `activity-line${isTool ? ' tool' : ''}`;
  const time = document.createElement('span');
  time.className = 'ts';
  time.textContent = timeOf(ts);
  const body = document.createElement('span');
  body.textContent = stripped;
  row.append(time, body);
  return row;
}

// Ancestors of a follow-up, oldest first, so the chat reads as one thread.
async function taskChain(task) {
  const chain = [];
  let parentId = task.parentTaskId;
  for (let depth = 0; parentId && depth < 10; depth += 1) {
    try {
      const { task: parent } = await api(`/api/tasks/${parentId}`);
      chain.unshift(parent);
      parentId = parent.parentTaskId;
    } catch {
      break;
    }
  }
  return chain;
}

function renderChat(stream, task, events, thread = []) {
  for (const ancestor of thread) {
    const past = document.createElement('div');
    past.className = 'msg-user thread-past';
    past.textContent = ancestor.prompt;
    stream.append(past);
    if (ancestor.agentMessage) {
      const block = agentBlock(ancestor.model ?? null);
      block.classList.add('thread-past');
      block.querySelector('.agent-activity').remove();
      block.append(renderAgentMessage(ancestor.agentMessage));
      stream.append(block);
    }
    stream.append(sysLine(`task #${ancestor.id} · ${shortStatus(ancestor.status)} — followed up below`));
  }
  if (task.parentTaskId && thread.length === 0) {
    stream.append(sysLine(`Follows task #${task.parentTaskId} — same agent session`));
  }
  const user = document.createElement('div');
  user.className = 'msg-user';
  user.textContent = task.prompt;
  stream.append(user);

  // Persisted history: CodeRelay telemetry. Chat shows the events an operator
  // acts on; raw internals (status arrows, attempt counters, confidence) stay
  // in the Timeline tab.
  const CHAT_KINDS = new Set(['git', 'plan', 'approval', 'retry', 'recovery', 'security', 'verify', 'explore', 'queue', 'model', 'provider']);
  for (const event of events) {
    if (!CHAT_KINDS.has(event.kind)) continue;
    stream.append(sysLine(`${event.message}`, event.ts));
  }

  // The agent's own final message, verbatim.
  if (task.agentMessage) {
    const block = agentBlock(task.model ?? null);
    block.querySelector('.agent-activity').remove();
    block.append(renderAgentMessage(task.agentMessage));
    stream.append(block);
  }

  // Real terminal output from verification, untouched.
  for (const v of task.verifications ?? []) stream.append(terminalBlock(v));

  if (task.status === 'COMPLETED' || task.status === 'FAILED') stream.append(resultCard(task));
}

/**
 * Verbatim message rendering: split on ``` fences into paragraphs and code
 * blocks. The TEXT is never altered — this only chooses containers.
 */
function renderAgentMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'agent-message';

  const prose = (chunk) => {
    const trimmed = chunk.replace(/^\n+|\n+$/g, '');
    if (!trimmed) return;
    const p = document.createElement('p');
    p.textContent = trimmed;
    wrap.append(p);
  };

  // split with one capture alternates [text, capture, text, capture, …]; the
  // captures alternate between an OPENING fence (with language) and a CLOSING
  // one, so a small state machine decides what each text chunk is.
  const parts = text.split(/^```([^\n`]*)[ \t]*$/m);
  prose(parts[0] ?? '');
  let inCode = false;
  let lang = '';
  for (let i = 1; i < parts.length; i += 2) {
    const capture = parts[i] ?? '';
    const chunk = parts[i + 1] ?? '';
    if (!inCode) {
      inCode = true;
      lang = capture.trim();
      wrap.append(codeBlock(chunk.replace(/^\n|\n$/g, ''), lang));
    } else {
      inCode = false;
      prose(chunk);
    }
  }
  return wrap;
}

function codeBlock(code, lang) {
  const block = document.createElement('div');
  block.className = 'code-block';
  const head = document.createElement('div');
  head.className = 'code-head';
  const label = document.createElement('span');
  label.textContent = lang || 'code';
  head.append(label, copyButton(code));
  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  highlightInto(codeEl, code);
  pre.append(codeEl);
  block.append(head, pre);
  return block;
}

function copyButton(text) {
  const button = document.createElement('button');
  button.className = 'copy-button';
  button.type = 'button';
  button.setAttribute('aria-label', 'Copy');
  const icon = svgIcon('i-copy');
  const label = document.createElement('span');
  label.textContent = 'Copy';
  button.append(icon, label);
  button.addEventListener('click', async () => {
    try {
      // The exact original content, not the highlighted DOM.
      await navigator.clipboard.writeText(text);
      button.classList.add('copied');
      label.textContent = 'Copied';
      icon.replaceWith(svgIcon('i-check'));
      setTimeout(() => {
        button.classList.remove('copied');
        label.textContent = 'Copy';
        button.querySelector('svg').replaceWith(svgIcon('i-copy'));
      }, 1600);
    } catch { label.textContent = 'Press Ctrl+C'; }
  });
  return button;
}

/** Tiny display-only tokenizer. Builds spans via DOM — never HTML strings. */
const TOKEN_RE = /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|while|import|from|export|class|def|async|await|new|try|catch|throw|type|interface|public|private|static|void|int|string|bool|true|false|null|None|self|fn|pub|use|match)\b|\b(\d+(?:\.\d+)?)\b/g;
function highlightInto(parent, code) {
  let last = 0;
  for (const match of code.matchAll(TOKEN_RE)) {
    if (match.index > last) parent.append(code.slice(last, match.index));
    const span = document.createElement('span');
    span.className = match[1] ? 'tok-c' : match[2] ? 'tok-s' : match[3] ? 'tok-k' : 'tok-n';
    span.textContent = match[0];
    parent.append(span);
    last = match.index + match[0].length;
  }
  if (last < code.length) parent.append(code.slice(last));
}

function terminalBlock(v) {
  const block = document.createElement('div');
  block.className = `term-block ${v.passed ? 'pass' : 'fail'}`;
  const cmd = document.createElement('div');
  cmd.className = 'term-cmd';
  cmd.textContent = v.command;
  const out = document.createElement('pre');
  out.className = 'term-out';
  out.textContent = v.output || '(no output)';
  const meta = document.createElement('div');
  meta.className = 'term-meta';
  meta.textContent = `${v.kind} · ${v.passed ? 'passed' : 'FAILED'} · ${(v.durationMs / 1000).toFixed(1)}s`;
  block.append(cmd, out, meta);
  return block;
}

function resultCard(task) {
  const ok = task.status === 'COMPLETED';
  const card = document.createElement('div');
  card.className = `result-card ${ok ? 'ok' : 'failed'}`;
  const title = document.createElement('div');
  title.className = 'r-title';
  title.append(svgIcon(ok ? 'i-check' : 'i-stop'));
  const titleText = document.createElement('span');
  titleText.textContent = ok ? 'Task completed' : 'Task failed';
  title.append(titleText);
  card.append(title);

  const grid = document.createElement('div');
  grid.className = 'r-grid';
  const row = (label, value, mono = false) => {
    const key = document.createElement('span');
    key.textContent = label;
    const val = document.createElement('b');
    if (mono) val.className = 'mono';
    val.textContent = value;
    grid.append(key, val);
  };
  if (task.files.length > 0) {
    row('Files changed', `${task.files.length}  (+${task.linesAdded} −${task.linesRemoved})`);
  }
  if (task.testsPassed !== null) row('Tests', task.testsPassed ? 'passed' : 'failed');
  if (task.commit) {
    row('Commit', `${task.branch ?? ''} ${task.commit.slice(0, 10)} · local, not pushed`, true);
  } else if (ok) {
    row('Commit', 'none created');
  }
  if (task.aiCredits > 0) row('AI credits', task.aiCredits.toFixed(2));
  if (task.error) row('Error', task.error);
  card.append(grid);
  return card;
}

// ------------------------------------------------------------------ tests tab

function renderTests(stream, task) {
  const verifications = task.verifications ?? [];
  if (verifications.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-state';
    const h = document.createElement('h2');
    h.textContent = 'No verification ran';
    const p = document.createElement('p');
    p.textContent = 'This task has no recorded test or build output yet.';
    note.append(h, p);
    stream.append(note);
    return;
  }
  for (const v of verifications) stream.append(terminalBlock(v));
}

// ------------------------------------------------------------------ diff

async function renderChanges(stream, task) {
  let data = state.diffCache.get(task.id);
  if (!data) {
    data = await api(`/api/tasks/${task.id}/diff`);
    // Cache only a real diff on a finished task; "no commit yet" must stay
    // re-checkable because publish happens after verification.
    if (data.diff && TERMINAL.includes(task.status)) state.diffCache.set(task.id, data);
  }
  if (!data.diff) {
    const note = document.createElement('div');
    note.className = 'empty-state';
    const h = document.createElement('h2');
    h.textContent = 'No changes recorded';
    const p = document.createElement('p');
    p.textContent = data.note || 'This task created no commit.';
    note.append(h, p);
    stream.append(note);
    return;
  }

  const files = parseDiff(data.diff);
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);

  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = ` +${adds} `;
  const minus = document.createElement('span');
  minus.className = 'minus';
  minus.textContent = `−${dels}`;
  summary.append(`${files.length} file${files.length === 1 ? '' : 's'} changed`, plus, minus);
  stream.append(summary);

  for (const file of files) {
    const box = document.createElement('div');
    box.className = 'diff-file';
    const head = document.createElement('button');
    head.className = 'diff-file-head';
    head.setAttribute('aria-expanded', 'true');
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = file.name;
    const p = document.createElement('span');
    p.className = 'plus';
    p.textContent = `+${file.adds}`;
    const m = document.createElement('span');
    m.className = 'minus';
    m.textContent = `−${file.dels}`;
    head.append(name, p, m);

    const body = document.createElement('div');
    body.className = 'diff-body';
    for (const line of file.lines) {
      const div = document.createElement('div');
      div.className = `dl${line.startsWith('+') ? ' add' : line.startsWith('-') ? ' del' : line.startsWith('@@') ? ' hunk' : ''}`;
      div.textContent = line;
      body.append(div);
    }
    head.addEventListener('click', () => {
      const open = !body.classList.toggle('hidden');
      head.setAttribute('aria-expanded', String(open));
    });
    box.append(head, body);
    stream.append(box);
  }
}

function parseDiff(text) {
  const files = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const name = line.split(' b/').pop() ?? 'file';
      current = { name, lines: [], adds: 0, dels: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    current.lines.push(line);
    if (line.startsWith('+')) current.adds += 1;
    else if (line.startsWith('-')) current.dels += 1;
  }
  return files;
}

function renderTimeline(stream, events) {
  const box = document.createElement('div');
  box.className = 'timeline';
  for (const event of events) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    const ts = document.createElement('span');
    ts.className = 'tl-ts';
    ts.textContent = new Date(event.ts).toLocaleTimeString();
    const kind = document.createElement('span');
    kind.className = 'tl-kind';
    kind.textContent = event.kind;
    const msg = document.createElement('span');
    msg.className = 'tl-msg';
    msg.textContent = event.message;
    row.append(ts, kind, msg);
    box.append(row);
  }
  stream.append(box);
}

// ------------------------------------------------------------------ approvals

function renderApprovalArea(pendingTaskId, task) {
  const area = $('approval-area');
  area.replaceChildren();
  if (!pendingTaskId) return;

  const stored = state.pendingApprovals.get(pendingTaskId);
  const template = $('approval-template').content.cloneNode(true);
  template.querySelector('.approval-body').textContent = stored
    ? `${stored.project}: ${stored.reason}\n${stored.details}`
    : task?.approvalReason || 'The agent is waiting for your decision.';

  template.querySelector('.approve').addEventListener('click', () => answerApproval(pendingTaskId, 'APPROVED'));
  template.querySelector('.reject').addEventListener('click', () => answerApproval(pendingTaskId, 'REJECTED'));
  area.append(template);
}

async function answerApproval(taskId, decision) {
  try {
    await api(`/api/tasks/${taskId}/approval`, { method: 'POST', body: JSON.stringify({ decision }) });
    state.pendingApprovals.delete(taskId);
    $('approval-area').replaceChildren();
    if (state.activeTaskId === taskId) openTask(taskId, { keepTab: true });
  } catch (err) {
    note(err.message, true);
  }
}

// ------------------------------------------------------------------ live events

function connectEvents() {
  state.eventSource?.close();
  const source = new EventSource('/api/events');
  state.eventSource = source;

  const refreshList = debounce(() => { loadTasks(); refreshStatus(); }, 400);

  const onTaskTouched = (event) => {
    const data = JSON.parse(event.data);
    refreshList();
    if (data.taskId === state.activeTaskId) reloadActiveSoon();
  };

  source.addEventListener('task-created', onTaskTouched);
  source.addEventListener('task-status', onTaskTouched);
  source.addEventListener('task-log', onTaskTouched);
  source.addEventListener('task-progress', (event) => {
    const data = JSON.parse(event.data);
    if (data.taskId === state.activeTaskId && state.activeTab === 'chat') {
      appendLiveProgress(data.data.text, data.data.source ?? 'system');
    }
  });
  source.addEventListener('approval-requested', (event) => {
    const data = JSON.parse(event.data);
    state.pendingApprovals.set(data.taskId, data.data);
    if (state.activeTaskId === data.taskId || state.activeTaskId === null) {
      if (state.activeTaskId === null) openTask(data.taskId);
      else renderApprovalArea(data.taskId, null);
    }
    refreshList();
  });
  source.addEventListener('approval-resolved', (event) => {
    const data = JSON.parse(event.data);
    state.pendingApprovals.delete(data.taskId);
    if (state.activeTaskId === data.taskId) $('approval-area').replaceChildren();
    refreshList();
  });

  source.onopen = () => {
    // Full resync on every (re)connect: Last-Event-ID replay only covers the
    // server's bounded buffer, so a long offline gap needs a fresh read. The
    // server is the source of truth — nothing is re-submitted.
    refreshStatus();
    loadTasks();
    if (state.activeTaskId !== null) reloadActiveSoon();
  };
  source.onerror = () => {
    // EventSource reconnects on its own (with Last-Event-ID replay). The task
    // on the PC keeps running regardless; the UI only reports WHY it is quiet:
    // this device having no internet is a different state from the home PC
    // being unreachable.
    $('conn-dot').className = 'dot dot-bad';
    $('conn-text').textContent = navigator.onLine ? 'Home PC unreachable — reconnecting…' : 'No internet connection';
  };
}

function appendLiveProgress(text, source) {
  const stream = $('stream');
  if (state.liveLines >= MAX_LIVE_LINES) return; // a reload compacts history
  state.liveLines += 1;

  if (source === 'agent') {
    // Live agent activity attaches to (or creates) the current agent block.
    let block = stream.querySelector('.agent-block:last-of-type');
    let activity = block?.querySelector('.agent-activity');
    if (!activity) {
      block = agentBlock(state.activeTask?.model ?? null);
      stream.append(block);
      activity = block.querySelector('.agent-activity');
    }
    activity.append(activityLine(text, Date.now()));
  } else {
    stream.append(sysLine(text, Date.now()));
  }
  stream.scrollTop = stream.scrollHeight;
}

const reloadActiveSoon = debounce(() => {
  if (state.activeTaskId !== null) openTask(state.activeTaskId, { keepTab: true });
}, 500);

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ------------------------------------------------------------------ composer

const promptInput = $('prompt-input');
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
});
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendOrStop();
  }
});

for (const seg of document.querySelectorAll('.seg')) {
  seg.addEventListener('click', () => {
    state.mode = seg.dataset.mode;
    for (const other of document.querySelectorAll('.seg')) {
      const active = other === seg;
      other.classList.toggle('active', active);
      other.setAttribute('aria-checked', String(active));
    }
  });
}

$('send-button').addEventListener('click', sendOrStop);

function activeTaskIsRunning() {
  const task = state.tasks.find((t) => t.id === state.activeTaskId);
  return !!task && (task.status === 'RUNNING' || task.status === 'TESTING');
}

function syncSendButton() {
  const button = $('send-button');
  const running = activeTaskIsRunning();
  button.classList.toggle('stopping', running && promptInput.value.trim() === '');
  button.setAttribute('aria-label', button.classList.contains('stopping') ? 'Stop task' : 'Send');
}
promptInput.addEventListener('input', syncSendButton);

async function sendOrStop() {
  if ($('send-button').classList.contains('stopping')) {
    try {
      await api(`/api/tasks/${state.activeTaskId}/cancel`, { method: 'POST' });
      note('Cancellation requested.');
    } catch (err) { note(err.message, true); }
    return;
  }
  await sendTask();
}

function note(text, isError = false) {
  const el = $('composer-note');
  el.textContent = text;
  el.className = `composer-note${isError ? ' error' : ''}`;
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 6000);
}

async function sendTask() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  if (!state.selectedProject) return note('Register a project on the PC first.', true);

  const button = $('send-button');
  button.disabled = true;
  try {
    const selected = $('model-select').selectedOptions[0] ?? null;
    const body = {
      projectId: $('project-select').value,
      prompt,
      model: selected?.dataset.model || null,
      provider: selected?.dataset.provider || null,
      mode: state.mode,
      followUpTo: state.followUpTo,
    };
    const { task, awaitingApproval } = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    clearFollowUp();
    promptInput.value = '';
    promptInput.style.height = 'auto';
    note(awaitingApproval ? `Task #${task.id} needs approval before it runs.` : `Task #${task.id} queued.`);
    await loadTasks();
    await openTask(task.id);
  } catch (err) {
    note(err.message, true);
  } finally {
    button.disabled = false;
    syncSendButton();
  }
}

// ------------------------------------------------------------------ header actions

// Follow-up mode: the next send resumes the chosen task's agent session. The
// chip is the visible state; clicking it (or switching project) disarms it.
function armFollowUp(task, { focus = true } = {}) {
  state.followUpTo = task.id;
  const chip = $('followup-chip');
  chip.textContent = `↩ follows #${task.id} ×`;
  chip.classList.remove('hidden');
  $('project-select').value = task.projectId;
  promptInput.placeholder = `Follow up on task #${task.id}…`;
  if (focus) promptInput.focus();
}

function clearFollowUp() {
  state.followUpTo = null;
  $('followup-chip').classList.add('hidden');
  promptInput.placeholder = 'Describe a coding task…';
}

$('followup-button').addEventListener('click', () => {
  if (state.activeTask) armFollowUp(state.activeTask);
});
$('followup-chip').addEventListener('click', clearFollowUp);
$('project-select').addEventListener('change', clearFollowUp);

$('cancel-button').addEventListener('click', async () => {
  if (state.activeTaskId === null) return;
  try {
    await api(`/api/tasks/${state.activeTaskId}/cancel`, { method: 'POST' });
    note('Cancellation requested.');
  } catch (err) { note(err.message, true); }
});

$('retry-button').addEventListener('click', async () => {
  if (state.activeTaskId === null) return;
  try {
    const result = await api(`/api/tasks/${state.activeTaskId}/retry`, { method: 'POST' });
    note(result.message || 'Re-queued.');
    if (result.taskId) { await loadTasks(); await openTask(result.taskId); }
  } catch (err) { note(err.message, true); }
});

$('promote-button').addEventListener('click', async () => {
  if (state.activeTaskId === null) return;
  try {
    const result = await api(`/api/tasks/${state.activeTaskId}/promote`, { method: 'POST' });
    note(result.message || 'Moved to the front.');
    await loadTasks();
  } catch (err) { note(err.message, true); }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.activeTab = tab.dataset.tab;
    if (state.activeTaskId !== null) openTask(state.activeTaskId, { keepTab: true });
  });
}

// ------------------------------------------------------------------ sidebar / shortcuts

function projectName(id) {
  return state.projects.find((p) => p.id === id)?.name ?? id;
}
function closeDrawer() {
  $('sidebar').classList.remove('open');
  $('scrim').classList.add('hidden');
}
$('menu-button').addEventListener('click', () => {
  $('sidebar').classList.toggle('open');
  $('scrim').classList.toggle('hidden');
});
$('scrim').addEventListener('click', closeDrawer);
$('sidebar-toggle').addEventListener('click', () => {
  $('app-view').classList.toggle('sidebar-collapsed');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    promptInput.focus();
  }
});

// ------------------------------------------------------------------ pwa

function pwaNote(id, text, actions) {
  try { if (localStorage.getItem(`coderelay-dismissed-${id}`)) return; } catch { return; }
  const area = $('pwa-area');
  if (area.querySelector(`[data-note="${id}"]`)) return;
  const card = document.createElement('div');
  card.className = 'pwa-note';
  card.dataset.note = id;
  const body = document.createElement('span');
  body.textContent = text;
  const row = document.createElement('div');
  row.className = 'pwa-actions';
  for (const [label, primary, onClick] of actions) {
    const button = document.createElement('button');
    if (primary) button.className = 'primary';
    button.textContent = label;
    button.addEventListener('click', () => onClick(card));
    row.append(button);
  }
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Not now';
  dismiss.addEventListener('click', () => {
    try { localStorage.setItem(`coderelay-dismissed-${id}`, '1'); } catch { /* private mode */ }
    card.remove();
  });
  row.append(dismiss);
  card.append(body, row);
  area.append(card);
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      registration.addEventListener('updatefound', () => {
        const fresh = registration.installing;
        fresh?.addEventListener('statechange', () => {
          // A waiting worker while a controller exists = an update, not first install.
          if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
            pwaNote('update-' + Date.now(), 'A new version of CodeRelay is ready.', [
              ['Reload', true, () => {
                registration.waiting?.postMessage('skip-waiting');
                setTimeout(() => location.reload(), 150);
              }],
            ]);
          }
        });
      });
    } catch { /* http without SW support is fine; the app works without it */ }
  });
}

// Chromium: real install prompt, offered once, dismissal remembered.
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstall = event;
  if (isStandalone()) return;
  pwaNote('install', 'Install CodeRelay for a faster, app-like experience.', [
    ['Install', true, async (card) => {
      await deferredInstall?.prompt();
      deferredInstall = null;
      card.remove();
    }],
  ]);
});

// iOS Safari has no install API; a one-time hint replaces it.
if (!isStandalone() && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  pwaNote('ios-install', 'Install CodeRelay on this device: tap Share, then "Add to Home Screen".', []);
}

window.addEventListener('online', () => { refreshStatus(); });
window.addEventListener('offline', () => {
  $('conn-dot').className = 'dot dot-bad';
  $('conn-text').textContent = 'No internet connection';
});

// Keep the composer visible above the mobile keyboard where the browser
// resizes the visual viewport instead of the layout.
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (document.activeElement === promptInput) {
      promptInput.scrollIntoView({ block: 'end' });
    }
  });
}

// ------------------------------------------------------------------ boot

(async function boot() {
  try {
    await api('/api/me');
    await showApp();
  } catch {
    // showLogin already invoked by the 401 path.
  }
  setInterval(refreshStatus, 30_000);
})();
