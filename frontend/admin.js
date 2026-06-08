/* ──────────────────────────────────────────────────────────────────────────
   TaskBoard Admin — admin.js
   Task creation, management, auth
   ────────────────────────────────────────────────────────────────────────── */

const API = '';
let adminPassword = '';
let allTasks = [];

const STATUS_LABELS = {
  pending:   { label: 'در انتظار',    icon: '⏳' },
  started:   { label: 'در حال انجام', icon: '▶️' },
  done:      { label: 'انجام شده',    icon: '✅' },
  blocked:   { label: 'نیاز به کمک',  icon: '🆘' },
  cancelled: { label: 'لغو شده',      icon: '❌' },
};

// ─── Auth ─────────────────────────────────────────────────────────────────
function doLogin() {
  const val = document.getElementById('auth-input').value.trim();
  if (!val) return;
  adminPassword = val;
  // Try a test request
  fetch(`${API}/api/tasks`, {
    headers: { 'x-admin-password': adminPassword }
  }).then(r => r.json()).then(data => {
    // We can verify by trying to POST (but easier: just store and see when we create)
    document.getElementById('auth-gate').classList.remove('active');
    document.getElementById('admin-main').style.display = 'block';
    loadTasks();
  }).catch(() => {
    document.getElementById('auth-error').classList.remove('hidden');
  });
}

function doLogout() {
  adminPassword = '';
  document.getElementById('auth-gate').classList.add('active');
  document.getElementById('admin-main').style.display = 'none';
  document.getElementById('auth-input').value = '';
}

