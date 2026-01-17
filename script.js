/*
 * 命をツナゲル - MVP 実装
 *
 * このスクリプトは、安全課向けに職員マスタを暗号化して端末内に保存し、
 * IDとの照合および管理画面での登録・編集を提供します。
 * 閲覧はパスワード不要ですが、編集には強力なパスワードが必要です。
 */

(() => {
  'use strict';
  // DOM refs
  const views = {
    home: document.getElementById('view-home'),
    result: document.getElementById('view-result'),
    adminGate: document.getElementById('view-admin-gate'),
    adminPanel: document.getElementById('view-admin-panel')
  };
  const topbar = document.getElementById('topbar');
  const btnBack = document.getElementById('btnBack');
  const btnHome = document.getElementById('btnHome');
  const btnSearch = document.getElementById('btnSearch');
  const idInput = document.getElementById('idInput');
  const resultCard = document.getElementById('resultCard');
  const btnResultBack = document.getElementById('btnResultBack');
  const btnAdmin = document.getElementById('btnAdmin');

  // Admin gate elements
  const adminGate = document.getElementById('adminGate');
  const adminFirst = document.getElementById('adminFirst');
  const adminLogin = document.getElementById('adminLogin');
  const btnSetPass = document.getElementById('btnSetPass');
  const btnAdminLogin = document.getElementById('btnAdminLogin');
  const newPass1 = document.getElementById('newPass1');
  const newPass2 = document.getElementById('newPass2');
  const loginPass = document.getElementById('loginPass');
  const loginMsg = document.getElementById('loginMsg');
  const adminGateDesc = document.getElementById('adminGateDesc');

  // Admin panel elements
  const staffListEl = document.getElementById('staffList');
  const staffForm = document.getElementById('staffForm');
  const formTitle = document.getElementById('formTitle');
  const formId = document.getElementById('formId');
  const formName = document.getElementById('formName');
  const formBlood = document.getElementById('formBlood');
  const formHistory = document.getElementById('formHistory');
  const formMedication = document.getElementById('formMedication');
  const formAllergy = document.getElementById('formAllergy');
  const formDoctor = document.getElementById('formDoctor');
  const formEmergencyRel = document.getElementById('formEmergencyRel');
  const formEmergencyTel = document.getElementById('formEmergencyTel');
  const btnSaveStaff = document.getElementById('btnSaveStaff');
  const btnDeleteStaff = document.getElementById('btnDeleteStaff');
  const btnCancelEdit = document.getElementById('btnCancelEdit');

  const toast = document.getElementById('toast');

  // State
  let masterList = [];
  let masterKey;
  let adminPassHash = localStorage.getItem('adminPassHash') || null;
  let adminFailCount = 0;
  let adminLockoutUntil = 0;
  let editingIndex = null;
  let lockTimerId = null;
  const LOCK_DURATION = 90 * 1000; // 90 seconds

  /**
   * Utility: show toast message for a short duration
   */
  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
  }

  /**
   * Switch visible view
   */
  function showView(viewName) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    if (views[viewName]) {
      views[viewName].classList.add('active');
    }
    // Show/hide topbar: hide on home
    if (viewName === 'home') {
      topbar.style.display = 'none';
    } else {
      topbar.style.display = 'flex';
    }
  }

  /**
   * Reset auto-lock timer
   */
  function resetLockTimer() {
    clearTimeout(lockTimerId);
    lockTimerId = setTimeout(onAutoLock, LOCK_DURATION);
  }

  /**
   * Called when auto lock triggers
   */
  function onAutoLock() {
    // If on result page, go back home
    if (views.result.classList.contains('active')) {
      showView('home');
    }
    // If admin panel open, lock it and require login again
    if (views.adminPanel.classList.contains('active')) {
      logoutAdmin();
      showView('adminGate');
      prepareAdminGate();
    }
  }

  /**
   * Extract ID string from pasted text
   */
  function extractIdFromText(text) {
    if (!text) return '';
    // Try to find pattern like ID:xxxx or A-00123 etc.
    const idPattern = /([A-Za-z]\w*[-]?[0-9]{1,6})/;
    const match = text.match(idPattern);
    if (match) {
      return match[1].trim();
    }
    return text.trim();
  }

  /**
   * Generate or load AES-GCM key for encryption
   */
  async function initMasterKey() {
    const keyB64 = localStorage.getItem('masterKey');
    if (!keyB64) {
      const key = await crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt']);
      const raw = await crypto.subtle.exportKey('raw', key);
      const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
      localStorage.setItem('masterKey', b64);
      masterKey = key;
    } else {
      const raw = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
      masterKey = await crypto.subtle.importKey('raw', raw, {name:'AES-GCM'}, true, ['encrypt','decrypt']);
    }
  }

  /**
   * Encrypt arbitrary JSON-serializable data with masterKey
   */
  async function encryptData(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify(obj));
    const cipher = await crypto.subtle.encrypt({name:'AES-GCM', iv}, masterKey, encoded);
    return {
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(cipher))
    };
  }

  /**
   * Decrypt previously encrypted data
   */
  async function decryptData(payload) {
    try {
      const iv = new Uint8Array(payload.iv);
      const data = new Uint8Array(payload.data);
      const decrypted = await crypto.subtle.decrypt({name:'AES-GCM', iv}, masterKey, data);
      const text = new TextDecoder().decode(decrypted);
      return JSON.parse(text);
    } catch (e) {
      console.error('decrypt failed', e);
      return {};
    }
  }

  /**
   * Load master list from localStorage
   */
  async function loadMaster() {
    const stored = localStorage.getItem('masterData');
    if (stored) {
      try {
        const enc = JSON.parse(stored);
        const data = await decryptData(enc);
        if (Array.isArray(data.list)) {
          masterList = data.list;
        } else {
          masterList = [];
        }
      } catch (e) {
        masterList = [];
      }
    } else {
      masterList = [];
    }
  }

  /**
   * Save master list to localStorage
   */
  async function saveMaster() {
    const payload = await encryptData({list: masterList});
    localStorage.setItem('masterData', JSON.stringify(payload));
  }

  /**
   * Render staff list in admin panel
   */
  function renderStaffList() {
    staffListEl.innerHTML = '';
    if (masterList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'small';
      empty.textContent = '登録されている職員がいません。';
      staffListEl.appendChild(empty);
      return;
    }
    masterList.forEach((rec, idx) => {
      const row = document.createElement('div');
      row.className = 'staff-item';
      const label = document.createElement('div');
      label.textContent = `${rec.id}  ${rec.name}`;
      const btn = document.createElement('button');
      btn.textContent = '編集';
      btn.addEventListener('click', () => {
        editRecord(idx);
      });
      row.appendChild(label);
      row.appendChild(btn);
      staffListEl.appendChild(row);
    });
  }

  /**
   * Populate form with record for editing
   */
  function editRecord(index) {
    const rec = masterList[index];
    editingIndex = index;
    formTitle.textContent = '編集';
    formId.value = rec.id;
    formName.value = rec.name;
    formBlood.value = rec.blood || '';
    formHistory.value = rec.history || '';
    formMedication.value = rec.medication || '';
    formAllergy.value = rec.allergy || '';
    formDoctor.value = rec.doctor || '';
    formEmergencyRel.value = rec.emergencyRel || '';
    formEmergencyTel.value = rec.emergencyTel || '';
    btnDeleteStaff.classList.remove('hidden');
    showView('adminPanel');
  }

  /**
   * Reset form to empty for adding new record
   */
  function resetForm() {
    editingIndex = null;
    formTitle.textContent = '新規追加';
    staffForm.reset();
    btnDeleteStaff.classList.add('hidden');
  }

  /**
   * Search for record and display result
   */
  function searchRecord() {
    const text = idInput.value;
    const id = extractIdFromText(text);
    if (!id) {
      showToast('IDを入力してください');
      return;
    }
    const record = masterList.find(r => r.id.trim() === id);
    if (!record) {
      showToast('該当する職員が見つかりません');
      return;
    }
    // Populate result card
    resultCard.innerHTML = '';
    const fields = [
      {label:'氏名', value: record.name},
      {label:'職員ID', value: record.id},
      {label:'血液型', value: record.blood || '-'},
      {label:'既往歴', value: record.history || '-'},
      {label:'薬剤情報', value: record.medication || '-'},
      {label:'アレルギー', value: record.allergy || '-'},
      {label:'かかりつけ医', value: record.doctor || '-'},
      {label:'緊急連絡先（続柄）', value: record.emergencyRel || '-'},
      {label:'緊急連絡先（電話番号）', value: record.emergencyTel || '-'}
    ];
    fields.forEach(f => {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('div');
      lab.className = 'label';
      lab.textContent = f.label;
      const val = document.createElement('div');
      val.className = 'value';
      val.textContent = f.value;
      row.appendChild(lab);
      row.appendChild(val);
      resultCard.appendChild(row);
    });
    showView('result');
  }

  /**
   * Hash password using SHA-256
   */
  async function hashPass(pass) {
    const data = new TextEncoder().encode(pass);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  /**
   * Prepare admin gate (decide whether to show setup or login)
   */
  function prepareAdminGate() {
    if (!adminPassHash) {
      adminGateDesc.textContent = 'パスワードを設定してください（12文字以上）';
      adminFirst.classList.remove('hidden');
      adminLogin.classList.add('hidden');
    } else {
      adminGateDesc.textContent = 'パスワードで保護されています。';
      adminFirst.classList.add('hidden');
      adminLogin.classList.remove('hidden');
    }
    loginMsg.textContent = '';
    newPass1.value = '';
    newPass2.value = '';
    loginPass.value = '';
  }

  /**
   * Log out admin
   */
  function logoutAdmin() {
    // Clear editing state and form
    resetForm();
  }

  /**
   * Initialise event listeners
   */
  function setupEventListeners() {
    // Basic navigation buttons
    btnBack.addEventListener('click', () => {
      // Back always goes to home
      showView('home');
    });
    btnHome.addEventListener('click', () => {
      showView('home');
    });
    // Search button
    btnSearch.addEventListener('click', () => {
      resetLockTimer();
      searchRecord();
    });
    // Result back
    btnResultBack.addEventListener('click', () => {
      showView('home');
    });
    // Admin button on home
    btnAdmin.addEventListener('click', () => {
      showView('adminGate');
      prepareAdminGate();
    });
    // Set password
    btnSetPass.addEventListener('click', async () => {
      const p1 = newPass1.value.trim();
      const p2 = newPass2.value.trim();
      if (p1.length < 12) {
        showToast('パスワードは12文字以上にしてください');
        return;
      }
      if (p1 !== p2) {
        showToast('パスワードが一致しません');
        return;
      }
      adminPassHash = await hashPass(p1);
      localStorage.setItem('adminPassHash', adminPassHash);
      adminFailCount = 0;
      prepareAdminGate();
      showToast('パスワードを設定しました');
    });
    // Admin login
    btnAdminLogin.addEventListener('click', async () => {
      if (Date.now() < adminLockoutUntil) {
        loginMsg.textContent = '一定回数失敗したためロックされています。少し待ってから再試行してください。';
        return;
      }
      const pass = loginPass.value;
      const hash = await hashPass(pass);
      if (hash === adminPassHash) {
        adminFailCount = 0;
        loginMsg.textContent = '';
        showView('adminPanel');
        renderStaffList();
        resetForm();
      } else {
        adminFailCount++;
        const remaining = 3 - adminFailCount;
        loginMsg.textContent = `パスワードが違います。残り${remaining}回。`;
        if (adminFailCount >= 3) {
          adminLockoutUntil = Date.now() + 60000; // lock 60 seconds
          adminFailCount = 0;
          loginMsg.textContent = 'ロックアウトされました。1分後に再試行してください。';
        }
      }
    });
    // Staff form submit
    staffForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rec = {
        id: formId.value.trim(),
        name: formName.value.trim(),
        blood: formBlood.value.trim(),
        history: formHistory.value.trim(),
        medication: formMedication.value.trim(),
        allergy: formAllergy.value.trim(),
        doctor: formDoctor.value.trim(),
        emergencyRel: formEmergencyRel.value.trim(),
        emergencyTel: formEmergencyTel.value.trim()
      };
      if (!rec.id || !rec.name) {
        showToast('IDと氏名は必須です');
        return;
      }
      if (editingIndex === null) {
        // Add new
        if (masterList.some(r => r.id === rec.id)) {
          showToast('同じIDが既に存在します');
          return;
        }
        masterList.push(rec);
      } else {
        masterList[editingIndex] = rec;
      }
      await saveMaster();
      renderStaffList();
      resetForm();
      showToast('保存しました');
    });
    // Delete staff
    btnDeleteStaff.addEventListener('click', async () => {
      if (editingIndex === null) return;
      if (!confirm('本当に削除しますか？')) return;
      masterList.splice(editingIndex, 1);
      await saveMaster();
      renderStaffList();
      resetForm();
      showToast('削除しました');
    });
    // Cancel edit
    btnCancelEdit.addEventListener('click', () => {
      resetForm();
    });
    // Global activity listeners to reset auto lock
    ['click','keypress','touchstart'].forEach(evt => {
      document.addEventListener(evt, resetLockTimer, {passive:true});
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        onAutoLock();
      }
    });
  }

  /**
   * Initialize application
   */
  async function init() {
    await initMasterKey();
    await loadMaster();
    setupEventListeners();
    showView('home');
    resetLockTimer();
  }
  // Kick-off
  init().catch(console.error);
})();