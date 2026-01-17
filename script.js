/* =========================================================
 * 命をツナゲル - Offline emergency lookup tool
 *
 * This script powers the Tsunageru application. It provides
 * a simple multi‑view single page interface: a login gate,
 * a home menu to paste SMS messages, an input screen to
 * extract a staff ID, a result screen that aggregates
 * personal medical information, and a settings area for
 * maintaining master records. All data is stored in
 * localStorage to honour the "offline only" requirement.
 *
 * Important: this example uses static passwords for the
 * demonstration. In a real deployment, password hashes
 * should be stored and verified securely.
 * ========================================================= */

(function() {
  'use strict';

  // Constants for localStorage keys
  const STORAGE_KEY = 'tsunageru_master_v1';
  const SESSION_KEY = 'tsunageru_session_v1';

  // Demo credentials (plain text). In production these would
  // be salted and hashed.
  const USER_PASS = '0000';
  const ADMIN_PASS = 'admin123';

  // References to DOM elements
  const views = {
    login: document.getElementById('view-login'),
    home: document.getElementById('view-home'),
    input: document.getElementById('view-input'),
    result: document.getElementById('view-result'),
    adminLogin: document.getElementById('view-admin-login'),
    settings: document.getElementById('view-settings'),
    edit: document.getElementById('view-edit'),
  };

  const topbar = document.getElementById('topbar');
  const btnBack = document.getElementById('btnBack');
  const btnRestartGlobal = document.getElementById('btnRestartGlobal');

  // Buttons on home
  const btnPasteSms = document.getElementById('btnPasteSms');
  const btnOpenSettings = document.getElementById('btnOpenSettings');

  // Login fields
  const loginPassword = document.getElementById('loginPassword');
  const btnLogin = document.getElementById('btnLogin');
  const adminPassword = document.getElementById('adminPassword');
  const btnAdminLogin = document.getElementById('btnAdminLogin');

  // Input and parse
  const inputSms = document.getElementById('inputSms');
  const btnParse = document.getElementById('btnParse');

  // Result view
  const resultCard = document.getElementById('resultCard');
  const btnResultBack = document.getElementById('btnResultBack');

  // Settings view
  const staffTable = document.getElementById('staffTable');
  const btnAddStaff = document.getElementById('btnAddStaff');
  const btnSettingsBack = document.getElementById('btnSettingsBack');

  // Edit view
  const editTitle = document.getElementById('editTitle');
  const editId = document.getElementById('editId');
  const editName = document.getElementById('editName');
  const editBlood = document.getElementById('editBlood');
  const editHistory = document.getElementById('editHistory');
  const editMedications = document.getElementById('editMedications');
  const editAllergies = document.getElementById('editAllergies');
  const editDoctor = document.getElementById('editDoctor');
  const editContactName = document.getElementById('editContactName');
  const editContactPhone = document.getElementById('editContactPhone');
  const btnSaveStaff = document.getElementById('btnSaveStaff');
  const btnEditBack = document.getElementById('btnEditBack');

  // Toast
  const toastEl = document.getElementById('toast');
  let toastTimer;

  // Navigation stack for back button
  const navStack = [];

  /**
   * Show a view by id and hide others. Pushes the previous view onto
   * the navigation stack unless explicitly told not to.
   */
  function showView(name, push = true) {
    Object.keys(views).forEach((k) => {
      views[k].classList.remove('active');
    });
    views[name].classList.add('active');
    if (push) {
      navStack.push(name);
    }
    // Hide topbar during login/admin login
    if (name === 'login' || name === 'adminLogin') {
      topbar.style.display = 'none';
    } else {
      topbar.style.display = 'flex';
    }
  }

  /**
   * Display a toast message.
   */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2000);
  }

  /**
   * Load master data from localStorage. If none exists, create a
   * small default set. The master is an object with a 'staff' array.
   */
  function loadMaster() {
    try {
      const json = localStorage.getItem(STORAGE_KEY);
      if (json) {
        return JSON.parse(json);
      }
    } catch (e) {
      console.warn('Failed to parse master data:', e);
    }
    // Default sample data
    const sample = {
      staff: [
        {
          id: 'S001',
          name: '佐藤 一郎',
          blood: 'O+',
          history: ['高血圧'],
          medications: ['降圧剤'],
          allergies: ['ピーナッツ'],
          doctor: '山田 医師',
          contact: { name: '妻', phone: '090-1234-5678' },
        },
        {
          id: 'S002',
          name: '高橋 花子',
          blood: 'A−',
          history: ['糖尿病'],
          medications: ['インスリン'],
          allergies: [],
          doctor: '鈴木 医師',
          contact: { name: '夫', phone: '080-9876-5432' },
        },
      ],
    };
    saveMaster(sample);
    return sample;
  }

  /**
   * Save master data back to localStorage.
   */
  function saveMaster(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  /**
   * Extract an ID from the pasted SMS text. We attempt to find
   * sequences that follow "ID" or "職員ID" patterns, or fall back
   * to the first alphanumeric token. Returns null if nothing is
   * found. The returned ID string is trimmed.
   */
  function extractIdFromSms(text) {
    if (!text) return null;
    // Normalize full-width colon to half-width
    const s = String(text).replace(/：/g, ':');
    // Try to match "ID:XXXX"
    let m = s.match(/(?:ID|職員ID)\s*[:\s]\s*([A-Za-z0-9]+)/i);
    if (m) {
      return m[1].trim();
    }
    // Otherwise, take the first token of at least 3 alphanumeric chars
    m = s.match(/([A-Za-z0-9]{3,})/);
    return m ? m[1].trim() : null;
  }

  /**
   * Render the result card for a given staff record.
   */
  function renderResult(staff) {
    if (!staff) {
      resultCard.innerHTML = '<p>該当する職員が見つかりませんでした。</p>';
      return;
    }
    const esc = (x) => String(x || '-');
    const list = (arr) => (arr && arr.length ? arr.map(esc).join('、') : '-');
    // Determine if fields should be highlighted. Any non-empty array is considered important.
    const hasHistory = staff.history && staff.history.length;
    const hasMedications = staff.medications && staff.medications.length;
    const hasAllergies = staff.allergies && staff.allergies.length;
    const html = `
      <div class="summary-row"><span>氏名</span><strong>${esc(staff.name)}</strong></div>
      <div class="summary-row"><span>職員ID</span><strong>${esc(staff.id)}</strong></div>
      <div class="summary-row"><span>血液型</span><strong>${esc(staff.blood)}</strong></div>
      <div class="summary-row"><span>既往歴</span><strong class="${hasHistory ? 'alert' : ''}">${list(staff.history)}</strong></div>
      <div class="summary-row"><span>薬剤情報</span><strong class="${hasMedications ? 'alert' : ''}">${list(staff.medications)}</strong></div>
      <div class="summary-row"><span>アレルギー</span><strong class="${hasAllergies ? 'alert' : ''}">${list(staff.allergies)}</strong></div>
      <div class="summary-row"><span>かかりつけ医</span><strong>${esc(staff.doctor)}</strong></div>
      <div class="summary-row"><span>緊急連絡先</span><strong>${esc(staff.contact?.name)} (${esc(staff.contact?.phone)})</strong></div>
    `;
    resultCard.innerHTML = html;
  }

  /**
   * Populate the staff table in settings view.
   */
  function populateStaffTable() {
    const master = loadMaster();
    const rows = master.staff.map((s, idx) => {
      return `
        <tr>
          <td>${escapeHtml(s.id)}</td>
          <td>${escapeHtml(s.name)}</td>
          <td><button class="edit-btn" data-index="${idx}">編集</button></td>
          <td><button class="delete-btn" data-index="${idx}">削除</button></td>
        </tr>`;
    });
    staffTable.innerHTML = `
      <thead>
        <tr><th>ID</th><th>氏名</th><th colspan="2">操作</th></tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    `;
    // Attach event listeners for edit/delete
    staffTable.querySelectorAll('.edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.getAttribute('data-index'), 10);
        openEdit(index);
      });
    });
    staffTable.querySelectorAll('.delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = parseInt(btn.getAttribute('data-index'), 10);
        if (confirm('この職員を削除しますか？')) {
          const data = loadMaster();
          data.staff.splice(index, 1);
          saveMaster(data);
          populateStaffTable();
          toast('削除しました');
        }
      });
    });
  }

  /**
   * Open edit view for a given staff index, or for adding a new record
   * if index is null.
   */
  function openEdit(index) {
    const master = loadMaster();
    if (index != null) {
      const s = master.staff[index];
      editTitle.textContent = '職員編集';
      editId.value = s.id;
      editName.value = s.name;
      editBlood.value = s.blood;
      editHistory.value = s.history ? s.history.join('、') : '';
      editMedications.value = s.medications ? s.medications.join('、') : '';
      editAllergies.value = s.allergies ? s.allergies.join('、') : '';
      editDoctor.value = s.doctor || '';
      editContactName.value = s.contact?.name || '';
      editContactPhone.value = s.contact?.phone || '';
      btnSaveStaff.dataset.index = index;
    } else {
      editTitle.textContent = '職員追加';
      editId.value = '';
      editName.value = '';
      editBlood.value = '';
      editHistory.value = '';
      editMedications.value = '';
      editAllergies.value = '';
      editDoctor.value = '';
      editContactName.value = '';
      editContactPhone.value = '';
      btnSaveStaff.dataset.index = '';
    }
    showView('edit');
  }

  /**
   * Escape HTML entities to prevent injection when rendering table.
   */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  /**
   * Save (add/update) a staff record from the edit form.
   */
  function saveStaff() {
    const id = editId.value.trim();
    const name = editName.value.trim();
    if (!id || !name) {
      toast('IDと氏名は必須です');
      return;
    }
    const blood = editBlood.value.trim();
    const history = editHistory.value.split(/[,、]\s*/).filter((s) => s);
    const meds = editMedications.value.split(/[,、]\s*/).filter((s) => s);
    const allergies = editAllergies.value.split(/[,、]\s*/).filter((s) => s);
    const doctor = editDoctor.value.trim();
    const contactName = editContactName.value.trim();
    const contactPhone = editContactPhone.value.trim();
    const data = loadMaster();
    const idxStr = btnSaveStaff.dataset.index;
    // If an index attribute is present and not empty, update existing; otherwise treat as new
    if (idxStr != null && idxStr !== '') {
      const index = parseInt(idxStr, 10);
      data.staff[index] = {
        id,
        name,
        blood,
        history,
        medications: meds,
        allergies,
        doctor,
        contact: { name: contactName, phone: contactPhone },
      };
      saveMaster(data);
      populateStaffTable();
      showView('settings');
      toast('保存しました');
    } else {
      // New record
      data.staff.push({
        id,
        name,
        blood,
        history,
        medications: meds,
        allergies,
        doctor,
        contact: { name: contactName, phone: contactPhone },
      });
      saveMaster(data);
      // Immediately display the result for the newly added record
      const newRec = data.staff[data.staff.length - 1];
      renderResult(newRec);
      showView('result');
      toast('保存しました');
    }
  }

  /**
   * Initialize event handlers and load initial state.
   */
  function init() {
    // Back button: go to previous view
    btnBack.addEventListener('click', () => {
      navStack.pop(); // current view
      const prev = navStack.pop() || 'home';
      showView(prev);
    });
    // Restart: return to home and clear stack
    btnRestartGlobal.addEventListener('click', () => {
      navStack.length = 0;
      showView('home');
    });
    // Login
    btnLogin.addEventListener('click', () => {
      const pass = loginPassword.value.trim();
      if (pass === USER_PASS) {
        loginPassword.value = '';
        navStack.length = 0;
        showView('home');
      } else {
        toast('パスワードが違います');
      }
    });
    // Show input view
    btnPasteSms.addEventListener('click', () => {
      inputSms.value = '';
      showView('input');
    });
    // Parse SMS
    btnParse.addEventListener('click', () => {
      const text = inputSms.value;
      const id = extractIdFromSms(text);
      if (!id) {
        toast('職員IDが検出できませんでした');
        return;
      }
      const master = loadMaster();
      const staff = master.staff.find((s) => s.id === id);
      if (staff) {
        renderResult(staff);
        showView('result');
      } else {
        // No match found: open manual entry with ID prefilled
        openEdit(null);
        editId.value = id;
        // Try to extract name pattern "名前" or "氏名" if present
        const nameMatch = text.match(/(?:名前|氏名)\s*[:：]\s*([\p{L}\p{N}\s]+)/u);
        if (nameMatch) {
          editName.value = nameMatch[1].trim();
        }
        toast('未登録のIDです。情報を入力してください');
      }
    });
    // Result back
    btnResultBack.addEventListener('click', () => {
      showView('home');
    });
    // Open settings (requires admin login)
    btnOpenSettings.addEventListener('click', () => {
      adminPassword.value = '';
      showView('adminLogin');
    });
    // Admin login
    btnAdminLogin.addEventListener('click', () => {
      const pass = adminPassword.value.trim();
      if (pass === ADMIN_PASS) {
        populateStaffTable();
        showView('settings');
      } else {
        toast('管理パスワードが違います');
      }
    });
    // Settings back
    btnSettingsBack.addEventListener('click', () => {
      showView('home');
    });
    // Add staff
    btnAddStaff.addEventListener('click', () => {
      openEdit(null);
    });
    // Save staff
    btnSaveStaff.addEventListener('click', () => {
      saveStaff();
    });
    // Edit cancel/back
    btnEditBack.addEventListener('click', () => {
      showView('settings');
    });
    // Preload master
    loadMaster();
  }

  // Kick off after DOM loaded
  document.addEventListener('DOMContentLoaded', init);
})();