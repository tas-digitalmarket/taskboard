/* ──────────────────────────────────────────────────────────────────────────
   TaskBoard Dashboard — app.js
   Live task updates, countdowns, progress bars, status changes
   ────────────────────────────────────────────────────────────────────────── */

const API = '';
let allTasks = [];
let currentFilter = 'all';
let pollInterval = null;
let clockOffset = 0;

function getServerTime() {
  return Date.now() + clockOffset;
}

// ─── Status config ────────────────────────────────────────────────────────
const STATUS = {
  pending:   { label: 'در انتظار',     icon: '🔵', emoji: '⏳' },
  started:   { label: 'در حال انجام',  icon: '🟡', emoji: '▶️' },
  done:      { label: 'انجام شده',     icon: '🟢', emoji: '✅' },
  blocked:   { label: 'نیاز به کمک',   icon: '🔴', emoji: '🆘' },
  cancelled: { label: 'لغو شده',       icon: '⚫', emoji: '❌' },
};

// ─── Fetch tasks from API ─────────────────────────────────────────────────
async function fetchTasks() {
  try {
    const res = await fetch(`${API}/api/tasks`);
    const data = await res.json();
    if (data.ok) {
      if (data.serverTime) {
        clockOffset = data.serverTime - Date.now();
      }
      allTasks = data.tasks;
      updateAssigneeDropdown();
      renderDashboard();
      updateLastTime();
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

// ─── Compute progress ─────────────────────────────────────────────────────
function computeProgress(task) {
  const now = getServerTime();
  const start = new Date(task.createdAt).getTime();
  const due = new Date(task.dueAt).getTime();
  const total = Math.max(due - start, 1);
  const elapsed = Math.max(now - start, 0);
  const percent = Math.min(Math.floor((elapsed / total) * 100), 100);
  return { percent, isOverdue: now > due };
}

// ─── Format countdown ─────────────────────────────────────────────────────
function formatCountdown(dueAt) {
  const now = getServerTime();
  let ms = new Date(dueAt).getTime() - now;
  const overdue = ms < 0;
  if (overdue) ms = Math.abs(ms);

  const totalSec = Math.floor(ms / 1000);
  const days = Math.max(1, Math.ceil(totalSec / 86400));
  
  return { text: `${days} روز`, overdue };
}

// ─── Get initials from name ───────────────────────────────────────────────
function initials(name) {
  return (name || 'T').slice(0, 2).toUpperCase();
}

// ─── Render a single task card ────────────────────────────────────────────
function renderCard(task) {
  const prog = computeProgress(task);
  const countdown = formatCountdown(task.dueAt);
  const statusInfo = STATUS[task.status] || STATUS.pending;

  // Progress bar color
  let barClass = 'low';
  if (prog.isOverdue) barClass = 'overdue';
  else if (prog.percent >= 80) barClass = 'high';
  else if (prog.percent >= 50) barClass = 'medium';

  const card = document.createElement('div');
  card.className = `task-card status-${task.status}`;
  card.dataset.id = task.id;

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title">${escapeHtml(task.title)}</div>
      <div class="status-badge ${task.status}">
        ${statusInfo.icon} ${statusInfo.label}
      </div>
    </div>

    ${task.description ? `<div class="card-description">${escapeHtml(task.description)}</div>` : ''}

    <div class="card-assignee">
      <div class="assignee-avatar">${initials(task.assigneeName)}</div>
      <span class="assignee-name">👤 ${escapeHtml(task.assigneeName)}</span>
    </div>

    <div class="progress-section">
      <div class="progress-header">
        <span class="progress-label">پیشرفت زمانی</span>
        <span class="progress-pct" id="pct-${task.id}">${prog.percent}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill ${barClass}" id="bar-${task.id}" style="width:${prog.percent}%"></div>
      </div>
    </div>

    <div class="timer-section">
      <span class="timer-icon">⏱️</span>
      <span class="timer-text ${countdown.overdue ? 'overdue' : ''}" id="timer-${task.id}">
        ${countdown.overdue ? '⚠️ مهلت گذشته — ' : ''}${countdown.text}
      </span>
    </div>

    ${task.status !== 'done' && task.status !== 'cancelled' ? `
    <div class="card-footer">
      <select class="status-select" id="sel-${task.id}" onchange="updateStatus(${task.id}, this.value)">
        <option value="pending"   ${task.status==='pending'   ? 'selected':''}>⏳ در انتظار</option>
        <option value="started"   ${task.status==='started'   ? 'selected':''}>▶️ شروع شد</option>
        <option value="blocked"   ${task.status==='blocked'   ? 'selected':''}>🆘 نیاز به کمک</option>
        <option value="done"      ${task.status==='done'      ? 'selected':''}>✅ انجام شد</option>
        <option value="cancelled" ${task.status==='cancelled' ? 'selected':''}>❌ لغو</option>
      </select>
    </div>
    ` : `
    <div class="card-footer" style="justify-content:center">
      <span style="color:var(--text-muted);font-size:0.82rem">${statusInfo.emoji} ${statusInfo.label}</span>
    </div>
    `}
  `;

  return card;
}

// ─── Extract unique assignees ─────────────────────────────────────────────
function updateAssigneeDropdown() {
  const select = document.getElementById('filter-dashboard-assignee');
  if (!select) return;
  const currentVal = select.value;
  
  const assignees = new Set();
  allTasks.forEach(t => {
    if (t.assigneeName && t.assigneeName !== 'تیم') assignees.add(t.assigneeName);
  });
  
  select.innerHTML = '<option value="">همه افراد</option>';
  Array.from(assignees).sort().forEach(name => {
    select.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  });
  
  if (assignees.has(currentVal)) {
    select.value = currentVal;
  }
}

// ─── Render dashboard ─────────────────────────────────────────────────────
function renderDashboard() {
  updateCounts();

  const assigneeFilter = document.getElementById('filter-dashboard-assignee')?.value || '';

  const filtered = allTasks.filter(t => {
    const matchStatus = currentFilter === 'all' || t.status === currentFilter;
    const matchAssignee = assigneeFilter === '' || t.assigneeName === assigneeFilter;
    return matchStatus && matchAssignee;
  });

  const loading = document.getElementById('loading');
  const grid = document.getElementById('tasks-grid');
  const empty = document.getElementById('empty-state');

  loading.classList.add('hidden');

  if (filtered.length === 0) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.classList.remove('hidden');

  // Preserve existing cards, add/update
  const existingIds = new Set([...grid.querySelectorAll('.task-card')].map(c => Number(c.dataset.id)));
  const newIds = new Set(filtered.map(t => t.id));

  // Remove cards no longer in filter
  for (const id of existingIds) {
    if (!newIds.has(id)) {
      const card = grid.querySelector(`[data-id="${id}"]`);
      if (card) { card.style.opacity = '0'; setTimeout(() => card.remove(), 250); }
    }
  }

  // Add or update cards
  filtered.forEach((task, idx) => {
    const existing = grid.querySelector(`[data-id="${task.id}"]`);
    if (existing) {
      // Only update status badge and class, keep the card alive for timer
      existing.className = `task-card status-${task.status}`;
      // Update badge
      const badge = existing.querySelector('.status-badge');
      const sInfo = STATUS[task.status] || STATUS.pending;
      if (badge) {
        badge.className = `status-badge ${task.status}`;
        badge.textContent = `${sInfo.icon} ${sInfo.label}`;
      }
    } else {
      const card = renderCard(task);
      card.style.animationDelay = `${idx * 0.05}s`;
      grid.appendChild(card);
    }
  });
}

// ─── Tick: update all timers and progress bars live ───────────────────────
function tickTimers() {
  allTasks.forEach(task => {
    const timerEl = document.getElementById(`timer-${task.id}`);
    const barEl = document.getElementById(`bar-${task.id}`);
    const pctEl = document.getElementById(`pct-${task.id}`);
    if (!timerEl) return;

    const countdown = formatCountdown(task.dueAt);
    timerEl.textContent = countdown.overdue ? `⚠️ مهلت گذشته — ${countdown.text}` : countdown.text;
    timerEl.className = `timer-text ${countdown.overdue ? 'overdue' : ''}`;

    if (barEl && pctEl) {
      const prog = computeProgress(task);
      barEl.style.width = `${prog.percent}%`;
      pctEl.textContent = `${prog.percent}%`;

      let barClass = 'low';
      if (prog.isOverdue) barClass = 'overdue';
      else if (prog.percent >= 80) barClass = 'high';
      else if (prog.percent >= 50) barClass = 'medium';
      barEl.className = `progress-fill ${barClass}`;
    }
  });
}

// ─── Update status counts ─────────────────────────────────────────────────
function updateCounts() {
  const counts = { all: allTasks.length, pending: 0, started: 0, done: 0, blocked: 0, cancelled: 0 };
  allTasks.forEach(t => { if (counts[t.status] !== undefined) counts[t.status]++; });
  Object.entries(counts).forEach(([k, v]) => {
    const el = document.getElementById(`count-${k}`);
    if (el) el.textContent = v;
  });
}

// ─── Update last-refresh time ─────────────────────────────────────────────
function updateLastTime() {
  const el = document.getElementById('last-update');
  if (el) el.textContent = `آخرین بروزرسانی: ${new Date().toLocaleTimeString('fa-IR')}`;
}

// ─── Filter chips ─────────────────────────────────────────────────────────
function setupFilters() {
  document.querySelectorAll('.stat-chip[data-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      currentFilter = chip.dataset.filter;
      document.querySelectorAll('.stat-chip[data-filter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderDashboard();
    });
  });
}

// ─── Update task status ───────────────────────────────────────────────────
async function updateStatus(id, status) {
  try {
    const res = await fetch(`${API}/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (data.ok) {
      const idx = allTasks.findIndex(t => t.id === id);
      if (idx !== -1) allTasks[idx].status = status;
      renderDashboard();
      showToast('✅ وضعیت بروزرسانی شد', 'success');
    }
  } catch (err) {
    showToast('❌ خطا در بروزرسانی', 'error');
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Escape HTML ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str || ''));
  return div.innerHTML;
}

// ─── Init ─────────────────────────────────────────────────────────────────
setupFilters();
fetchTasks();

// Poll every 15 seconds for new tasks
pollInterval = setInterval(fetchTasks, 15_000);

// Update timers every second
setInterval(tickTimers, 1000);
