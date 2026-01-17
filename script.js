/*
 * 命をツナゲル - 照合アプリ
 *
 * このスクリプトはオフライン環境で動作する単一ページアプリです。
 * 役割:
 *   - ログイン認証（利用者と管理者）
 *   - SMS本文から職員IDを抽出し、マスタ情報と照合
 *   - 結果を救急隊に提示できるよう一覧表示
 *   - 管理者によるマスタデータの追加・編集・削除、パスワード変更、データのエクスポート/インポート
 */

(() => {
  'use strict';

  /** =========================
   *  DOM utilities
   *  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Escape HTML to prevent XSS when injecting content */
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Compute SHA-256 hash and return as hex string */
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = enc.encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Toast notification */
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => el.classList.remove('show'), 2000);
  }

  /** =========================
   *  Master data storage
   *  ========================= */
  const STORAGE_KEY = 'tsunageru_master_v1';
  let masterData = null;

  /** Load master data from localStorage, or initialise defaults if absent */
  async function loadMaster() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        masterData = JSON.parse(raw);
      }
    } catch (err) {
      console.warn('master data parse error', err);
    }
    if (!masterData || typeof masterData !== 'object') {
      masterData = {};
    }
    // Default values if not present
    if (!masterData.version) masterData.version = 1;
    if (!masterData.staff || !Array.isArray(masterData.staff)) {
      masterData.staff = [
        {
          id: 'S001',
          name: '佐藤 一郎',
          blood: 'O+',
          history: ['高血圧'],
          meds: ['降圧薬'],
          allergies: ['ピーナッツ'],
          doctor: '佐々木医院',
          contactRel: '妻',
          contactTel: '090-1234-5678'
        },
        {
          id: 'S002',
          name: '高橋 花子',
          blood: 'A+',
          history: ['喘息'],
          meds: ['吸入薬'],
          allergies: [],
          doctor: '高橋クリニック',
          contactRel: '夫',
          contactTel: '080-2345-6789'
        }
      ];
    }
    if (!masterData.userPasswordHash) {
      // Default user password: 0000
      masterData.userPasswordHash = await sha256Hex('0000');
    }
    if (!masterData.adminId) masterData.adminId = 'admin';
    if (!masterData.adminPasswordHash) {
      masterData.adminPasswordHash = await sha256Hex('admin');
    }
    saveMaster();
  }

  function saveMaster() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(masterData));
    } catch (err) {
      console.warn('master save error', err);
    }
  }

  /** =========================
   *  View switching
   *  ========================= */
  let currentView = 'view-login';
  const topbarTitle = $('#topbarTitle');
  const btnBack = $('#btnBack');
  const btnLogout = $('#btnLogout');

  function showView(id) {
    // Hide all
    $$('section.view').forEach((v) => v.classList.remove('active'));
    // Show desired view
    const el = $('#' + id);
    if (el) el.classList.add('active');
    currentView = id;
    // Adjust topbar
    if (id === 'view-login') {
      btnBack.style.display = 'none';
      btnLogout.style.display = 'none';
      topbarTitle.textContent = '命をツナゲル';
    } else {
      btnBack.style.display = '';
      btnLogout.style.display = '';
      if (id === 'view-input') {
        topbarTitle.textContent = '照合';
      } else if (id === 'view-result') {
        topbarTitle.textContent = '結果';
      } else if (id === 'view-admin') {
        topbarTitle.textContent = '管理';
      }
    }
  }

  btnBack.addEventListener('click', () => {
    if (currentView === 'view-input') {
      showView('view-login');
    } else if (currentView === 'view-result') {
      showView('view-input');
    } else if (currentView === 'view-admin') {
      showView('view-login');
    }
  });

  btnLogout.addEventListener('click', () => {
    showView('view-login');
  });

  /** =========================
   *  Login handlers
   *  ========================= */
  $('#btnUserLogin').addEventListener('click', async () => {
    const pw = $('#userPassword').value.trim();
    if (!pw) {
      toast('パスワードを入力してください');
      return;
    }
    const hash = await sha256Hex(pw);
    if (hash === masterData.userPasswordHash) {
      $('#userPassword').value = '';
      showView('view-input');
    } else {
      toast('パスワードが違います');
    }
  });

  $('#btnAdminLogin').addEventListener('click', async () => {
    const id = $('#adminId').value.trim();
    const pw = $('#adminPassword').value.trim();
    if (!id || !pw) {
      toast('IDとパスワードを入力してください');
      return;
    }
    const hash = await sha256Hex(pw);
    if (id === masterData.adminId && hash === masterData.adminPasswordHash) {
      $('#adminId').value = '';
      $('#adminPassword').value = '';
      buildStaffTable();
      showView('view-admin');
    } else {
      toast('IDまたはパスワードが違います');
    }
  });

  /** =========================
   *  Extract ID from SMS input
   *  ========================= */
  function extractIdFromSMS(text) {
    if (!text) return '';
    // Replace Japanese commas and newlines with spaces, then split
    const tokens = text
      .replace(/[\n\r]/g, ' ')
      .replace(/[、，]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    for (const token of tokens) {
      // Accept IDs that are alphanumeric/underscore/hyphen and at least 2 chars
      if (/^[A-Za-z0-9_-]{2,}$/.test(token)) {
        return token;
      }
    }
    return '';
  }

  $('#smsInput').addEventListener('input', (ev) => {
    const id = extractIdFromSMS(ev.target.value);
    $('#empId').value = id;
  });

  /** =========================
   *  Match button handler
   *  ========================= */
  $('#btnMatch').addEventListener('click', () => {
    const id = $('#empId').value.trim();
    if (!id) {
      toast('職員IDを入力してください');
      return;
    }
    const staff = masterData.staff.find((s) => s.id === id);
    if (!staff) {
      toast('該当する職員が見つかりません');
      return;
    }
    renderStaffInfo(staff);
    showView('view-result');
  });

  function renderStaffInfo(staff) {
    const container = $('#resultCard');
    const rows = [];
    rows.push(
      `<div class="info-row"><span>氏名</span><strong>${escapeHtml(
        staff.name
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>ID</span><strong>${escapeHtml(
        staff.id
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>血液型</span><strong>${escapeHtml(
        staff.blood || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>既往歴</span><strong>${escapeHtml(
        Array.isArray(staff.history) ? staff.history.join('、') : staff.history || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>薬剤情報</span><strong>${escapeHtml(
        Array.isArray(staff.meds) ? staff.meds.join('、') : staff.meds || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>アレルギー</span><strong>${escapeHtml(
        Array.isArray(staff.allergies)
          ? staff.allergies.join('、')
          : staff.allergies || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>かかりつけ医</span><strong>${escapeHtml(
        staff.doctor || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>緊急連絡先（続柄）</span><strong>${escapeHtml(
        staff.contactRel || '-'
      )}</strong></div>`
    );
    rows.push(
      `<div class="info-row"><span>緊急連絡先（電話番号）</span><strong>${escapeHtml(
        staff.contactTel || '-'
      )}</strong></div>`
    );
    container.innerHTML = rows.join('');
  }

  $('#btnResultBack').addEventListener('click', () => {
    showView('view-input');
  });

  /** =========================
   *  Admin functions
   *  ========================= */
  let editingIndex = -1;

  function buildStaffTable() {
    const tbody = $('#staffTable tbody');
    tbody.innerHTML = '';
    masterData.staff.forEach((s, idx) => {
      const tr = document.createElement('tr');
      const idTd = document.createElement('td');
      idTd.textContent = s.id;
      const nameTd = document.createElement('td');
      nameTd.textContent = s.name;
      const opTd = document.createElement('td');
      const btnEdit = document.createElement('button');
      btnEdit.textContent = '編集';
      btnEdit.className = 'edit';
      btnEdit.addEventListener('click', () => openStaffForm(idx));
      const btnDel = document.createElement('button');
      btnDel.textContent = '削除';
      btnDel.className = 'delete';
      btnDel.addEventListener('click', () => deleteStaff(idx));
      opTd.appendChild(btnEdit);
      opTd.appendChild(btnDel);
      tr.appendChild(idTd);
      tr.appendChild(nameTd);
      tr.appendChild(opTd);
      tbody.appendChild(tr);
    });
  }

  function openStaffForm(index) {
    // index == -1 for new
    editingIndex = index;
    const isNew = index === -1;
    $('#staffFormTitle').textContent = isNew ? '職員追加' : '職員編集';
    const form = $('#staffFormContainer');
    form.classList.remove('hidden');
    if (isNew) {
      $('#staffId').value = '';
      $('#staffName').value = '';
      $('#staffBlood').value = '';
      $('#staffHistory').value = '';
      $('#staffMeds').value = '';
      $('#staffAllergy').value = '';
      $('#staffDoctor').value = '';
      $('#staffContactRel').value = '';
      $('#staffContactTel').value = '';
    } else {
      const s = masterData.staff[index];
      $('#staffId').value = s.id;
      $('#staffName').value = s.name;
      $('#staffBlood').value = s.blood || '';
      $('#staffHistory').value = Array.isArray(s.history) ? s.history.join(',') : s.history || '';
      $('#staffMeds').value = Array.isArray(s.meds) ? s.meds.join(',') : s.meds || '';
      $('#staffAllergy').value = Array.isArray(s.allergies)
        ? s.allergies.join(',')
        : s.allergies || '';
      $('#staffDoctor').value = s.doctor || '';
      $('#staffContactRel').value = s.contactRel || '';
      $('#staffContactTel').value = s.contactTel || '';
    }
  }

  function closeStaffForm() {
    $('#staffFormContainer').classList.add('hidden');
    editingIndex = -1;
  }

  $('#btnAddStaff').addEventListener('click', () => openStaffForm(-1));
  $('#btnCancelStaff').addEventListener('click', () => closeStaffForm());
  $('#staffFormContainer').addEventListener('click', (e) => {
    if (e.target === $('#staffFormContainer')) {
      closeStaffForm();
    }
  });

  $('#btnSaveStaff').addEventListener('click', () => {
    const id = $('#staffId').value.trim();
    const name = $('#staffName').value.trim();
    if (!id || !name) {
      toast('IDと氏名は必須です');
      return;
    }
    const blood = $('#staffBlood').value.trim();
    const history = $('#staffHistory').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const meds = $('#staffMeds').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allergies = $('#staffAllergy').value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const doctor = $('#staffDoctor').value.trim();
    const contactRel = $('#staffContactRel').value.trim();
    const contactTel = $('#staffContactTel').value.trim();
    const obj = {
      id,
      name,
      blood,
      history,
      meds,
      allergies,
      doctor,
      contactRel,
      contactTel
    };
    if (editingIndex === -1) {
      // New: check duplicate
      const exists = masterData.staff.find((s) => s.id === id);
      if (exists) {
        toast('同じIDの職員が既に存在します');
        return;
      }
      masterData.staff.push(obj);
      toast('職員を追加しました');
    } else {
      masterData.staff[editingIndex] = obj;
      toast('職員を更新しました');
    }
    saveMaster();
    buildStaffTable();
    closeStaffForm();
  });

  function deleteStaff(index) {
    const s = masterData.staff[index];
    if (!s) return;
    if (!confirm(`「${s.name}」を削除しますか？`)) return;
    masterData.staff.splice(index, 1);
    saveMaster();
    buildStaffTable();
    toast('削除しました');
  }

  // Export master data as JSON file
  $('#btnExport').addEventListener('click', () => {
    const dataStr = JSON.stringify(masterData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tsunageru_master.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Import master data from JSON file
  $('#importFile').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const obj = JSON.parse(e.target.result);
        // Simple validation
        if (!obj || !Array.isArray(obj.staff)) {
          throw new Error('不正なデータです');
        }
        masterData = obj;
        saveMaster();
        buildStaffTable();
        toast('インポートしました');
      } catch (err) {
        toast('インポートに失敗しました');
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be selected again
    ev.target.value = '';
  });

  // Update user password
  $('#btnSetUserPassword').addEventListener('click', async () => {
    const newPw = $('#newUserPassword').value.trim();
    if (!newPw) {
      toast('新しい利用者パスワードを入力してください');
      return;
    }
    masterData.userPasswordHash = await sha256Hex(newPw);
    saveMaster();
    $('#newUserPassword').value = '';
    toast('利用者パスワードを更新しました');
  });

  // Update admin credentials
  $('#btnSetAdminCredentials').addEventListener('click', async () => {
    const newId = $('#newAdminId').value.trim();
    const newPw = $('#newAdminPassword').value.trim();
    if (!newId || !newPw) {
      toast('新しい管理者IDとパスワードを入力してください');
      return;
    }
    masterData.adminId = newId;
    masterData.adminPasswordHash = await sha256Hex(newPw);
    saveMaster();
    $('#newAdminId').value = '';
    $('#newAdminPassword').value = '';
    toast('管理者ID/パスワードを更新しました');
  });

  // Initialise on load
  document.addEventListener('DOMContentLoaded', async () => {
    await loadMaster();
    // Hide back/logout initially
    showView('view-login');
  });
})();