// Login on Enter key
document.getElementById('auth-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// ─── Create Task ──────────────────────────────────────────────────────────
async function createTask(e) {
  e.preventDefault();

  const title     = document.getElementById('f-title').value.trim();
  const assignee  = document.getElementById('f-assignee').value.trim();
  const desc      = document.getElementById('f-desc').value.trim();
  const deadline  = document.getElementById('f-deadline').value.trim();
  const chatId    = document.getElementById('f-chatid').value.trim();

  if (!title || !deadline) {
    showToast('❌ عنوان و مهلت الزامی هستند', 'error');
    return;
  }

  // Show loading
  const btn = document.getElementById('submit-btn');
  const icon = document.getElementById('submit-icon');
  const label = document.getElementById('submit-label');
  btn.disabled = true;
  icon.textContent = '⏳';
  label.textContent = 'در حال ایجاد...';

  try {
    const res = await fetch(`${API}/api/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': adminPassword,
      },
      body: JSON.stringify({
        title,
        description: desc,
        assigneeName: assignee || 'تیم',
        assigneeChatId: chatId || null,
        deadline,
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      if (res.status === 401) {
        showToast('❌ رمز عبور اشتباه است', 'error');
        doLogout();
      } else {
        showToast(`❌ خطا: ${data.error}`, 'error');
      }
      return;
    }

    showToast('✅ وظیفه با موفقیت ساخته شد', 'success');
    resetForm();
    loadTasks();

  } catch (err) {
    showToast('❌ خطا در ارتباط با سرور', 'error');
  } finally {
    btn.disabled = false;
    icon.textContent = '✅';
    label.textContent = 'ساخت وظیفه';
  }
}

// ─── Reset form ───────────────────────────────────────────────────────────
function resetForm() {
  document.getElementById('task-form').reset();
}

// ─── Set deadline shortcut ────────────────────────────────────────────────
function setDeadline(value) {
  document.getElementById('f-deadline').value = value;
  document.getElementById('f-deadline').focus();
  document.getElementById('f-deadline').style.borderColor = 'var(--accent)';
  setTimeout(() => {
    document.getElementById('f-deadline').style.borderColor = '';
  }, 600);
}

// ─── Load all tasks ───────────────────────────────────────────────────────
async function loadTasks() {
  try {
    const res = await fetch(`${API}/api/tasks`);
    const data = await res.json();
    if (data.ok) {
      allTasks = data.tasks;
      renderAdminList();
    }
  } catch (err) {
    console.error(err);
  }
}

// ─── Render admin tasks list ──────────────────────────────────────────────
function renderAdminList() {
  const container = document.getElementById('admin-tasks-list');
  if (!allTasks.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:3rem">
        <div class="empty-icon">📭</div>
        <div class="empty-title">هنوز وظیفه‌ای ثبت نشده</div>
        <div class="empty-subtitle">از فرم بالا وظیفه جدید بسازید</div>
      </div>`;
    return;
  }

  const now = new Date();

  container.innerHTML = `
    <div style="overflow-x:auto; border-radius:var(--radius-lg); border:1px solid var(--border)">
      <table style="width:100%; border-collapse:collapse; font-size:0.88rem">
        <thead>
          <tr style="background:var(--bg-surface); border-bottom:1px solid var(--border)">
            <th style="padding:12px 16px; text-align:right; color:var(--text-muted); font-weight:600">عنوان</th>
            <th style="padding:12px 16px; text-align:right; color:var(--text-muted); font-weight:600">مسئول</th>
            <th style="padding:12px 16px; text-align:right; color:var(--text-muted); font-weight:600">وضعیت</th>
            <th style="padding:12px 16px; text-align:right; color:var(--text-muted); font-weight:600">مهلت</th>
            <th style="padding:12px 16px; text-align:right; color:var(--text-muted); font-weight:600">پیشرفت</th>
            <th style="padding:12px 16px; text-align:center; color:var(--text-muted); font-weight:600">عملیات</th>
          </tr>
        </thead>
        <tbody>
          ${allTasks.map(task => renderTaskRow(task, now)).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderTaskRow(task, now = new Date()) {
  const start  = new Date(task.createdAt).getTime();
  const due    = new Date(task.dueAt).getTime();
  const total  = Math.max(due - start, 1);
  const elapsed = Math.max(now.getTime() - start, 0);
  const percent = Math.min(Math.floor((elapsed / total) * 100), 100);
  const overdue = now.getTime() > due;
  const statusInfo = STATUS_LABELS[task.status] || STATUS_LABELS.pending;

  const dueDate = new Date(task.dueAt).toLocaleString('fa-IR', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  let barColor = '#10b981';
  if (overdue) barColor = '#ef4444';
  else if (percent >= 80) barColor = '#f59e0b';

  return `
    <tr style="border-bottom:1px solid var(--border); transition:background 0.2s"
        onmouseenter="this.style.background='var(--bg-card-hover)'"
        onmouseleave="this.style.background=''">
      <td style="padding:14px 16px">
        <div style="font-weight:600; color:var(--text-primary); margin-bottom:3px">${escapeHtml(task.title)}</div>
        ${task.description ? `<div style="color:var(--text-muted);font-size:0.78rem">${escapeHtml(task.description.slice(0,60))}${task.description.length>60?'...':''}</div>` : ''}
      </td>
      <td style="padding:14px 16px; color:var(--text-secondary)">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0">
            ${(task.assigneeName||'T').slice(0,2).toUpperCase()}
          </div>
          ${escapeHtml(task.assigneeName)}
        </div>
      </td>
      <td style="padding:14px 16px">
        <select style="background:var(--bg-input);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);padding:5px 8px;font-size:0.78rem;font-family:inherit;cursor:pointer;direction:rtl"
                onchange="updateTaskStatus(${task.id}, this.value)">
          <option value="pending"   ${task.status==='pending'   ? 'selected':''}>⏳ در انتظار</option>
          <option value="started"   ${task.status==='started'   ? 'selected':''}>▶️ شروع</option>
          <option value="blocked"   ${task.status==='blocked'   ? 'selected':''}>🆘 نیاز به کمک</option>
          <option value="done"      ${task.status==='done'      ? 'selected':''}>✅ انجام شده</option>
          <option value="cancelled" ${task.status==='cancelled' ? 'selected':''}>❌ لغو</option>
        </select>
      </td>
      <td style="padding:14px 16px; color:${overdue ? 'var(--color-blocked)' : 'var(--text-secondary)'}; font-size:0.82rem">
        ${dueDate}
        ${overdue ? '<br><span style="font-size:0.75rem;opacity:0.8">⚠️ مهلت گذشته</span>' : ''}
      </td>
      <td style="padding:14px 16px; min-width:120px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:5px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${percent}%;background:${barColor};border-radius:3px;transition:width 0.5s"></div>
          </div>
          <span style="font-size:0.75rem;font-weight:700;color:var(--text-muted);white-space:nowrap">${percent}%</span>
        </div>
      </td>
      <td style="padding:14px 16px; text-align:center">
        <button class="btn btn-danger btn-sm" onclick="deleteTask(${task.id}, '${escapeHtml(task.title)}')">🗑 حذف</button>
      </td>
    </tr>
  `;
}

// ─── Update task status ───────────────────────────────────────────────────
async function updateTaskStatus(id, status) {
  try {
    const res = await fetch(`${API}/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ وضعیت بروزرسانی شد', 'success');
      loadTasks();
    }
  } catch (err) {
    showToast('❌ خطا در بروزرسانی', 'error');
  }
}

// ─── Delete task ──────────────────────────────────────────────────────────
async function deleteTask(id, title) {
  if (!confirm(`آیا مطمئن هستید که می‌خواهید وظیفه «${title}» را حذف کنید؟`)) return;
  try {
    const res = await fetch(`${API}/api/tasks/${id}`, {
      method: 'DELETE',
      headers: { 'x-admin-password': adminPassword },
    });
    const data = await res.json();
    if (data.ok) {
      showToast('🗑 وظیفه حذف شد', 'info');
      loadTasks();
    } else if (res.status === 401) {
      showToast('❌ دسترسی نادارید', 'error');
    }
  } catch (err) {
    showToast('❌ خطا در حذف', 'error');
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
  div.appendChild(document.createTextNode(String(str || '')));
  return div.innerHTML;
}
