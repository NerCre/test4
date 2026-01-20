/* =========================================================
   命をツナゲル - Vanilla JS single-page app (offline)
   - 状況 → 所属 → 対象者 → (部位) → 判断結果 → メール作成
   - マスタは localStorage に保存（パスワード付 管理画面で変更）
   ========================================================= */

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configure QrScanner global settings
  // ---------------------------------------------------------------------------
  // If the QrScanner library is loaded, set the worker path to the CDN version.
  // This ensures that the decoding worker script is found when scanning QR codes.
  if (typeof QrScanner !== 'undefined') {
    try {
      QrScanner.WORKER_PATH = 'https://unpkg.com/qr-scanner/qr-scanner-worker.min.js';
    } catch {
      // ignore if setter is unsupported
    }
  }

  const STORAGE_KEY = 'inochi_master_v1';

  // グローバルに次のSMS送信後に実行するコールバックを保持します。
  // 緊急入力画面で「救急車を呼ぶ」後のSMS発信や、直接SMS発信した際に
  // 次にどの処理を実行するかを制御します。デフォルトは null です。
  window.__afterSmsAction = null;
  const SESSION_KEY = 'inochi_session_v1';

  /** =========================
   *  Utilities
   *  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function nowIsoLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      ' ' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => el.classList.remove('show'), 1800);
  }

  function uuid() {
    return 'id-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(16);
  }

  function normalizeEmails(str) {
    return String(str || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  }


  // --- QR parsing helpers ----------------------------------------------------
  // The app originally required an exact match between the scanned QR string and
  // master.staff[].qr / master.locations[].qr.
  // In practice, QR payloads often contain decorated text (e.g. "職員ID：S001 氏名：..."),
  // or JSON. These helpers make the app tolerant: we first try exact QR match,
  // then fall back to extracting staffId / location name and matching by master id/name.

  function normalizeQrString(input) {
    return String(input || '')
      .replace(/\u3000/g, ' ') // full-width space
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
  }

  function compactQrString(input) {
    return normalizeQrString(input).replace(/\s+/g, '');
  }

  function tryParseJsonObject(input) {
    const t = normalizeQrString(input);
    if (!t) return null;
    if (!(t.startsWith('{') && t.endsWith('}'))) return null;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') return obj;
      return null;
    } catch {
      return null;
    }
  }

  function parseStaffQr(raw) {
    const rawNorm = normalizeQrString(raw);
    const obj = tryParseJsonObject(rawNorm);

    let staffId = null;
    let name = null;

    if (obj) {
      staffId = obj.staffId || obj.staff_id || obj.employeeId || obj.employee_id || obj.id || obj.empId || null;
      name = obj.name || obj.staffName || obj.fullName || null;
    }

    // Pipe-delimited legacy format (e.g. "STAFF｜S001｜佐藤 一郎" or "STAFF|S001|佐藤 一郎")
    // This is common for simple demo QR codes.
    if ((!staffId || !name) && /[\|｜]/.test(rawNorm)) {
      const parts = rawNorm.split(/[\|｜]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const p0 = parts[0].toUpperCase();
        const looksLikeStaff = p0.includes('STAFF') || p0.includes('職員') || p0.includes('社員');
        if (looksLikeStaff) {
          if (!staffId && parts[1]) staffId = String(parts[1]).trim().toUpperCase();
          if (!name && parts[2]) name = String(parts[2]).trim();
        }
      }
    }

    // Common decorated formats
    if (!staffId) {
      const m1 = rawNorm.match(/\bS\d{3,6}\b/i);
      if (m1) staffId = String(m1[0]).toUpperCase();
    }
    if (!staffId) {
      const m2 = rawNorm.match(/(?:職員\s*ID|職員ID|社員\s*ID|社員ID|ID)\s*[:：]?\s*([A-Za-z0-9_-]+)/i);
      if (m2) staffId = String(m2[1]).trim().toUpperCase();
    }

    if (!name) {
      const m3 = rawNorm.match(/(?:氏名|名前|name)\s*[:：]\s*([^\n]+)/i);
      if (m3) name = String(m3[1]).trim();
    }

    return { raw: rawNorm, staffId, name, obj };
  }

  function parseLocationQr(raw) {
    const rawNorm = normalizeQrString(raw);
    const obj = tryParseJsonObject(rawNorm);

    let name = null;
    let locationId = null;

    if (obj) {
      locationId = obj.locationId || obj.location_id || obj.placeId || obj.place_id || obj.locId || obj.id || null;
      name = obj.name || obj.location || obj.place || obj.placeName || null;
    }

    if (!name) {
      const m1 = rawNorm.match(/\bLOC\s*[:：]\s*([^\n]+)/i);
      if (m1) name = String(m1[1]).trim();
    }
    if (!name) {
      const m2 = rawNorm.match(/(?:場所|現場|ロケーション|location)\s*[:：]\s*([^\n]+)/i);
      if (m2) name = String(m2[1]).trim();
    }

    // If it's a single-line plain text QR, treat that as a name candidate
    if (!name && rawNorm && !rawNorm.includes('\n')) {
      name = rawNorm;
    }

    return { raw: rawNorm, name, locationId, obj };
  }

  function findStaffFromQr(raw) {
    const info = parseStaffQr(raw);
    const rawNorm = info.raw;
    const rawCompact = compactQrString(rawNorm);

    const staff = master.staff || [];

    // 1) exact QR match
    let hit = staff.find((s) => normalizeQrString(s.qr) && normalizeQrString(s.qr) === rawNorm);
    if (!hit) hit = staff.find((s) => normalizeQrString(s.qr) && compactQrString(s.qr) === rawCompact);

    // 2) match by extracted staffId (master id)
    if (!hit && info.staffId) {
      const sid = String(info.staffId).toUpperCase();
      hit = staff.find((s) => String(s.id || '').toUpperCase() === sid);
    }

    // 3) match by extracted name
    if (!hit && info.name) {
      const n = normalizeQrString(info.name);
      hit = staff.find((s) => normalizeQrString(s.name) === n);
    }

    return { hit, info };
  }

  function findLocationFromQr(raw) {
    const info = parseLocationQr(raw);
    const rawNorm = info.raw;
    const rawCompact = compactQrString(rawNorm);

    const locations = master.locations || [];

    // 1) exact QR match
    let hit = locations.find((l) => normalizeQrString(l.qr) && normalizeQrString(l.qr) === rawNorm);
    if (!hit) hit = locations.find((l) => normalizeQrString(l.qr) && compactQrString(l.qr) === rawCompact);

    // 2) match by extracted name
    if (!hit && info.name) {
      const n = normalizeQrString(info.name);
      hit = locations.find((l) => normalizeQrString(l.name) === n);
      if (!hit) {
        // looser match (contains) to handle minor decoration
        hit = locations.find((l) => {
          const ln = normalizeQrString(l.name);
          return ln && (n.includes(ln) || ln.includes(n));
        });
      }
    }

    return { hit, info };
  }

  function kanaGroupFromKana(kana) {
    // Expect hiragana/katakana reading; group by first char.
    const s = (kana || '').trim();
    if (!s) return '他';

    const ch = s[0];
    const hira = toHiragana(ch);

    const groups = [
      { label: 'あ', chars: 'あいうえお' },
      { label: 'か', chars: 'かきくけこがぎぐげご' },
      { label: 'さ', chars: 'さしすせそざじずぜぞ' },
      { label: 'た', chars: 'たちつてとだぢづでど' },
      { label: 'な', chars: 'なにぬねの' },
      { label: 'は', chars: 'はひふへほばびぶべぼぱぴぷぺぽ' },
      { label: 'ま', chars: 'まみむめも' },
      { label: 'や', chars: 'やゆよ' },
      { label: 'ら', chars: 'らりるれろ' },
      { label: 'わ', chars: 'わをん' },
    ];

    for (const g of groups) {
      if (g.chars.includes(hira)) return g.label;
    }
    return '他';
  }

  function toHiragana(ch) {
    // Convert katakana to hiragana (single char)
    const code = ch.charCodeAt(0);
    // Katakana range
    if (code >= 0x30a1 && code <= 0x30f6) {
      return String.fromCharCode(code - 0x60);
    }
    return ch;
  }

  function mailtoLink(to, subject, body) {
    const list = (to || []).filter(Boolean).join(',');
    const qs = new URLSearchParams();
    qs.set('subject', subject || '');
    qs.set('body', body || '');
    // Some mail clients don't like '+' encoding; use encodeURIComponent via URLSearchParams is ok.
    return `mailto:${list}?${qs.toString()}`;
  }

  /**
   * =========================================================
   *  Goods/AED map helpers
   *
   *  showAedMap: navigate to the AED map view and set a callback to execute
   *    when the user closes the map. The overview is reset each time.
   *
   *  aedCloseCallback: optional callback invoked when the user closes
   *    the AED map (via the "閉じる" button). If null, nav.back() will be
   *    called to return to the previous view.
   * ========================================================= */

  let aedCloseCallback = null;

  // Callback for stretcher map close events
  let stretcherCloseCallback = null;

  // Callback for OS1 map close events
  let os1CloseCallback = null;

  function showAedMap(callback) {
    aedCloseCallback = typeof callback === 'function' ? callback : null;
    // Reset the map to show the overview and hide detail before navigating
    try {
      const ov = document.getElementById('aed-overview');
      const detail = document.getElementById('aed-detail');
      if (ov) ov.classList.remove('hidden');
      if (detail) detail.classList.add('hidden');
    } catch (e) {
      console.error(e);
    }
    nav.show('view-aed-map');
  }

  /**
   * Show the stretcher map view and optionally set a callback to execute
   * when the user closes the map. Resets the map to its overview state
   * prior to navigation. If no callback is provided, the back button will
   * simply navigate back to the previous view.
   */
  function showStretcherMap(callback) {
    stretcherCloseCallback = typeof callback === 'function' ? callback : null;
    try {
      const ov = document.getElementById('stretcher-overview');
      const detail = document.getElementById('stretcher-detail');
      if (ov) ov.classList.remove('hidden');
      if (detail) detail.classList.add('hidden');
    } catch (e) {
      console.error(e);
    }
    nav.show('view-stretcher-map');
  }

  /**
   * Show the OS1 map view and optionally set a callback to execute
   * when the user closes the map. Resets the map to its overview state
   * prior to navigation. If no callback is provided, the back button will
   * simply navigate back to the previous view.
   */
  function showOs1Map(callback) {
    os1CloseCallback = typeof callback === 'function' ? callback : null;
    try {
      const ov = document.getElementById('os1-overview');
      const detail = document.getElementById('os1-detail');
      if (ov) ov.classList.remove('hidden');
      if (detail) detail.classList.add('hidden');
    } catch (e) {
      console.error(e);
    }
    nav.show('view-os1-map');
  }

  /**
   * =========================================================
   *  Overlay helper functions
   *  - showOverlay: Display a modal with a message and buttons
   *  - closeOverlay: Hide the modal
   *
   *  Each button entry accepts:
   *    { label: string, style: 'primary' | 'secondary' | 'emergency', onClick: function }
   *  The 'style' determines which CSS class is applied.
   * ========================================================= */
  function showOverlay(message, buttons) {
    const overlay = document.getElementById('overlay');
    const msgEl = document.getElementById('overlay-message');
    const btnWrap = document.getElementById('overlay-buttons');
    if (!overlay || !msgEl || !btnWrap) return;
    // Insert message (HTML allowed)
    msgEl.innerHTML = message;
    // Clear old buttons
    btnWrap.innerHTML = '';
    (buttons || []).forEach((btn) => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      // Determine class based on style
      let cls = 'btn ';
      switch (btn.style) {
        case 'secondary':
          cls += 'btn-secondary';
          break;
        case 'emergency':
          cls += 'btn-emergency';
          break;
        default:
          cls += 'btn-primary';
      }
      b.className = cls;
      b.type = 'button';
      b.addEventListener('click', () => {
        try { btn.onClick && btn.onClick(); } catch (e) { console.error(e); }
      });
      btnWrap.appendChild(b);
    });
    overlay.classList.remove('hidden');
  }

  function closeOverlay() {
    const overlay = document.getElementById('overlay');
    if (overlay) overlay.classList.add('hidden');
    const btnWrap = document.getElementById('overlay-buttons');
    if (btnWrap) btnWrap.innerHTML = '';
  }

  /**
   * =========================================================
   *  Emergency guided flow (意識なし・呼吸なし)
   *
   *  startEmergencyInitial: called when both consciousness and breathing are "no".
   *  startEmergencyAfterCall: called after ambulance has been called (tel:117).
   *  These functions guide the user through location selection, SMS sending,
   *  CPR, AED, stretcher acquisition, and end with instructions to continue
   *  first aid. They leverage showOverlay() to prompt the user.
   * ========================================================= */
  function startEmergencyInitial() {
    // 意識なし・呼吸なし：必ず「通報→SMS→CPR」に繋げるための誘導。
    // 場所選択（QR/地図）中はオーバーレイを閉じて、モーダル操作を妨げない。

    const showCallStep = () => {
      showOverlay(
        '次に「救急車を呼ぶ」を押してください。\n（すでに通報済みなら「発信済み」）',
        [
          {
            label: '救急車を呼ぶ',
            style: 'emergency',
            onClick: () => {
              closeOverlay();
              const callBtn = document.getElementById('btnCallAmbulance');
              if (callBtn) callBtn.click();
            },
          },
          {
            label: '発信済み',
            style: 'secondary',
            onClick: () => {
              closeOverlay();
	          stateOne._afterCallFlowStarted = true;
              try {
                startEmergencyAfterCall();
              } catch (e) {
                console.error(e);
              }
            },
          },
          {
            label: '入力を続ける',
            style: 'secondary',
            onClick: () => {
              closeOverlay();
            },
          },
        ],
      );
    };

    showOverlay('意識なし・呼吸なしです。まずは場所を特定し、救急車を呼んでください。', [
      {
        label: '場所QRを読む',
        style: 'primary',
        onClick: () => {
          closeOverlay();
          // QRモーダルが閉じられたら誘導を再開（キャンセルでもOK）
          window.__qrModalCloseCb = () => {
            try {
              showCallStep();
            } catch (e) {
              console.error(e);
            }
          };
          if (typeof openQrModal === 'function') openQrModal('location');
        },
      },
      {
        label: '地図から選択',
        style: 'secondary',
        onClick: () => {
          closeOverlay();
          window.__mapModalCloseCb = () => {
            try {
              showCallStep();
            } catch (e) {
              console.error(e);
            }
          };
          if (typeof openMapModal === 'function') openMapModal();
        },
      },
      {
        label: '場所を選択せず進む',
        style: 'secondary',
        onClick: () => {
          closeOverlay();
          showCallStep();
        },
      },
    ]);
  }

  function startEmergencyAfterCall() {
    // Step after ambulance call: ask to send SMS
    showOverlay(
      '続けてSMSを発信してください。',
      [
        {
          label: 'SMS発信',
          style: 'primary',
          onClick: () => {
            // オーバーレイを閉じ、SMS送信後にCPRの案内を行うよう
            // afterSmsAction を設定してからSMS発信ボタンを押す。
            closeOverlay();
            window.__afterSmsAction = () => {
              try {
                promptCpr();
              } catch (e) {
                console.error(e);
              }
            };
            const btnSms = document.getElementById('btnSendSms');
            if (btnSms) btnSms.click();
          },
        },
        {
          label: '発信済み',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
            promptCpr();
          },
        },
      ],
    );
  }

  function promptCpr() {
    // Ask if CPR has started
    showOverlay(
      '心臓マッサージを開始していますか？',
      [
        {
          label: 'Yes',
          style: 'primary',
          onClick: () => {
            closeOverlay();
            promptAed();
          },
        },
        {
          label: 'No',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
            // Encourage starting CPR
            showOverlay(
              '<span class="danger-text">すぐに開始してください</span>',
              [
                {
                  label: '自分で始める',
                  style: 'emergency',
                  onClick: () => {
                    showOverlay(
                      '両手を重ねて胸の中央を押します。\n1分間に100〜120回のテンポで強く押してください。',
                      [
                        {
                          label: '画面を終了',
                          style: 'secondary',
                          onClick: () => {
                            closeOverlay();
                          },
                        },
                      ],
                    );
                  },
                },
                {
                  label: '他者に依頼',
                  style: 'secondary',
                  onClick: () => {
                    closeOverlay();
                    promptAed();
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }

  function promptAed() {
    // Ask if AED is being retrieved
    showOverlay(
      'AEDを取りに行っていますか？',
      [
        {
          label: 'Yes',
          style: 'primary',
          onClick: () => {
            closeOverlay();
            promptStretcher();
          },
        },
        {
          label: 'No',
          style: 'secondary',
          onClick: () => {
            // Show the AED map for the user to locate a device. Once closed,
            // proceed to the stretcher prompt. The overlay must be closed
            // before navigating.
            closeOverlay();
            if (typeof showAedMap === 'function') {
              showAedMap(() => {
                // After the user closes the AED map, continue the flow
                promptStretcher();
              });
            } else {
              promptStretcher();
            }
          },
        },
      ],
    );
  }

  function promptStretcher() {
    // Ask if stretcher is being retrieved
    showOverlay(
      '担架を取りに行っていますか？',
      [
        {
          label: 'Yes',
          style: 'primary',
          onClick: () => {
            closeOverlay();
            concludeEmergency();
          },
        },
        {
          label: 'No',
          style: 'secondary',
          onClick: () => {
            // Show the stretcher map so the user can locate a stretcher. After closing,
            // proceed to conclude the emergency sequence.
            closeOverlay();
            if (typeof showStretcherMap === 'function') {
              showStretcherMap(() => {
                concludeEmergency();
              });
            } else {
              concludeEmergency();
            }
          },
        },
        {
          label: '不要',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
            concludeEmergency();
          },
        },
      ],
    );
  }

  function concludeEmergency() {
    showOverlay(
      '救護活動を継続してください。',
      [
        { label: '閉じる', style: 'secondary', onClick: () => {
            closeOverlay();
          }
        }
      ]
    );
  }

  /**
   * =========================================================
   *  Goods flow (意識なし・呼吸なしではない場合)
   *
   *  startGoodsFlow: After ambulance call and SMS (if needed), ask for required items
   * ========================================================= */
  function startGoodsFlow() {
    // Show SMS prompt first
    showOverlay(
      '続けてSMSを発信してください。',
      [
        {
          label: 'SMS発信',
          style: 'primary',
          onClick: () => {
            // オーバーレイを閉じ、SMS送信後に必要な物品を尋ねるよう
            // afterSmsAction を設定してからSMS発信ボタンを押す。
            closeOverlay();
            window.__afterSmsAction = () => {
              try {
                promptGoods();
              } catch (e) {
                console.error(e);
              }
            };
            const btnSms = document.getElementById('btnSendSms');
            if (btnSms) btnSms.click();
          },
        },
        {
          label: '発信済み',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
            promptGoods();
          },
        },
        {
          label: '戻る',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
          },
        },
      ],
    );
  }

  function promptGoods() {
    showOverlay(
      '必要な物品はありますか？',
      [
        {
          label: 'AED',
          style: 'primary',
          onClick: () => {
            // オーバーレイを閉じてAEDマップを表示する。閉じた際は直前の画面に戻してから再度物品選択を表示。
            closeOverlay();
            if (typeof showAedMap === 'function') {
              showAedMap(() => {
                // 戻ることで地図ビューを非表示にし、元の画面に戻す
                if (typeof nav !== 'undefined' && typeof nav.back === 'function') {
                  nav.back();
                }
                // 物品選択オーバーレイを再表示
                promptGoods();
              });
            }
          },
        },
        {
          label: '担架',
          style: 'primary',
          onClick: () => {
            // 担架のマップを表示する。閉じたら元の画面へ戻し、物品選択を再度表示。
            closeOverlay();
            if (typeof showStretcherMap === 'function') {
              showStretcherMap(() => {
                if (typeof nav !== 'undefined' && typeof nav.back === 'function') {
                  nav.back();
                }
                promptGoods();
              });
            }
          },
        },
        {
          label: 'OS1',
          style: 'primary',
          onClick: () => {
            // OS1のマップを表示する。閉じたら元の画面へ戻し、物品選択を再表示。
            closeOverlay();
            if (typeof showOs1Map === 'function') {
              showOs1Map(() => {
                if (typeof nav !== 'undefined' && typeof nav.back === 'function') {
                  nav.back();
                }
                promptGoods();
              });
            }
          },
        },
        {
          label: 'なし',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
          },
        },
        {
          label: '戻る',
          style: 'secondary',
          onClick: () => {
            closeOverlay();
          },
        },
      ],
    );
  }

  /**
   * ワンページ入力画面の初期化
   *
   * 従来のウィザードを使わず、単一ページ内で必要情報を入力できるようにする。
   * この関数は view-onepage が表示されるたびに呼び出される。
   */
  function initOnePage() {
    // 内部状態オブジェクト
    const stateOne = {
      conscious: null,
      breathing: null,
      bleeding: null,
      pain: null,
      location: null,
      accidents: [],
      victim: null,
    };
    // Expose onepage state globally so victim modal can update it
    window.__stateOneRef = stateOne;

    const locLabel = document.getElementById('locationSelectedOne');
    const victimLabel = document.getElementById('victimSelectedOne');
    const callBtn = document.getElementById('btnCallAmbulance');

    // ヘルパー：コールボタンの状態更新
    function updateCallButton() {
      // 仕様により、救急車を呼ぶボタンは常に押せるようにする
      callBtn.disabled = false;
      callBtn.classList.remove('btn-secondary', 'btn-primary');
      callBtn.classList.add('btn-emergency');
    }

    // Expose for QR modal (and other components) to refresh onepage UI state
    window.__updateCallButton = updateCallButton;

    // 意識・呼吸ボタンのイベント
    function wireSeg(id, prop) {
      const wrap = document.getElementById(id);
      if (!wrap) return;
      wrap.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          // reset classes
          wrap.querySelectorAll('button').forEach((b) => {
            b.classList.remove('active');
            b.classList.remove('danger');
          });
          btn.classList.add('active');
          const val = btn.getAttribute('data-val');
          stateOne[prop] = val;
          // Apply danger highlight: 意識/呼吸は "なし"、大量出血/強い痛みは "あり" のとき
          if ((prop === 'conscious' || prop === 'breathing') && val === 'no') {
            btn.classList.add('danger');
          }
          if ((prop === 'bleeding' || prop === 'pain') && val === 'yes') {
            btn.classList.add('danger');
          }
          updateCallButton();
        });
      });
    }
    wireSeg('segConsciousOne', 'conscious');
    wireSeg('segBreathingOne', 'breathing');
    wireSeg('segBleedingOne', 'bleeding');
    wireSeg('segPainOne', 'pain');

    // 緊急時の誘導フロー制御変数
    stateOne._emergencyTriggered = false;
    stateOne._afterCallFlowStarted = false;

    // 意識・呼吸が両方「なし」の場合に誘導を開始
    function checkEmergencyFlow() {
      if (stateOne.conscious === 'no' && stateOne.breathing === 'no' && !stateOne._emergencyTriggered) {
        stateOne._emergencyTriggered = true;
        // ステップ1: 場所の確認と救急車要請の案内
        startEmergencyInitial();
      }
    }

    // 各セグメントボタンに checkEmergencyFlow を追加
    function wireSegCheck(id) {
      const wrap = document.getElementById(id);
      if (!wrap) return;
      wrap.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          checkEmergencyFlow();
        });
      });
    }
    wireSegCheck('segConsciousOne');
    wireSegCheck('segBreathingOne');

    // 場所: 地図から選択
    const btnMap = document.getElementById('btnMapSelectOne');
    if (btnMap) {
      btnMap.addEventListener('click', () => {
        // 既存の openMapModal を呼び出し
        if (typeof openMapModal === 'function') openMapModal();
      });
    }
    // 場所: QR読み取り
    const btnScanLoc = document.getElementById('btnScanLocationOne');
    if (btnScanLoc) {
      btnScanLoc.addEventListener('click', () => {
        if (typeof openQrModal === 'function') openQrModal('location');
      });
    }
    // 場所: 手入力で設定
    const btnSetManual = document.getElementById('btnLocationSetManualOne');
    if (btnSetManual) {
      btnSetManual.addEventListener('click', () => {
        const val = document.getElementById('locationManualOne').value.trim();
        if (!val) {
          toast('場所を入力してください');
          return;
        }
        stateOne.location = { name: val };
        if (locLabel) locLabel.textContent = val;
        updateCallButton();
      });
    }
    // 場所: 不明
    const btnLocUnknown = document.getElementById('btnLocationUnknownOne');
    if (btnLocUnknown) {
      btnLocUnknown.addEventListener('click', () => {
        stateOne.location = { unknown: true };
        if (locLabel) locLabel.textContent = '不明';
        updateCallButton();
      });
    }
    // 地図モーダルで場所確定時にラベルをコピーする
    const btnMapUse = document.getElementById('btnMapUse');
    if (btnMapUse) {
      btnMapUse.addEventListener('click', () => {
        const sel = document.getElementById('mapSelectedLabel');
        const name = sel ? sel.textContent.trim() : '';
        if (name && name !== '未選択') {
          stateOne.location = { name };
          if (locLabel) locLabel.textContent = name;
          updateCallButton();
        }
      });
    }

    // 事故区分: pictogram 定義
    // 事故区分定義（ユーザー指定の順序・内容）
    const accidentDefs = [
      { key: 'fall', label: '転落', icon: '🤸' },
      { key: 'crush', label: '挟まれ', icon: '🪨' },
      { key: 'flying', label: '飛来', icon: '📦' },
      { key: 'collapse', label: '倒壊', icon: '🏚️' },
      { key: 'burn', label: '熱傷', icon: '🔥' },
      { key: 'hazard', label: '有害物', icon: '☣️' },
      { key: 'electric', label: '感電', icon: '⚡' },
      { key: 'collision', label: '激突', icon: '🚧' },
      { key: 'explosion', label: '爆発', icon: '💥' },
      { key: 'other', label: 'その他', icon: '❓' },
    ];
    const iconWrap = document.getElementById('accidentIcons');
    if (iconWrap && iconWrap.children.length === 0) {
      accidentDefs.forEach((def) => {
        const div = document.createElement('div');
        div.className = 'icon-item';
        div.dataset.key = def.key;
        div.innerHTML = `<div class="icon">${def.icon}</div><div class="label">${def.label}</div>`;
        iconWrap.appendChild(div);
      });
    }
    if (iconWrap) {
      iconWrap.querySelectorAll('.icon-item').forEach((el) => {
        el.addEventListener('click', () => {
          const key = el.dataset.key;
          if (stateOne.accidents.includes(key)) {
            stateOne.accidents = stateOne.accidents.filter((k) => k !== key);
            el.classList.remove('active');
          } else {
            stateOne.accidents.push(key);
            el.classList.add('active');
          }
        });
      });
    }
    // 事故補足
    const noteArea = document.getElementById('accidentNoteOne');
    if (noteArea) {
      noteArea.addEventListener('input', () => {
        stateOne.accidentNote = noteArea.value;
      });
    }

    // 被災者: QR読み取り
    const btnScanVict = document.getElementById('btnScanVictimOne');
    if (btnScanVict) {
      btnScanVict.addEventListener('click', () => {
        // 前回の選択をリセット
        stateOne.victim = null;
        if (victimLabel) victimLabel.textContent = '未選択';
        // ライブQR読み取りのみを起動し、過去の履歴に基づく確認ポップアップは表示しない
        try {
          if (typeof openQrModal === 'function') openQrModal('victim');
        } catch {}
        // ここでは確認ダイアログを表示しない。
        // QRコード読み取り後に適切な処理を行うハンドラーが別途実装されることを想定。
      });
    }
    // 被災者: 氏名で探す → 別ウィンドウ（モーダル）を開く
    const btnSearchVict = document.getElementById('btnSearchVictimOne');
    if (btnSearchVict) {
      btnSearchVict.addEventListener('click', () => {
        if (typeof openVictimModal === 'function') openVictimModal();
      });
    }
    // 被災者: unknown or selected in existing victim view: listen for selection update
    const btnVictUse = document.getElementById('btnVictimNext');
    if (btnVictUse) {
      btnVictUse.addEventListener('click', () => {
        const sel = document.getElementById('victimSelected');
        const name = sel ? sel.textContent.trim() : '';
        if (name && name !== '未選択') {
          stateOne.victim = { name };
          if (victimLabel) victimLabel.textContent = name;
        }
        // 戻る
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        document.getElementById('view-onepage').classList.add('active');
      });
    }
    const btnVictUnknown = document.getElementById('btnVictimUnknown');
    if (btnVictUnknown) {
      btnVictUnknown.addEventListener('click', () => {
        stateOne.victim = { unknown: true };
        if (victimLabel) victimLabel.textContent = '不明';
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        document.getElementById('view-onepage').classList.add('active');
      });
    }

    // 救急車を呼ぶ → 117 へ電話
    if (callBtn) {
      callBtn.addEventListener('click', () => {
        // tel:117 を発信。新しいタブを開かず同一タブで遷移することで blank 画面を防ぐ
        try {
          window.location.href = 'tel:117';
        } catch (e) {
          window.location.href = 'tel:117';
        }
        if (stateOne._afterCallFlowStarted) return;
        stateOne._afterCallFlowStarted = true;
        if (stateOne.conscious === 'no' && stateOne.breathing === 'no') {
          startEmergencyAfterCall();
        } else {
          startGoodsFlow();
        }
      });
    }
    // SMS発信 → ダミーの番号に要約を送信
    const btnSms = document.getElementById('btnSendSms');
    if (btnSms) {
      btnSms.addEventListener('click', () => {
        // デモ用電話番号
        const numbers = ['090-0000-0000', '090-1111-1111'];
        // 現在時刻を送信時間に使用（YYYY/M/D H:mm）
        const now = new Date();
        const sendTime = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
        // 職員ID（被災者ID）
        let staffId = '不明';
        if (stateOne.victim && stateOne.victim.staffId) {
          staffId = stateOne.victim.staffId;
        }
        // 場所名
        let locName = '不明';
        if (stateOne.location) {
          if (stateOne.location.unknown) {
            locName = '不明';
          } else if (stateOne.location.name) {
            locName = stateOne.location.name;
          }
        }
        // 状態（意識/呼吸/大量出血/強い痛み）
        const mapVal = { yes: 'あり', no: 'なし', unknown: '不明' };
        const conscious = mapVal[stateOne.conscious] || '不明';
        const breathing = mapVal[stateOne.breathing] || '不明';
        const bleeding = mapVal[stateOne.bleeding] || '不明';
        const pain = mapVal[stateOne.pain] || '不明';
        // 状態を2行に分割する：状態1は意識と呼吸、状態2は大量出血と強い痛み
        const statusStr1 = `意識${conscious}、呼吸${breathing}`;
        const statusStr2 = `大量出血${bleeding}、強い痛み${pain}`;
        // 事故種別
        let accStr = '不明';
        if (stateOne.accidents && stateOne.accidents.length) {
          try {
            accStr = stateOne.accidents.map((k) => getAccidentLabel(k)).join('、');
          } catch {
            accStr = stateOne.accidents.join('、');
          }
        }
        // メッセージ行を構築
        const lines = [];
        lines.push('【命をツナゲル】被災連絡');
        // 「送信時間」を「連絡時間」に変更
        lines.push(`連絡時間：${sendTime}`);
        lines.push(`職員ID：${staffId}`);
        lines.push(`場所：${locName}`);
        // 2行の状態を記述
        lines.push(`状態1：${statusStr1}`);
        lines.push(`状態2：${statusStr2}`);
        lines.push(`事故種別：${accStr}`);
        const body = lines.join('\n');
        const to = numbers.join(',');
        const href = `sms:${to}?body=${encodeURIComponent(body)}`;
        window.location.href = href;
        // SMS送信後の次のアクションを処理する。
        if (typeof window.__afterSmsAction === 'function') {
          const cb = window.__afterSmsAction;
          // 必ず一度だけ実行するためにリセット
          window.__afterSmsAction = null;
          try {
            cb();
          } catch (e) {
            console.error(e);
          }
        } else {
          // afterSmsAction が設定されていない場合は、直接SMS発信ボタンが押されたと判断し
          // 状態に応じて次のフローへ。
          // - 意識なし・呼吸なし => CPRに必ず繋げる
          // - それ以外 => 物品確認へ
          try {
            const isCprCase = stateOne.conscious === 'no' && stateOne.breathing === 'no';
            if (isCprCase) {
              promptCpr();
            } else {
              promptGoods();
            }
          } catch (e) {
            console.error(e);
          }
        }
      });
    }
    // 初期状態
    updateCallButton();
  }

  // 「最初から」などでワンページ入力を完全リセットする
  function resetOnePageStateAndUI() {
    // Close transient UI
    try { closeOverlay(); } catch {}
    try { closeQrModal(); } catch {}
    try { closeMapModal(); } catch {}
    try {
      const victimModal = $('#victimSearchModal');
      if (victimModal) victimModal.classList.add('hidden');
    } catch {}

    // Clear guided-flow callbacks
    window.__afterSmsAction = null;
    window.__qrModalCloseCb = null;
    window.__mapModalCloseCb = null;

    // Reset in-memory onepage state
    const s = window.__stateOneRef;
    if (s) {
      s.conscious = 'unknown';
      s.breathing = 'unknown';
      s.bleeding = 'unknown';
      s.pain = 'unknown';
      s.location = null;
      s.victim = null;
      s.accidents = [];
      s._emergencyTriggered = false;
      s._afterCallFlowStarted = false;
    }

    // Reset UI segments
    ['segConsciousOne','segBreathingOne','segBleedingOne','segPainOne'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.querySelectorAll('button').forEach(b => {
        b.classList.remove('active');
        b.classList.remove('danger');
      });
    });

    // Reset location UI
    const locLabel = $('#locationSelectedOne');
    if (locLabel) locLabel.textContent = '未選択';
    const locManual = $('#locationManualOne');
    if (locManual) locManual.value = '';

    // Reset victim UI
    const vicLabel = $('#victimSelectedOne');
    if (vicLabel) vicLabel.textContent = '未選択';

    // Reset accident icons
    const iconsWrap = $('#accidentIcons');
    if (iconsWrap) {
      iconsWrap.querySelectorAll('.acc-icon').forEach(el => el.classList.remove('active'));
    }

    // Update call button color/availability
    if (typeof window.__updateCallButton === 'function') {
      try { window.__updateCallButton(); } catch {}
    }
  }

  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = enc.encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** =========================
   *  Master data (defaults)
   *  ========================= */
  function defaultMaster() {
    return {
      version: 1,
      admin: {
        passwordHash: '', // SHA-256 hex
      },
      globalContacts: {
        // 送信先は電話番号形式に変更（デモ用）
        safetyHQ: '090-0000-0000',
        rescueTeam: '090-0000-0000',
        ambulanceCenter: '090-0000-0000',
      },
      // 送信先範囲（マスタでON/OFF）
      sendScope: {
        safetyHQ: true,
        rescueTeam: false,
        ambulanceCenter: false,
        companyEmails: true,
      },
      companies: [
        { id: 'own', name: '自社', phones: ['090-0000-0000', '090-0000-0000'] },
        { id: 'a', name: 'A造船', phones: ['090-0000-0000', '090-0000-0000'] },
        { id: 'b', name: 'B株式会社', phones: ['090-0000-0000'] },
      ],
      locations: [
        { id: uuid(), name: '北定盤2', qr: '' },
        { id: uuid(), name: 'ピース切断場', qr: '' },
        { id: uuid(), name: '道具置場', qr: '' },
        { id: uuid(), name: '施設作業場', qr: '' },
        { id: uuid(), name: '旧ガスセンター工場', qr: '' },
        { id: uuid(), name: 'B棟', qr: '' },
        { id: uuid(), name: '北定盤1', qr: '' },
        { id: uuid(), name: 'A棟', qr: '' },
        { id: uuid(), name: 'DOCK', qr: '' },
        { id: uuid(), name: '建造船', qr: '' },
        { id: uuid(), name: 'SUB定盤', qr: '' },
        { id: uuid(), name: 'SUB工場', qr: '' },
        { id: uuid(), name: '事務所', qr: '' },
        { id: uuid(), name: '食堂・協力業者ハウス', qr: '' },
        { id: uuid(), name: 'ブロック置場', qr: '' },
        { id: uuid(), name: '鋼材・SUB材置場', qr: '' },
        { id: uuid(), name: '曲げ定盤', qr: '' },
        { id: uuid(), name: 'パイプ置場', qr: '' },
        { id: uuid(), name: '艤装岸壁', qr: '' },
        { id: uuid(), name: '南定盤1', qr: '' },
        { id: uuid(), name: '70t JC', qr: '' },
        { id: uuid(), name: 'C棟', qr: '' },
        { id: uuid(), name: '艤装品置場', qr: '' },
        { id: uuid(), name: 'スクラップ場', qr: '' },
        { id: uuid(), name: '南定盤2', qr: '' },
        { id: uuid(), name: '南定盤3', qr: '' },
        { id: uuid(), name: '加工場', qr: '' },
        { id: uuid(), name: 'パイプ工場', qr: '' },
        { id: uuid(), name: '電気室・コンプレッサー室', qr: '' },
      ],
      staff: [
        // 職員IDは単純な英数字4桁とする（S001〜）
        { id: 'S001', companyId: 'own', name: '佐藤 一郎', kana: 'さとういちろう', qr: '' },
        { id: 'S002', companyId: 'own', name: '高橋 花子', kana: 'たかはしはなこ', qr: '' },
        { id: 'S003', companyId: 'a',   name: '山田 太郎', kana: 'やまだたろう', qr: '' },
        { id: 'S004', companyId: 'a',   name: '伊藤 次郎', kana: 'いとうじろう', qr: '' },
        { id: 'S005', companyId: 'b',   name: '鈴木 三郎', kana: 'すずきさぶろう', qr: '' },
      ],
      situations: [
        {
          id: 'unconscious',
          label: '意識なし',
          hint: '',
          icon: '🧠',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '反応がない場合は呼吸や脈を確認し、すぐに救急車（119）を呼んでください。可能なら心肺蘇生（CPR）を開始します。',
          recommendTextObserve:
            '反応がない場合は緊急性が高い可能性があります。ためらわず緊急要請を選択してください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 意識なし',
          bodyTplEmergency:
            '{person}さん、「意識なし」、緊急救護必要、担架要請\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「意識なし」疑い、至急確認をお願いします\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'bleeding_major',
          label: '大量出血',
          hint: '',
          icon: '🩸',
          requiresBody: true,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '出血部位を圧迫して止血し、可能なら患部を心臓より高く保ちます。迷わず救急車（119）を呼んでください。',
          recommendTextObserve:
            '出血が続く・多い場合は緊急要請が必要です。圧迫止血を継続してください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 大量出血',
          bodyTplEmergency:
            '{person}さん、「大量出血（{part}）」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「出血（{part}）」、経過観察しつつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'bleeding',
          label: '出血',
          hint: '',
          icon: '🩸',
          requiresBody: true,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '出血が止まらない・量が多い・意識がぼんやりする場合は、迷わず救急要請してください。',
          recommendTextObserve:
            '出血部位を圧迫して止血し、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 出血',
          bodyTplEmergency:
            '{person}さん、「出血（{part}）」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「出血（{part}）」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'fall',
          label: '転落',
          hint: '',
          icon: '🧗',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '頭部・体幹を動かさず安静にし、必要に応じて救急車（119）を呼んでください。',
          recommendTextObserve:
            '痛み・しびれ・意識変容があれば緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 転落',
          bodyTplEmergency:
            '{person}さん、「転落」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「転落」疑い、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'electric',
          label: '感電',
          hint: '電気事故',
          icon: '⚡',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam', 'ambulanceCenter'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '安全確保（通電停止）後、意識・呼吸を確認。異常があれば救急車（119）を呼んでください。',
          recommendTextObserve:
            '軽症でも遅れて症状が出ることがあります。必ず上長・安全課へ共有してください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 感電',
          bodyTplEmergency:
            '{person}さん、「感電」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「感電」疑い、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'pinched',
          label: '挟まれ',
          hint: '',
          icon: '🧱',
          requiresBody: false,
          defaultAction: 'emergency',
          includeEmergency: ['safetyHQ', 'rescueTeam'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '挟まれの場合は二次災害に注意しつつ救出。出血や意識障害があれば救急車（119）。',
          recommendTextObserve:
            '痛みや腫れが強い場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 挟まれ',
          bodyTplEmergency:
            '{person}さん、「挟まれ」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「挟まれ」疑い、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'pain',
          label: '痛み',
          hint: '',
          icon: '🤕',
          requiresBody: true,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ', 'rescueTeam'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '強い痛み、変形、しびれ、出血がある場合は緊急要請を選択してください。',
          recommendTextObserve:
            '患部を安静にし、症状が改善しない/悪化する場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 痛み',
          bodyTplEmergency:
            '{person}さん、「{part}に痛み」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、{part}に痛み、様子を見る\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'dizzy',
          label: '立ち眩み',
          hint: '',
          icon: '💫',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '意識低下、胸痛、呼吸困難などがある場合は緊急要請してください。',
          recommendTextObserve:
            '安全な場所で座らせ、無理に立たせず、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 立ち眩み',
          bodyTplEmergency:
            '{person}さん、「立ち眩み」、緊急対応が必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「立ち眩み」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'vomit',
          label: '嘔吐',
          hint: '',
          icon: '🤢',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '意識障害、血を吐く、激しい腹痛がある場合は緊急要請してください。',
          recommendTextObserve:
            '横向きに寝かせ、誤嚥に注意し、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 嘔吐',
          bodyTplEmergency:
            '{person}さん、「嘔吐」、緊急対応が必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「嘔吐」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'cant_stand',
          label: '立てない',
          hint: '',
          icon: '🧍',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '意識がない、呼吸が苦しい、強い痛みがある場合は緊急要請してください。',
          recommendTextObserve:
            '無理に動かさず安静にし、改善しない場合は緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - 立てない',
          bodyTplEmergency:
            '{person}さん、「立てない」、緊急対応が必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「立てない」、様子を見つつ状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
        {
          id: 'other',
          label: 'その他',
          hint: '',
          icon: '➕',
          requiresBody: false,
          defaultAction: 'observe',
          includeEmergency: ['safetyHQ', 'rescueTeam'],
          includeObserve: ['safetyHQ'],
          recommendTextEmergency:
            '緊急性が疑われる場合は、迷わず緊急要請してください。',
          recommendTextObserve:
            '状況を整理して共有し、必要に応じて緊急要請へ切り替えてください。',
          subjectTpl: '[命をツナゲル] {company} {person} - その他',
          bodyTplEmergency:
            '{person}さん、「その他」、緊急救護必要\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
          bodyTplObserve:
            '{person}さん、「その他」、状況共有\n所属：{company}\n発生時刻：{time}\n\n状況：{detail}',
        },
      ],
      bodyParts: [
        { id: 'head', label: '頭' },
        { id: 'neck', label: '首' },
        { id: 'torso', label: '胸/腹' },
        { id: 'leftArm', label: '左腕' },
        { id: 'rightArm', label: '右腕' },
        { id: 'leftHand', label: '左手' },
        { id: 'rightHand', label: '右手' },
        { id: 'hips', label: '腰' },
        { id: 'leftLeg', label: '左脚' },
        { id: 'rightLeg', label: '右脚' },
        { id: 'leftFoot', label: '左足' },
        { id: 'rightFoot', label: '右足' },
      ],
      // 事故区分マスタ
      accidentTypes: [
        { key: 'fall', label: '転落' },
        { key: 'crush', label: '挟まれ' },
        { key: 'flying', label: '飛来' },
        { key: 'collapse', label: '倒壊' },
        { key: 'burn', label: '熱傷' },
        { key: 'hazard', label: '有害物' },
        { key: 'electric', label: '感電' },
        { key: 'collision', label: '激突' },
        { key: 'explosion', label: '爆発' },
        { key: 'other', label: 'その他' },
      ],
    };
  }

  function loadMaster() {
    // Merge with defaults so new fields/situations are added even if older data exists in localStorage
    const def = defaultMaster();

    function mergeById(defArr, savedArr) {
      const map = new Map();
      defArr.forEach((x) => map.set(x.id, x));

      if (Array.isArray(savedArr)) {
        for (const x of savedArr) {
          if (!x || !x.id) continue;
          const base = map.get(x.id) || {};
          map.set(x.id, { ...base, ...x });
        }
      }

      const ordered = [];
      const seen = new Set();
      for (const x of defArr) {
        const v = map.get(x.id);
        if (v) {
          ordered.push(v);
          seen.add(x.id);
        }
      }
      for (const [id, v] of map.entries()) {
        if (!seen.has(id)) ordered.push(v);
      }
      return ordered;
    }

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return def;

      const parsed = JSON.parse(raw) || {};
      const merged = { ...def, ...parsed };

      // Deep-merge objects that may get new keys over time
      merged.sendScope = { ...def.sendScope, ...(parsed.sendScope || {}) };

      merged.companies = mergeById(def.companies, parsed.companies);
      merged.staff = mergeById(def.staff, parsed.staff);
      merged.locations = mergeById(def.locations, parsed.locations);
      merged.situations = mergeById(def.situations, parsed.situations);
      merged.bodyParts = mergeById(def.bodyParts, parsed.bodyParts);

      return merged;
    } catch (e) {
      console.warn('Failed to load master; using default', e);
      return def;
    }
  }

  function saveMaster(master) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(master));
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  /** =========================
   *  App state & navigation
   *  ========================= */
  const WIZ = {
    triage: 'view-triage',
    location: 'view-location',
    accident: 'view-accident',
    victim: 'view-victim',
    review: 'view-review',
  };
  const WIZ_ORDER = ['triage', 'location', 'accident', 'victim', 'review'];

  function defaultWizardState() {
    return {
      startedAt: nowIsoLocal(),
      triage: { conscious: null, breathing: null },
      location: { qr: '', name: '', unknown: true },
      accident: { types: [], note: '' },
      victim: { staffId: null, name: '', qr: '', unknown: true },
    };
  }

  const state = {
    mode: 'emergency', // 'emergency' | 'unsure' (affects visible situations)
    situationId: null,
    companyId: null,
    personId: null,
    bodyPartId: null,
    detailNote: '', // optional
    action: null, // 'emergency' | 'observe' (selected on result)
    preview: { to: [], subject: '', body: '' },
    wiz: defaultWizardState(),
  };

  const nav = {
    stack: ['view-home'],
    show(viewId, { push = true } = {}) {
      $$('.view').forEach((v) => v.classList.remove('active'));
      const el = document.getElementById(viewId);
      if (!el) return;
      el.classList.add('active');

      // Topbar visibility
      const topbar = $('#topbar');
      topbar.style.display = 'flex';
      // Homeでは「戻る」「最初から」を非表示にし、それ以外の画面では表示。
      // Use the display property instead of visibility to ensure the buttons
      // occupy space only when needed. This avoids cases where a button is
      // technically visible but hidden behind other elements due to
      // lingering layout constraints. See issue reported on one‑page view.
      const backBtn = $('#btnBack');
      const restartBtn = $('#btnRestartGlobal');
      const isHome = (viewId === 'view-home');
      if (backBtn) backBtn.style.display = isHome ? 'none' : 'inline-flex';
      if (restartBtn) restartBtn.style.display = isHome ? 'none' : 'inline-flex';

      if (push) {
        const current = nav.stack[nav.stack.length - 1];
        if (current !== viewId) nav.stack.push(viewId);
      }

      onViewShown(viewId);

      // Always scroll to the top when switching views. This ensures that
      // navigating from another page or reloading will start at the top
      // rather than retaining an old scroll position. Some browsers may
      // throw if smooth scroll is not supported, so fall back to an
      // immediate jump.
      try {
        window.scrollTo({ top: 0, behavior: 'instant' });
      } catch {
        window.scrollTo(0, 0);
      }
    },
    back() {
      if (nav.stack.length <= 1) {
        nav.show('view-home', { push: false });
        nav.stack = ['view-home'];
        return;
      }
      nav.stack.pop();
      nav.show(nav.stack[nav.stack.length - 1], { push: false });
    },
    restartAll() {
      nav.stack = ['view-home'];
      resetFlow();
      nav.show('view-home', { push: false });
    },
  };

  function resetFlow() {
    state.situationId = null;
    state.companyId = null;
    state.personId = null;
    state.bodyPartId = null;
    state.detailNote = '';
    state.action = null;
    state.preview = { to: [], subject: '', body: '' };
    state.wiz = defaultWizardState();

    // reset body selection UI
    $$('#bodySvg .body-part').forEach((p) => p.classList.remove('selected'));
    $('#bodySelectedLabel').textContent = '未選択';
    $('#btnBodyNext').disabled = true;

    // clear kana
    $$('#kanaBar .kana-btn').forEach((b) => b.classList.remove('active'));

    // Reset one-page emergency input screen as well (right-top "最初から")
    try { resetOnePageStateAndUI(); } catch {}

    saveSession({ ...state, nav: nav.stack });
  }

  /** =========================
   *  Rendering
   *  ========================= */
  let master = loadMaster();

  function getSituation(id) {
    return master.situations.find((s) => s.id === id) || null;
  }
  function getCompany(id) {
    return master.companies.find((c) => c.id === id) || null;
  }
  function getPerson(id) {
    return master.staff.find((p) => p.id === id) || null;
  }
  function getBodyPart(id) {
    return master.bodyParts.find((b) => b.id === id) || null;
  }

  const STATUS_PRESET = {
    emergency: ['unconscious', 'bleeding_major', 'fall', 'electric', 'pinched', 'other'],
    unsure: ['bleeding', 'dizzy', 'pain', 'vomit', 'cant_stand', 'other'],
  };

  function getPresetSituations(mode) {
    const ids = STATUS_PRESET[mode];
    if (!ids) return null;
    const list = [];
    for (const id of ids) {
      const s = getSituation(id);
      if (s) list.push(s);
    }
    return list;
  }

  function renderStatusGrid() {
    const grid = $('#statusGrid');
    if (!grid) return;
    grid.innerHTML = '';

    let situations = getPresetSituations(state.mode) || master.situations.slice();

    for (const s of situations) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-btn status-card';
      btn.setAttribute('role', 'listitem');
      const iconHtml = s.icon ? `<div class="icon" aria-hidden="true">${escapeHtml(s.icon || '')}</div>` : '';
      const hintHtml = s.hint ? `<span>${escapeHtml(s.hint || '')}</span>` : '';
      btn.innerHTML = `
        ${iconHtml}
        <div class="label">
          <strong>${escapeHtml(s.label)}</strong>
          ${hintHtml}
        </div>
      `;
      btn.addEventListener('click', () => {
        // pick situation
        state.situationId = s.id;
        state.companyId = null;
        state.personId = null;
        state.bodyPartId = null;
        state.action = null;

        saveSession({ ...state, nav: nav.stack });

        // If body-part selection is required, do it BEFORE affiliation/person
        if (s.requiresBody) {
          $('#bodyTitle').textContent = s.label;
          const q = $('#bodyQuestion');
          if (q) q.textContent = '出血・痛みの部位をタップしてください。';
          nav.show('view-body');
          return;
        }

        renderCompanyList();
        nav.show('view-company');
      });
      grid.appendChild(btn);
    }
  }

  /** =========================
   *  Guided emergency flow (指示方式)
   *  ========================= */
  const ACCIDENT_OPTIONS = ['大量出血', '転落', '感電', '挟まれ', '火傷', '熱中症', 'その他'];

  function goWizardStep(stepKey, { push = true } = {}) {
    const id = WIZ[stepKey];
    if (!id) return;
    nav.show(id, { push });
    saveSession({ ...state, nav: nav.stack });
  }

  function stepKeyFromView(viewId) {
    return Object.keys(WIZ).find((k) => WIZ[k] === viewId) || null;
  }

  function updateStepperActive(viewId) {
    const current = stepKeyFromView(viewId);
    if (!current) return;
    $$('.stepper').forEach((stepper) => {
      stepper.querySelectorAll('.step-btn').forEach((btn) => {
        const k = btn.getAttribute('data-step');
        btn.classList.toggle('active', k === current);
      });
    });
  }

  function onViewShown(viewId) {
    if (!Object.values(WIZ).includes(viewId)) return;
    updateStepperActive(viewId);
    if (viewId === WIZ.triage) renderWizardTriage();
    if (viewId === WIZ.location) renderWizardLocation();
    if (viewId === WIZ.accident) renderWizardAccident();
    if (viewId === WIZ.victim) renderWizardVictim();
    if (viewId === WIZ.review) renderWizardReview();
  }

  function yesNoUnknownLabel(val) {
    if (val === 'yes') return 'あり';
    if (val === 'no') return 'なし';
    if (val === 'unknown') return '不明';
    return '未選択';
  }

  function renderWizardTriage() {
    const triage = state.wiz.triage;

    const segMap = {
      conscious: '#segConscious',
      breathing: '#segBreathing',
    };

    function syncGroup(group) {
      const segSel = segMap[group];
      const seg = segSel ? $(segSel) : null;
      if (!seg) return;
      const buttons = seg.querySelectorAll('.seg-btn');
      buttons.forEach((b) => {
        const val = b.getAttribute('data-val');
        const active = triage[group] === val;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    syncGroup('conscious');
    syncGroup('breathing');

    const nextBtn = $('#btnTriageNext');
    if (nextBtn) nextBtn.disabled = !(triage.conscious && triage.breathing);
  }

  function renderWizardLocation() {
    const loc = state.wiz.location;

    const selected = $('#locationSelected');
    if (selected) {
      selected.textContent = loc.unknown ? '不明' : (loc.name || '未設定');
    }

    const list = $('#locationList');
    if (list) {
      list.innerHTML = '';
      const items = (master.locations || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
      if (items.length === 0) {
        const d = document.createElement('div');
        d.className = 'small';
        d.textContent = '場所マスタが未登録です（管理画面で登録してください）。';
        list.appendChild(d);
      } else {
        for (const it of items) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'list-btn';
          b.dataset.id = it.id;
          b.innerHTML = `${escapeHtml(it.name)}<span class="sub">${it.qr ? 'QR: ' + escapeHtml(it.qr) : ''}</span>`;
          list.appendChild(b);
        }
      }
    }

    const manual = $('#locationManual');
    if (manual) {
      const expected = loc.unknown ? '' : (loc.name || '');
      if ((manual.value || '') !== expected) manual.value = expected;
    }
  }

  function renderWizardAccident() {
    const wrap = $('#accidentChips');
    if (wrap && wrap.children.length === 0) {
      const defs = (master.accidentTypes || [
        { key: 'bleeding_major', label: '大量出血' },
        { key: 'fall', label: '転落' },
        { key: 'electric', label: '感電' },
        { key: 'crush', label: '挟まれ' },
        { key: 'burn', label: '熱傷' },
        { key: 'other', label: 'その他' },
      ]);
      defs.forEach((d) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.acc = d.key;
        chip.setAttribute('aria-pressed', 'false');
        chip.textContent = d.label;
        wrap.appendChild(chip);
      });
    }

    const types = new Set(state.wiz.accident.types || []);
    $$('#accidentChips .chip').forEach((c) => {
      const key = c.getAttribute('data-acc');
      c.classList.toggle('active', types.has(key));
      c.setAttribute('aria-pressed', types.has(key) ? 'true' : 'false');
    });
    const note = $('#accidentNote');
    if (note && note.value !== (state.wiz.accident.note || '')) note.value = state.wiz.accident.note || '';
  }

  function renderWizardVictim() {
    const v = state.wiz.victim;
    const staff = v.staffId ? getPerson(v.staffId) : null;
    const name = staff?.name || v.name || (v.unknown ? '不明' : '未設定');
    const companyName = staff ? (getCompany(staff.companyId)?.name || '') : '';

    const picked = $('#victimSelected');
    if (picked) picked.textContent = companyName ? `${name}（${companyName}）` : name;

    // Render list (filter)
    renderVictimSearchList($('#victimSearch')?.value || '');
  }

  function renderVictimSearchList(query) {
    const list = $('#victimList');
    if (!list) return;
    const q = (query || '').trim();

    const people = (master.staff || [])
      .map((p) => ({ ...p, company: getCompany(p.companyId)?.name || '' }))
      .filter((p) => {
        if (!q) return true;
        const hay = `${p.name} ${p.kana || ''} ${p.company || ''}`;
        return hay.includes(q);
      })
      .sort((a, b) => (a.kana || '').localeCompare(b.kana || '', 'ja'))
      .slice(0, 60);

    list.innerHTML = '';
    if (people.length === 0) {
      const d = document.createElement('div');
      d.className = 'small';
      d.textContent = '該当なし（よみ or 氏名で検索）';
      list.appendChild(d);
      return;
    }

    for (const p of people) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'list-btn';
      b.dataset.staff = p.id;
      b.innerHTML = `${escapeHtml(p.name)}<span class="sub">${escapeHtml(p.company)}</span>`;
      list.appendChild(b);
    }
  }

  function getAccidentLabel(key) {
    const defs = master.accidentTypes || [];
    const hit = defs.find((d) => d.key === key);
    return hit ? (hit.label || key) : (key || '');
  }

  function buildWizardPreview() {
    const triage = state.wiz.triage;
    const loc = state.wiz.location;
    const acc = state.wiz.accident;
    const v = state.wiz.victim;
    const staff = v.staffId ? getPerson(v.staffId) : null;
    const company = staff ? getCompany(staff.companyId) : null;

    const to = buildWizardRecipients({ staff, company });

    const locLabel = loc.unknown ? '（場所不明）' : (loc.name || '（場所未設定）');
    const victimLabel = staff?.name || v.name || (v.unknown ? '（被災者不明）' : '（被災者未設定）');

    const subject = `[命をツナゲル] 緊急 ${locLabel} / ${victimLabel}`;

    const lines = [];
    lines.push(`【発見時刻】${state.wiz.startedAt}`);
    lines.push(`【意識】${yesNoUnknownLabel(triage.conscious)}`);
    lines.push(`【呼吸】${yesNoUnknownLabel(triage.breathing)}`);
    lines.push('');
    lines.push(`【場所】${locLabel}`);
    if (loc.qr) lines.push(`場所QR: ${loc.qr}`);
    lines.push('');
    const accLabels = (acc.types || []).map(getAccidentLabel).filter(Boolean);
    lines.push(`【事故区分】${accLabels.length ? accLabels.join(' / ') : '未選択'}`);
    if ((acc.note || '').trim()) lines.push(`補足: ${acc.note.trim()}`);
    lines.push('');
    lines.push(`【被災者】${victimLabel}`);
    if (company?.name) lines.push(`所属: ${company.name}`);
    if (staff?.id) lines.push(`職員ID: ${staff.id}`);
    if (v.qr) lines.push(`ヘルメットQR: ${v.qr}`);
    lines.push('');
    lines.push('—');
    lines.push('※このメールは「命をツナゲル」から作成されました（未確定項目を含む場合があります）。');

    return { to, subject, body: lines.join('\n') };
  }

  function buildWizardRecipients({ staff, company }) {
    const scope = master.sendScope || {};
    const gc = master.globalContacts || {};
    const list = [];
    if (scope.safetyHQ && gc.safetyHQ) list.push(...normalizeEmails(gc.safetyHQ));
    if (scope.rescueTeam && gc.rescueTeam) list.push(...normalizeEmails(gc.rescueTeam));
    if (scope.ambulanceCenter && gc.ambulanceCenter) list.push(...normalizeEmails(gc.ambulanceCenter));
    if (scope.companyEmails && company?.emails?.length) list.push(...(company.emails || []));
    // de-dupe
    return Array.from(new Set(list.filter(Boolean)));
  }

  function renderWizardReview() {
    const p = buildWizardPreview();
    state.preview = p;
    saveSession({ ...state, nav: nav.stack });

    const triage = state.wiz.triage;
    const loc = state.wiz.location;
    const acc = state.wiz.accident;
    const v = state.wiz.victim;
    const staff = v.staffId ? getPerson(v.staffId) : null;
    const company = staff ? getCompany(staff.companyId) : null;

    const parts = [];
    parts.push(`<div><b>発見時刻</b>：${escapeHtml(state.wiz.startedAt)}</div>`);
    parts.push(`<div><b>意識</b>：${escapeHtml(yesNoUnknownLabel(triage.conscious))}　<b>呼吸</b>：${escapeHtml(yesNoUnknownLabel(triage.breathing))}</div>`);
    parts.push(`<div><b>場所</b>：${escapeHtml(loc.unknown ? '不明' : (loc.name || '未設定'))}${loc.qr ? ` <span class="sub">(QR)</span>` : ''}</div>`);
    if (loc.qr) parts.push(`<div class="sub">場所QR: ${escapeHtml(loc.qr)}</div>`);

    const accLabels = (acc.types || []).map(getAccidentLabel).filter(Boolean);
    parts.push(`<div><b>事故区分</b>：${escapeHtml(accLabels.length ? accLabels.join(' / ') : '未選択')}</div>`);
    if ((acc.note || '').trim()) parts.push(`<div class="sub">補足: ${escapeHtml(acc.note.trim())}</div>`);

    const victimLabel = staff?.name || v.name || (v.unknown ? '不明' : '未設定');
    parts.push(`<div><b>被災者</b>：${escapeHtml(victimLabel)}${company?.name ? ` <span class="sub">(${escapeHtml(company.name)})</span>` : ''}</div>`);

    const summary = $('#reviewSummary');
    if (summary) summary.innerHTML = parts.join('');

    const rec = $('#reviewRecipients');
    if (rec) rec.textContent = p.to.length ? p.to.join(', ') : '未設定（管理画面で送信先を登録してください）';

    // Note: Actual sending happens via "メールを開く" / "内容をコピー".
  }

  // --- QR modal (BarcodeDetector if available; fallback to manual text) ---
  let qrStream = null;
  let qrRunning = false;
  let qrDetector = null;
  let qrPurpose = null;
  let qrCanvas = null;
  let qrCtx = null;

  // Instance of QrScanner for live QR code scanning. Initialized in startQrCamera().
  let qrScanner = null;

  // When we show a confirmation popup after scanning, we pause scanning to
  // avoid repeated callbacks. This flag prevents double-handling.
  let qrConfirming = false;

  function pauseQrDecoder() {
    // Pause QR decoding while keeping the camera stream alive.
    qrRunning = false;
    if (qrScanner) {
      try { qrScanner.stop && qrScanner.stop(); } catch {}
    }
  }

  async function resumeQrDecoder() {
    // Resume QR decoding (camera stream is assumed to be still active).
    if (qrScanner) {
      try { await qrScanner.start(); } catch {}
      return;
    }
    if (qrDetector) {
      qrRunning = true;
      requestAnimationFrame(qrTick);
    }
  }

  function setQrStatus(msg) {
    const el = $('#qrStatus');
    if (el) el.textContent = msg || '';
  }

  function openQrPhotoCapture() {
    const f = $('#qrFile');
    if (!f) return;
    try {
      // file:// 等でライブカメラが使えない環境でも、capture入力ならカメラが開けるケースが多い
      f.click();
    } catch {
      // ignore
    }
  }

  function openQrModal(purpose) {
    qrPurpose = purpose;
    const title = $('#qrModalTitle');
    if (title) title.textContent = purpose === 'victim' ? '被災者QRを読み取ってください' : '場所QRを読み取ってください';
    if ($('#qrManual')) $('#qrManual').value = '';
    const f = $('#qrFile');
    if (f) f.value = '';
    setQrStatus('');
    const modal = $('#qrModal');
    if (modal) {
      modal.classList.remove('hidden');
      // 直前にスクロールしていた場合でも、常に先頭から見えるように
      const body = modal.querySelector('.modal-body');
      if (body) body.scrollTop = 0;
    }
    document.body.classList.add('modal-open');
    startQrCamera({ autoFallback: true });
  }

  function closeQrModal() {
    stopQrCamera();
    qrConfirming = false;
    const modal = $('#qrModal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open');

    // If the caller registered a one-shot callback (e.g., emergency flow), resume it.
    // Do NOT force-close overlays here; overlay lifecycle is managed by the caller.
    try {
      const cb = window.__qrModalCloseCb;
      window.__qrModalCloseCb = null;
      if (typeof cb === 'function') cb();
    } catch (e) {
      console.error(e);
      window.__qrModalCloseCb = null;
    }
  }

  async function startQrCamera(opts = {}) {
    const autoFallback = !!opts.autoFallback;
    // UI
    const wrap = $('#qrCameraWrap');
    if (wrap) wrap.classList.remove('hidden');

    // If this origin is not secure, many browsers disable getUserMedia.
    // We keep the photo fallback available in any case.
    const secure = (window.isSecureContext === true) || location.protocol === 'https:' || location.hostname === 'localhost';

    // Feature detection
    if (!secure || !('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
      if (wrap) wrap.classList.add('hidden');
      // file:// 等では getUserMedia が使えないことが多い。
      setQrStatus('この環境ではカメラのライブ読み取りが利用できません。カメラで撮影して読み取ります。');
      if (autoFallback) openQrPhotoCapture();
      return;
    }

    try {
      // Start camera preview
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e1) {
        // Fallback (some devices/browsers don't like facingMode constraints)
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      qrStream = stream;
      const video = $('#qrVideo');
      if (video) {
        video.autoplay = true;
        video.muted = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.srcObject = qrStream;
        await video.play();
      }

      // Prefer qr-scanner (works reliably on iOS Safari). Fallback to BarcodeDetector if needed.
      const QrScannerLib = window.QrScanner;
      if (QrScannerLib && video) {
        // Ensure worker path is set BEFORE creating an instance
        try {
          QrScannerLib.WORKER_PATH = 'https://unpkg.com/qr-scanner/qr-scanner-worker.min.js';
        } catch {
          // ignore
        }

        qrScanner = new QrScannerLib(
          video,
          (result) => {
            const text = (typeof result === 'string') ? result : (result?.data ?? '');
            const raw = String(text || '').trim();
            if (raw) handleQrValue(raw);
          },
          {
            preferredCamera: 'environment',
            highlightScanRegion: false,
            highlightCodeOutline: false,
          }
        );

        await qrScanner.start();
        setQrStatus('カメラ起動中… QRを枠内に合わせてください。');

      } else if ('BarcodeDetector' in window) {
        qrDetector = new BarcodeDetector({ formats: ['qr_code'] });
        qrRunning = true;
        requestAnimationFrame(qrTick);
        setQrStatus('カメラ起動中… QRを枠内に合わせてください。');
      } else {
        // Keep camera preview, but guide users to photo/manual in environments without a decoder.
        setQrStatus('カメラは起動しましたが、このブラウザではQR自動検出が利用できません。「写真で読み取る」または貼り付けをご利用ください。');
      }
    } catch (e) {
      const wrap = $('#qrCameraWrap');
      if (wrap) wrap.classList.add('hidden');
      setQrStatus('カメラの起動に失敗しました。権限設定を確認するか、"写真で読み取る"（撮影）をご利用ください。');
    }
  }

  function stopQrCamera() {
    qrRunning = false;
    // Stop qr-scanner if it is running
    if (qrScanner) {
      try { qrScanner.stop && qrScanner.stop(); } catch {}
      try { qrScanner.destroy && qrScanner.destroy(); } catch {}
      qrScanner = null;
    }
    try {
      const video = $('#qrVideo');
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    } catch {}
    if (qrStream) {
      try { qrStream.getTracks().forEach(t => t.stop()); } catch {}
    }
    qrStream = null;
    qrDetector = null;
  }

  async function decodeQrFromFile(file) {
    if (!file) return null;

    // Prefer qr-scanner for decoding images (works on iOS Safari where BarcodeDetector is unavailable)
    const QrScannerLib = window.QrScanner;
    if (QrScannerLib && typeof QrScannerLib.scanImage === 'function') {
      try {
        // returnDetailedScanResult may return { data, ... } depending on version
        const res = await QrScannerLib.scanImage(file, { returnDetailedScanResult: true });
        const text = (typeof res === 'string') ? res : (res?.data ?? '');
        const raw = String(text || '').trim();
        if (raw) return raw;
      } catch (err) {
        // Fallback to BarcodeDetector (if available)
      }
    }

    if (!('BarcodeDetector' in window)) return null;
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      // Prefer ImageBitmap for performance
      if ('createImageBitmap' in window) {
        const bmp = await createImageBitmap(file);
        const codes = await detector.detect(bmp);
        try { bmp.close && bmp.close(); } catch {}
        const raw = (codes && codes[0] && codes[0].rawValue) ? String(codes[0].rawValue).trim() : '';
        return raw || null;
      }

      // Fallback to <img> + canvas
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      const loaded = new Promise((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('img load failed'));
      });
      img.src = url;
      await loaded;
      URL.revokeObjectURL(url);

      if (!qrCanvas) {
        qrCanvas = document.createElement('canvas');
        qrCtx = qrCanvas.getContext('2d', { willReadFrequently: true });
      }
      qrCanvas.width = img.naturalWidth || img.width;
      qrCanvas.height = img.naturalHeight || img.height;
      qrCtx.drawImage(img, 0, 0);
      const codes = await detector.detect(qrCanvas);
      const raw = (codes && codes[0] && codes[0].rawValue) ? String(codes[0].rawValue).trim() : '';
      return raw || null;
    } catch (err) {
      console.warn('QR decode failed', err);
      return null;
    }
  }

  async function qrTick() {
    if (!qrRunning || !qrDetector) return;
    const video = $('#qrVideo');
    if (!video || video.readyState < 2) {
      requestAnimationFrame(qrTick);
      return;
    }

    try {
      const codes = await qrDetector.detect(video);
      if (codes && codes.length) {
        const raw = (codes[0].rawValue || '').trim();
        if (raw) {
          handleQrValue(raw);
          return;
        }
      }
    } catch {
      // ignore and keep scanning
    }
    requestAnimationFrame(qrTick);
  }

  function handleQrValue(value) {
    const v = (value || '').trim();
    if (!v) return;
    if (qrConfirming) return;

    if (qrPurpose === 'location') {
      applyLocationQr(v);
      closeQrModal();
      return;
    }

    if (qrPurpose === 'victim') {
      // Helmet/staff QR: ask for confirmation BEFORE saving.
      qrConfirming = true;
      pauseQrDecoder();

      const { hit, info } = findStaffFromQr(v);
      const showId = (hit?.id || info?.staffId || '').toString().trim() || '不明';
      const showName = (hit?.name || info?.name || '').toString().trim() || '不明';

      showOverlay(
        `${escapeHtml('職員ID：' + showId)}<br>${escapeHtml('氏名：' + showName)}<br><br>${escapeHtml('この職員で合っていますか？')}`,
        [
          {
            label: 'はい',
            style: 'primary',
            onClick: () => {
              try {
                closeOverlay();
                qrConfirming = false;
                applyVictimQr(v);
                closeQrModal();
              } catch (e) {
                console.error(e);
                qrConfirming = false;
                closeOverlay();
              }
            },
          },
          {
            label: 'いいえ',
            style: 'secondary',
            onClick: () => {
              try {
                closeOverlay();
                qrConfirming = false;
                setQrStatus('もう一度QRを読み取ってください。');
                // Small delay helps iOS Safari resume smoothly
                setTimeout(() => {
                  resumeQrDecoder();
                }, 150);
              } catch (e) {
                console.error(e);
                qrConfirming = false;
                closeOverlay();
              }
            },
          },
        ]
      );
      return;
    }

    // Fallback: close modal if purpose is unknown
    closeQrModal();
  }

  /**
   * 被災者検索モーダルの表示
   * 氏名／かなでスタッフを検索し、選択します。
   */
  function openVictimModal() {
    const modal = document.getElementById('victimModal');
    if (!modal) return;
    // Reset search field and list
    const input = document.getElementById('victimSearchModal');
    if (input) {
      input.value = '';
    }
    renderVictimModalList('');
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    // Attach handlers only once
    const closeBtn = document.getElementById('btnVictimClose');
    if (closeBtn && !closeBtn._bound) {
      closeBtn.addEventListener('click', closeVictimModal);
      closeBtn._bound = true;
    }
    modal.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'victimModal') closeVictimModal();
    });
    // Search input
    if (input && !input._bound) {
      input.addEventListener('input', (e) => {
        const q = (e.target.value || '').trim();
        renderVictimModalList(q);
      });
      input._bound = true;
    }
    // Unknown button
    const unknownBtn = document.getElementById('btnVictimUnknownModal');
    if (unknownBtn && !unknownBtn._bound) {
      unknownBtn.addEventListener('click', () => {
        // set onepage victim as unknown
        const victimLabel = document.getElementById('victimSelectedOne');
        if (victimLabel) victimLabel.textContent = '不明';
        // update state if exists
        if (window.__stateOneRef) {
          window.__stateOneRef.victim = { unknown: true };
        }
        closeVictimModal();
      });
      unknownBtn._bound = true;
    }
  }

  function closeVictimModal() {
    const modal = document.getElementById('victimModal');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  // Render staff list for victim search modal
  function renderVictimModalList(query) {
    const list = document.getElementById('victimListModal');
    if (!list) return;
    const q = (query || '').trim();
    // Filter staff (master.staff defined)
    const people = (master.staff || [])
      .map((p) => ({ ...p, company: getCompany(p.companyId)?.name || '' }))
      .filter((p) => {
        if (!q) return true;
        const hay = `${p.name} ${p.kana || ''} ${p.company || ''}`;
        return hay.includes(q);
      })
      .sort((a, b) => (a.kana || '').localeCompare(b.kana || '', 'ja'))
      .slice(0, 60);
    list.innerHTML = '';
    if (people.length === 0) {
      const d = document.createElement('div');
      d.className = 'small';
      d.textContent = '該当なし（よみ or 氏名で検索）';
      list.appendChild(d);
      return;
    }
    for (const p of people) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'list-btn';
      b.dataset.staff = p.id;
      b.innerHTML = `${escapeHtml(p.name)}<span class="sub">${escapeHtml(p.company)}</span>`;
      b.addEventListener('click', () => {
        // 氏名検索から選択した場合でも職員IDを入力するようにする
        const label = document.getElementById('victimSelectedOne');
        if (label) {
          label.textContent = p.id;
        }
        // update state: store staffId instead of arbitrary id/name
        if (window.__stateOneRef) {
          window.__stateOneRef.victim = { staffId: p.id };
        }
        closeVictimModal();
      });
      list.appendChild(b);
    }
  }

  function applyLocationQr(qr) {
    const { hit, info } = findLocationFromQr(qr);
    const raw = info.raw;

    state.wiz.location.qr = raw;
    state.wiz.location.unknown = false;

    if (hit) {
      state.wiz.location.name = hit.name || '';
    } else {
      // show that we DID read the QR, but couldn't match to master
      const cand = info.name ? `（候補: ${info.name}）` : '';
      state.wiz.location.name = `未登録の場所（管理で登録してください）${cand}`;
    }

    saveSession({ ...state, nav: nav.stack });
    renderWizardLocation();

    // Also reflect into one-page emergency input (if present)
    try {
      const one = window.__stateOneRef;
      const labelOne = document.getElementById('locationSelectedOne');
      const nameOne = hit ? (hit.name || '') : (state.wiz.location.name || '未選択');
      if (one) {
        one.location = { name: nameOne, qr: raw };
      }
      if (labelOne) labelOne.textContent = nameOne || '未選択';
      if (typeof window.__updateCallButton === 'function') window.__updateCallButton();

      if (hit) {
        toast('場所QRを読み取りました');
      } else {
        toast('場所QRは読み取れましたが、マスタに一致しません');
      }
    } catch {}
  }
  function applyVictimQr(qr) {
    const { hit, info } = findStaffFromQr(qr);
    const raw = info.raw;

    state.wiz.victim.qr = raw;

    if (hit) {
      state.wiz.victim.staffId = hit.id;
      state.wiz.victim.name = '';
      state.wiz.victim.unknown = false;
    } else {
      state.wiz.victim.staffId = null;
      state.wiz.victim.unknown = false;
      const cand = info.staffId ? `（候補ID: ${info.staffId}）` : (info.name ? `（候補: ${info.name}）` : '');
      state.wiz.victim.name = `未登録（管理で職員QRを登録してください）${cand}`;
    }

    saveSession({ ...state, nav: nav.stack });
    renderWizardVictim();

    // Also reflect into one-page emergency input (if present)
    try {
      const one = window.__stateOneRef;
      const labelOne = document.getElementById('victimSelectedOne');
      if (hit) {
        if (one) one.victim = { staffId: hit.id, qr: raw };
        if (labelOne) labelOne.textContent = hit.id;
        toast('職員QRを読み取りました');
      } else {
        if (one) one.victim = null;
        if (labelOne) labelOne.textContent = '未登録';
        toast('職員QRは読み取れましたが、マスタに一致しません');
      }
      if (typeof window.__updateCallButton === 'function') window.__updateCallButton();
    } catch {}
  }

  /** =========================
   *  Map modal (select location when QR not available)
   *  - SVGに地図画像を同一座標系で貼り、viewBoxでズーム切替（画像とポリゴンのズレを抑止）
   *  - 全体では「エリア1/2/3」だけ表示、エリア内で区画（多角形）表示
   *  - タップ位置から「近い候補」も提示して誤選択を減らす
   *  ========================= */

  // Map base coordinate system (polygons are defined in this space)
  // Map base coordinate system (polygons are defined in this space)
  // The new map images (map_overview.png and area maps) have different
  // dimensions than the original PDFs.  To prevent distortion and ensure
  // the SVG viewBox aligns with the pixel grid, set the base width and
  // height to match the map_overview.png resolution.  All polygons are
  // scaled into this coordinate space.
  const MAP_BASE_W = 2048;
  const MAP_BASE_H = 1864;

  // Images extracted from the PDFs (same aspect)
  const MAP_IMAGES = {
    // ルートディレクトリに配置されたPNGを参照
    all: 'map_overview.png',
    a1: 'map_area1.png',
    a2: 'map_area2.png',
    a3: 'map_area3.png',
  };

  // Overview shows ONLY these three polygons (area navigation)
  // These are intentionally rough but not just rectangles.
  // 地図エリアの境界を全面的に見直しました。
  // 新しいPNG（map_area1/2/3.png）は旧PDFから切り出したものではなく、
  // 左（エリア1）、下中央（エリア2）、右（エリア3）の単純な領域に分割されています。
  // このポリゴン定義ではそれぞれを長方形でカバーし、
  // MAP_BASE_W=3307 / MAP_BASE_H=2339 の座標系全体を漏れなく三分割します。
  const MAP_AREA_POLYS = {
    // Area boundaries have been recalculated against the new overview map.
    // These polygons roughly follow the dotted lines in map_overview.png.
    // The coordinate values are scaled from the original definitions to
    // MAP_BASE_W/MAP_BASE_H and rounded to the nearest pixel.
    // Approximate rectangular divisions for the overview map.  The yard is
    // divided into upper and lower halves by a horizontal boundary at
    // y=916, and into left/right halves by a vertical boundary at x=928.
    // Area1 occupies the upper right quadrant, Area2 the upper left, and
    // Area3 the entire lower half.  These shapes roughly follow the
    // dotted guidelines shown in map_overview.png and make it easy to
    // select the desired region even if the diagonal border is slightly
    // curved in the image.
    a1: [
      [928, 0], [2048, 0], [2048, 916], [928, 916],
    ],
    a2: [
      [0, 0], [928, 0], [928, 916], [0, 916],
    ],
    a3: [
      [0, 916], [2048, 916], [2048, 1864], [0, 1864],
    ],
  };

  const MAP_AREA_LABEL = { all: '全体', a1: 'エリア1', a2: 'エリア2', a3: 'エリア3' };

  // Polygon areas (points are in MAP_BASE_W/H coordinate space)
  const MAP_AREAS_RAW = [
    {
      name: '鋼材・SUB材置場',
      poly: [[1375, 191], [1561, 120], [1920, 120], [1920, 207], [1982, 311], [1982, 414], [1517, 510], [1424, 414]]
    },
    {
      name: '曲げ定盤',
      poly: [[1437, 518], [1585, 518], [1585, 980], [1437, 980]]
    },
    {
      name: 'ブロック置場',
      poly: [[1288, 566], [1796, 566], [1808, 964], [1598, 964], [1598, 1084], [1325, 1084]]
    },
    {
      name: 'パイプ置場',
      // Relocate the pipe yard into the upper eastern yard.  The original
      // polygon sat just below the area1/area3 boundary, causing it to be
      // classified as area3.  Subtract 350px from the y‑coordinates to
      // reposition it fully within the area1 view.
      poly: [[1598, 614], [1808, 614], [1808, 734], [1598, 734]]
    },
    {
      name: '食堂・協力業者ハウス',
      poly: [[1294, 478], [1517, 478], [1517, 566], [1294, 566]]
    },
    {
      name: 'SUB定盤',
      poly: [[774, 494], [1053, 446], [1270, 518], [1325, 653], [1115, 733], [855, 685], [774, 590]]
    },
    {
      name: 'SUB工場',
      poly: [[1090, 622], [1263, 622], [1263, 725], [1090, 725]]
    },
    {
      name: '事務所',
      poly: [[1090, 733], [1263, 733], [1263, 797], [1090, 797]]
    },
    {
      name: '南定盤3',
      poly: [[1053, 1036], [1208, 1036], [1208, 1156], [1053, 1156]]
    },
    {
      name: '南定盤2',
      poly: [[793, 1036], [1053, 1036], [1053, 1156], [793, 1156]]
    },
    {
      name: '加工場',
      poly: [[910, 1164], [1009, 1164], [1009, 1275], [910, 1275]]
    },
    {
      name: 'パイプ工場',
      poly: [[1016, 1164], [1152, 1164], [1152, 1275], [1016, 1275]]
    },
    {
      // The original image labels this shape as "電気室・コンプレッサー室" but the app UI
      // expects "電気室" as a single place. Rename accordingly to avoid
      // mismatches when selecting from the map.
      name: '電気室',
      poly: [[1152, 1148], [1282, 1195], [1362, 1307], [1239, 1379], [1102, 1291]]
    },
    {
      name: '北定盤2',
      poly: [[285, 478], [403, 478], [403, 598], [310, 653], [260, 606]]
    },
    {
      name: 'ピース切断場',
      poly: [[161, 446], [254, 446], [254, 518], [161, 518]]
    },
    {
      name: '道具置場',
      poly: [[266, 454], [322, 454], [322, 518], [266, 518]]
    },
    {
      name: '施設作業場',
      poly: [[161, 414], [260, 414], [260, 446], [161, 446]]
    },
    {
      name: '旧ガスセンター工場',
      poly: [[607, 470], [762, 470], [762, 542], [607, 542]]
    },
    {
      name: 'B棟',
      poly: [[279, 574], [681, 574], [681, 685], [279, 685]]
    },
    {
      name: '北定盤1',
      poly: [[173, 677], [310, 677], [310, 781], [173, 781]]
    },
    {
      name: 'A棟',
      poly: [[347, 717], [904, 717], [904, 813], [347, 813]]
    },
    {
      name: 'DOCK',
      poly: [[130, 789], [198, 789], [198, 869], [130, 869]]
    },
    {
      name: '建造船',
      // Raise the construction ship area slightly so it fits within the
      // エリア2 map when reassigned.  Subtract 100px from the original
      // y‑coordinates to bring the shape above the area boundary.
      poly: [[260, 729], [892, 729], [892, 904], [260, 904]]
    },
    {
      name: '艤装岸壁',
      poly: [[390, 1004], [452, 1004], [452, 1554], [390, 1554]]
    },
    {
      name: '70t JC',
      poly: [[458, 1004], [508, 1004], [508, 1554], [458, 1554]]
    },
    {
      name: 'C棟',
      poly: [[526, 1036], [638, 1036], [638, 1530], [526, 1530]]
    },
    {
      name: '艤装品置場',
      poly: [[508, 1419], [638, 1419], [638, 1530], [508, 1530]]
    },
    {
      name: 'スクラップ場',
      poly: [[644, 1474], [731, 1474], [731, 1634], [644, 1634]]
    },
    // Additional foot scaffolding yard in area3 (top-right).  The second
    // location shares the same name "足場材置場" but resides in the
    // eastern (area3) region.  Approximate coordinates based on
    // map_area3.png ensure this yard appears when selecting エリア3.
    {
      name: '足場材置場',
      poly: [[1951, 120], [2013, 120], [2013, 239], [1951, 239]]
    },

    // --- Additional locations added per user feedback ---
    // These polygons are approximate bounding boxes based on visual inspection
    // of the provided map images. They ensure each named location can be
    // selected from the map even if the exact shape is unknown. Adjust
    // coordinates as necessary if more accurate outlines are required.
    {
      name: 'S.E.BOX',
      poly: [[1387, 398], [1449, 398], [1449, 462], [1387, 462]]
    },
    {
      name: '機電装課',
      // Move the 機電装課 polygon upward so that it appears within エリア1.  The
      // department sits in the eastern yard but its centroid fell below the
      // horizontal boundary into area3.  Shifting its y‑coordinates by
      // −350px aligns it with the other area1 locations.
      poly: [[1598, 734], [1672, 734], [1672, 798], [1598, 798]]
    },
    {
      name: '守衛室',
      // Shift the guard house eastward into エリア1.  The original coordinates
      // placed it on the western side (エリア2) even though it belongs in the
      // eastern yard.  Move the x‑coordinates to around 1000px while
      // retaining the original size so that it shows up in the correct
      // region.
      poly: [[1000, 701], [1062, 701], [1062, 749], [1000, 749]]
    },
    {
      name: '足場材置場',
      poly: [[1288, 757], [1375, 757], [1375, 837], [1288, 837]]
    },
    {
      name: '艤装定盤',
      poly: [[929, 1116], [1022, 1116], [1022, 1275], [929, 1275]]
    },
    {
      name: '南定盤',
      poly: [[793, 1156], [1053, 1156], [1053, 1634], [793, 1634]]
    },
    {
      name: '艤装船1',
      poly: [[1239, 956], [1362, 956], [1362, 1275], [1239, 1275]]
    },
    {
      name: '艤装船2',
      poly: [[1270, 1315], [1393, 1315], [1393, 1634], [1270, 1634]]
    },
  ];


  // --- Internal derived structures ---
  function polyCentroid(poly) {
    // simple average (robust enough for our usage)
    let sx = 0, sy = 0;
    for (const [x,y] of poly) { sx += x; sy += y; }
    return { x: sx / poly.length, y: sy / poly.length };
  }

  function pointInPoly(pt, poly) {
    // ray casting
    let inside = false;
    for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
      const xi=poly[i][0], yi=poly[i][1];
      const xj=poly[j][0], yj=poly[j][1];
      const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function dist2(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return dx*dx + dy*dy; }

  function areaKeyByPoint(pt){
    for (const k of ['a1','a2','a3']) {
      if (pointInPoly(pt, MAP_AREA_POLYS[k])) return k;
    }
    // fallback: nearest area centroid
    let best='a1', bestD=Infinity;
    for (const k of ['a1','a2','a3']) {
      const c = polyCentroid(MAP_AREA_POLYS[k]);
      const d = dist2(pt, c);
      if (d < bestD) { bestD=d; best=k; }
    }
    return best;
  }

  function placeAreaKey(place){
    // Determine which area a place belongs to by performing a point-in-polygon
    // test against the area boundaries. This avoids relying on simplistic
    // thresholds that may misclassify places when the coordinate space or
    // layout changes. If no area contains the point, fall back to the
    // nearest area's centroid.
    return areaKeyByPoint({ x: place.cx, y: place.cy });
  }

  const MAP_PLACES = MAP_AREAS_RAW.map((p) => {
    const c = polyCentroid(p.poly);
    const obj = { ...p, cx: c.x, cy: c.y };
    obj.areaKey = placeAreaKey(obj);
    // Override area assignments for known places whose centroids fall
    // close to a different region than their intended classification.  Some
    // names (e.g. 南定盤3, 艤装定盤) appear in the eastern yard but our
    // approximate polygons place them near the center, causing the automatic
    // point‑in‑polygon test to misclassify them as area2.  For these
    // specific names we explicitly assign them to area3.  Additionally,
    // handle duplicate names like "足場材置場" by checking the centroid
    // position: the eastern yard version (x coordinate > 2400) belongs to
    // area3, while the western version remains in area2.
    const overrideToA3 = new Set([
      '電気室','南定盤3','艤装定盤','南定盤2','加工場','パイプ工場','道具置場',
      'C棟','南定盤','スクラップ場','艤装品置場','艤装岸壁','艤装船1','艤装船2'
    ]);
    if (overrideToA3.has(obj.name)) {
      obj.areaKey = 'a3';
    }
    // 足場材置場 is present in both area2 and area3.  Distinguish by x
    // coordinate: the eastern (area3) yard lies far to the right in the
    // base coordinate space.  The original code used a cutoff of 2400 on
    // a 3307‑pixel‑wide base image.  Scale this threshold based on the
    // current MAP_BASE_W to ensure we assign the correct area when the
    // coordinate system changes.  For example, if MAP_BASE_W=2048 then
    // the threshold becomes roughly 1485 (i.e. 2400 * 2048 / 3307).
    const footThreshold = 2400 * (MAP_BASE_W / 3307);
    if (obj.name === '足場材置場' && obj.cx > footThreshold) {
      obj.areaKey = 'a3';
    }

    // --- Custom area overrides -------------------------------------------------
    // Certain locations need to be reassigned to a different area based on
    // revised yard definitions.  The automatic centroid‑based classification
    // places these polygons into areas that no longer match the updated map
    // specification.  Use explicit overrides to ensure they appear in the
    // correct region.  These sets can be expanded as more adjustments are
    // requested.
    const overrideToA1 = new Set([
      // Move 守衛室 from area2 into area1.  Its centroid lies in the top‑left
      // quadrant, but the guard house belongs to the eastern (エリア1) yard.
      '守衛室',
      // Move パイプ置場 from area3 into area1.  The pipe yard sits just below
      // the boundary line but should be associated with the upper right yard.
      'パイプ置場',
      // Move 機電装課 from area3 into area1.  This department is located in the
      // eastern yard despite its centroid falling within the lower half of
      // the base coordinate space.
      '機電装課',
    ]);
    const overrideToA2 = new Set([
      // Move 建造船 from area3 into area2.  The ship under construction
      // occupies the western yard even though its polygon extends across
      // the horizontal boundary.
      '建造船',
    ]);
    if (overrideToA1.has(obj.name)) {
      obj.areaKey = 'a1';
    } else if (overrideToA2.has(obj.name)) {
      obj.areaKey = 'a2';
    }
    return obj;
  });

  /**
   * Calculate a viewBox for a given area that always includes the full area image.
   *
   * The previous implementation derived the bounding box from the polygons of
   * individual places. That worked reasonably well when every area had many
   * polygons, but breaks down when new places are missing or when a new map
   * image is introduced. To guarantee that the background map (map_area*.png)
   * is fully visible when an area tab is selected, base the bounding box on
   * the area polygons defined in MAP_AREA_POLYS instead of the per‑place
   * polygons. This ensures that the entire region is shown regardless of how
   * many places are defined within it.
   */
  function computeAreaViewBox(areaKey){
    /**
     * Derive a viewBox for a given area.  Instead of only looking at the
     * corresponding area polygon (which might not encompass all of the
     * individual place shapes) we combine the bounding boxes of the area
     * polygon and all the polygons of places that belong to that area.  This
     * ensures the generated view box always contains every polygon drawn in
     * that area.  A modest padding is applied to the result to avoid
     * clipping near the edges.
     */
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // include area boundary itself
    const areaPoly = MAP_AREA_POLYS[areaKey];
    if (areaPoly) {
      for (const [x, y] of areaPoly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    // include all place polygons assigned to this area
    for (const p of MAP_PLACES) {
      if (p.areaKey !== areaKey) continue;
      for (const [x, y] of p.poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    // Fallback to entire map if no coordinates found
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
      return { x: 0, y: 0, w: MAP_BASE_W, h: MAP_BASE_H };
    }
    // Padding
    // Use a generous padding to ensure that the underlying map image is
    // fully visible even when only a few place polygons are present.  A larger
    // pad value reduces the chance of clipping the edge of the area map.  800
    // pixels corresponds to roughly one third of the height of the original
    // area images in MAP_IMAGES.
    const pad = 800;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(MAP_BASE_W, maxX + pad);
    maxY = Math.min(MAP_BASE_H, maxY + pad);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  const AREA_VIEWBOX = {
    a1: computeAreaViewBox('a1'),
    a2: computeAreaViewBox('a2'),
    a3: computeAreaViewBox('a3'),
  };

  let mapView = 'all'; // 'all' | 'a1' | 'a2' | 'a3'
  let mapSelected = null; // selected place object
  let mapTap = null; // {x,y}
  let mapCandidates = [];

  function setMapTabActive(key){
    const ids = {
      all: 'btnMapViewAll',
      a1: 'btnMapViewA1',
      a2: 'btnMapViewA2',
      a3: 'btnMapViewA3',
    };
    for (const [k,id] of Object.entries(ids)) {
      const el = $('#'+id);
      if (!el) continue;
      const is = (k === key);
      el.classList.toggle('active', is);
      el.setAttribute('aria-selected', is ? 'true' : 'false');
    }
    const reset = $('#btnMapResetZoom');
    if (reset) reset.disabled = (key === 'all');
  }

  function svgPointFromEvent(svg, ev){
    const pt = svg.createSVGPoint();
    const t = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    pt.x = t.clientX;
    pt.y = t.clientY;
    const m = svg.getScreenCTM();
    if (!m) return null;
    return pt.matrixTransform(m.inverse());
  }

  function clearSvg(svg){
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  function createSvg(tag){
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  function renderYardSvg(){
    const svg = $('#yardSvg');
    if (!svg) return;

    clearSvg(svg);

    // ViewBox
    if (mapView === 'all') {
      svg.setAttribute('viewBox', `0 0 ${MAP_BASE_W} ${MAP_BASE_H}`);
    } else {
      const vb = AREA_VIEWBOX[mapView];
      svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    }

    // Background image fixed to base coordinate space
    const bg = createSvg('image');
    bg.setAttribute('id', 'yardBg');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(MAP_BASE_W));
    bg.setAttribute('height', String(MAP_BASE_H));
    bg.setAttribute('preserveAspectRatio', 'none');
    // set both for better compatibility
    bg.setAttribute('href', MAP_IMAGES[mapView] || MAP_IMAGES.all);
    bg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', MAP_IMAGES[mapView] || MAP_IMAGES.all);
    svg.appendChild(bg);

    if (mapView === 'all') {
      // Area navigation polygons only
      for (const k of ['a1','a2','a3']) {
        const poly = createSvg('polygon');
        poly.setAttribute('class', 'map-area');
        poly.setAttribute('data-area', k);
        poly.setAttribute('points', MAP_AREA_POLYS[k].map(([x,y]) => `${x},${y}`).join(' '));
        svg.appendChild(poly);

        // label
        const c = polyCentroid(MAP_AREA_POLYS[k]);
        const tx = createSvg('text');
        tx.setAttribute('x', String(c.x));
        tx.setAttribute('y', String(c.y));
        tx.setAttribute('text-anchor', 'middle');
        tx.setAttribute('dominant-baseline', 'middle');
        tx.setAttribute('class', 'map-area-label');
        tx.textContent = MAP_AREA_LABEL[k];
        svg.appendChild(tx);
      }
    } else {
      // Detailed place polygons for this area
      const places = MAP_PLACES.filter(p => p.areaKey === mapView);
      for (const p of places) {
        const poly = createSvg('polygon');
        poly.setAttribute('class', 'map-poly' + (mapSelected?.name === p.name ? ' active' : ''));
        poly.setAttribute('data-name', p.name);
        poly.setAttribute('points', p.poly.map(([x,y]) => `${x},${y}`).join(' '));
        svg.appendChild(poly);
      }

      // Marker (selected place)
      if (mapSelected) {
        const dot = createSvg('circle');
        dot.setAttribute('class', 'map-dot');
        dot.setAttribute('cx', String(mapSelected.cx));
        dot.setAttribute('cy', String(mapSelected.cy));
        dot.setAttribute('r', '18');
        svg.appendChild(dot);
      } else if (mapTap) {
        const dot = createSvg('circle');
        dot.setAttribute('class', 'map-dot');
        dot.setAttribute('cx', String(mapTap.x));
        dot.setAttribute('cy', String(mapTap.y));
        dot.setAttribute('r', '14');
        svg.appendChild(dot);
      }
    }
  }

  function renderMapCandidates(){
    const wrap = $('#mapCandidates');
    if (!wrap) return;
    wrap.innerHTML = '';

    if (!mapCandidates.length) {
      const span = document.createElement('div');
      span.className = 'small';
      span.style.opacity = '.8';
      span.textContent = '（タップすると候補が表示されます）';
      wrap.appendChild(span);
      return;
    }

    mapCandidates.forEach((c, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-cand' + (idx === 0 ? ' primary' : '');
      b.dataset.name = c.name;
      b.textContent = c.name;
      wrap.appendChild(b);
    });
  }

  function setMapView(key){
    mapView = key;
    setMapTabActive(key);
    // Clear candidates when switching view
    mapCandidates = [];
    renderMapCandidates();
    renderYardSvg();
    renderMapList($('#mapSearch')?.value || '');
  }

  function setMapSelected(place){
    mapSelected = place;
    const sel = $('#mapSelectedLabel');
    if (sel) sel.textContent = place ? place.name : '未選択';
    const useBtn = $('#btnMapUse');
    if (useBtn) useBtn.disabled = !place;
    renderYardSvg();
  }

  function updateCandidatesFromTap(pt){
    const pool = (mapView === 'all') ? MAP_PLACES : MAP_PLACES.filter(p => p.areaKey === mapView);
    const scored = pool.map(p => ({ name: p.name, p, d: dist2(pt, {x:p.cx,y:p.cy}) }));
    scored.sort((a,b) => a.d - b.d);
    mapCandidates = scored.slice(0, 6).map(s => s.p);
    renderMapCandidates();

    // Auto-select the nearest (fast), but user can override by tapping another candidate
    setMapSelected(mapCandidates[0] || null);
  }

  function handleMapTap(ev){
    const svg = $('#yardSvg');
    if (!svg) return;
    const p = svgPointFromEvent(svg, ev);
    if (!p) return;

    const pt = { x: p.x, y: p.y };
    mapTap = pt;

    if (mapView === 'all') {
      const key = areaKeyByPoint(pt);
      setMapView(key);
      // When entering area view, precompute candidates
      updateCandidatesFromTap(pt);
      return;
    }

    // In area view, update candidates from this tap
    updateCandidatesFromTap(pt);
  }

  function renderMapList(filterText){
    const list = $('#mapList');
    if (!list) return;
    const q = (filterText || '').trim();

    let items = MAP_PLACES;
    if (mapView !== 'all') items = items.filter(p => p.areaKey === mapView);

    if (q) {
      items = items.filter(p => (p.name || '').includes(q));
    }

    list.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'small';
      empty.style.opacity = '.8';
      empty.style.padding = '10px 2px';
      empty.textContent = '該当する場所がありません';
      list.appendChild(empty);
      return;
    }

    // Sort by name for predictability
    items = items.slice().sort((a,b) => a.name.localeCompare(b.name, 'ja'));

    for (const p of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'map-row' + (mapSelected?.name === p.name ? ' active' : '');
      row.dataset.name = p.name;
      row.innerHTML = `<span class="map-row-name">${p.name}</span><span class="map-row-meta">${MAP_AREA_LABEL[p.areaKey]}</span>`;
      list.appendChild(row);
    }
  }

  function openMapModal(){
    const modal = $('#mapModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    // Start from overview for consistency
    mapView = 'all';
    mapSelected = null;
    mapTap = null;
    mapCandidates = [];

    const q = $('#mapSearch');
    if (q) q.value = '';

    setMapTabActive('all');
    renderYardSvg();
    renderMapCandidates();
    renderMapList('');

    const sel = $('#mapSelectedLabel');
    if (sel) sel.textContent = '未選択';
    const useBtn = $('#btnMapUse');
    if (useBtn) useBtn.disabled = true;
  }

  function closeMapModal(){
    const modal = $('#mapModal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('modal-open');

    // One-shot callback (e.g., emergency flow) after the map modal is closed.
    try {
      const cb = window.__mapModalCloseCb;
      window.__mapModalCloseCb = null;
      if (typeof cb === 'function') cb();
    } catch (e) {
      console.error(e);
      window.__mapModalCloseCb = null;
    }
  }

  function applyMapSelectionToLocation(){
    if (!mapSelected) return toast('場所を選択してください');
    if (!state.wiz?.location) state.wiz = defaultWizardState();
    state.wiz.location = { qr: state.wiz.location.qr || '', name: mapSelected.name, unknown: false };
    const manual = $('#locationManual');
    if (manual) manual.value = mapSelected.name;
    renderWizardLocation();
    saveSession({ ...state, nav: nav.stack });
    closeMapModal();
  }

  function findPlaceByName(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    return MAP_PLACES.find((p) => p.name === n) || null;
  }

  function resetMapSelection(opts = {}) {
    const keepView = opts.keepView !== false;
    mapSelected = null;
    mapTap = null;
    mapCandidates = [];

    const sel = $('#mapSelectedLabel');
    if (sel) sel.textContent = '未選択';
    const useBtn = $('#btnMapUse');
    if (useBtn) useBtn.disabled = true;

    if (!keepView) {
      mapView = 'all';
      setMapTabActive('all');
    }
    renderMapCandidates();
    renderYardSvg();
    renderMapList($('#mapSearch')?.value || '');
  }


function renderCompanyList() {
    const wrap = $('#companyList');
    if (!wrap) return;
    wrap.innerHTML = '';

    for (const c of master.companies) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-btn';
      btn.setAttribute('role', 'listitem');

      const emails = (c.emails || []).join(', ');
      btn.innerHTML = `${escapeHtml(c.name)}<span class="sub">${emails ? '送信先: ' + escapeHtml(emails) : ''}</span>`;
      btn.addEventListener('click', () => {
        state.companyId = c.id;
        state.personId = null;
        saveSession({ ...state, nav: nav.stack });

        // Affiliation -> staff selection (unsure flow also uses staff selection)
        renderKanaBar();
        renderPersonList('あ');
        nav.show('view-person');
      });
      wrap.appendChild(btn);
    }
  }

  function renderKanaBar() {
    const bar = $('#kanaBar');
    if (!bar) return;
    bar.innerHTML = '';

    const groups = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '他'];
    groups.forEach((g, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kana-btn';
      b.textContent = g;
      b.addEventListener('click', () => {
        $$('#kanaBar .kana-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        renderPersonList(g);
      });
      if (idx === 0) b.classList.add('active');
      bar.appendChild(b);
    });
  }

  function renderPersonList(groupLabel) {
    const list = $('#personList');
    if (!list) return;
    list.innerHTML = '';

    const people = master.staff
      .filter((p) => p.companyId === state.companyId)
      .map((p) => ({ ...p, group: kanaGroupFromKana(p.kana) }))
      .filter((p) => (groupLabel ? p.group === groupLabel : true))
      .sort((a, b) => (a.kana || '').localeCompare(b.kana || '', 'ja'));

    if (people.length === 0) {
      const div = document.createElement('div');
      div.className = 'small';
      div.textContent = '該当する職員がいません（管理画面で登録してください）。';
      list.appendChild(div);
      return;
    }

    for (const p of people) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list-btn';
      btn.setAttribute('role', 'listitem');
      btn.innerHTML = `${escapeHtml(p.name)}<span class="sub">よみ: ${escapeHtml(p.kana || '')}</span>`;
      btn.addEventListener('click', () => {
        state.personId = p.id;
        saveSession({ ...state, nav: nav.stack });

        const s = getSituation(state.situationId);

        // Safety: if body is required but not selected yet, ask body first
        if (s && s.requiresBody && !state.bodyPartId) {
          $('#bodyTitle').textContent = s.label;
          nav.show('view-body');
          return;
        }

        if (state.mode === 'emergency') {
          showEmergencyCallView();
          return;
        }

        // unsure flow -> result + (existing) mail preview
        buildResultPreview();
        nav.show('view-result');
      });
      list.appendChild(btn);
    }
  }

  function renderBodyPartsHandlers() {
    $$('#bodySvg .body-part').forEach((el) => {
      el.addEventListener('click', () => {
        $$('#bodySvg .body-part').forEach((p) => p.classList.remove('selected'));
        el.classList.add('selected');
        state.bodyPartId = el.getAttribute('data-part');
        const bp = getBodyPart(state.bodyPartId);
        $('#bodySelectedLabel').textContent = bp ? bp.label : '選択中';
        $('#btnBodyNext').disabled = !state.bodyPartId;
        saveSession({ ...state, nav: nav.stack });
      });
    });
  }

  /** =========================
   *  Result / mail preview
   *  ========================= */
  function interpolate(tpl, vars) {
    return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
  }

  function buildRecipientsForAction(action) {
    const s = getSituation(state.situationId);
    const c = getCompany(state.companyId);

    const scope = master.sendScope || { safetyHQ: true, rescueTeam: true, ambulanceCenter: true, companyEmails: true };

    const groups = action === 'emergency' ? (s?.includeEmergency || []) : (s?.includeObserve || []);
    const to = [];

    // global groups
    for (const g of groups) {
      if (g === 'safetyHQ' && scope.safetyHQ && master.globalContacts.safetyHQ) to.push(master.globalContacts.safetyHQ);
      if (g === 'rescueTeam' && scope.rescueTeam && master.globalContacts.rescueTeam) to.push(master.globalContacts.rescueTeam);
      if (g === 'ambulanceCenter' && scope.ambulanceCenter && master.globalContacts.ambulanceCenter) to.push(master.globalContacts.ambulanceCenter);
    }

    // company contacts
    if (scope.companyEmails && c && c.emails) to.push(...c.emails);

    // de-dup
    return Array.from(new Set(to.filter(Boolean)));
  }

  function showEmergencyCallView() {
    // Emergency mode: auto "request" (demo) + mail launch button only (no preview UI)
    state.action = 'emergency';
    state.preview = buildMail('emergency');

    nav.show('view-emergency');
    saveSession({ ...state, nav: nav.stack });

    // Demo feedback
    toast('（デモ）救急要請を開始しました');
  }


  function buildMail(action) {
    const s = getSituation(state.situationId);
    const c = getCompany(state.companyId);
    const p = getPerson(state.personId);
    const bp = getBodyPart(state.bodyPartId);

    const time = nowIsoLocal();
    const part = bp ? bp.label : '';
    const detail = state.detailNote || '';
    const vars = {
      company: c?.name || '',
      person: p?.name || '',
      time,
      part,
      detail: detail || '（追記なし）',
    };

    const subject = interpolate(s?.subjectTpl || '[命をツナゲル] 連絡', vars);
    const bodyTpl = action === 'emergency' ? s?.bodyTplEmergency : s?.bodyTplObserve;
    const body = interpolate(bodyTpl || '{person} {company} {time}', vars);

    return { to: buildRecipientsForAction(action), subject, body };
  }

  function buildResultText(action) {
    const s = getSituation(state.situationId);
    return action === 'emergency' ? s?.recommendTextEmergency : s?.recommendTextObserve;
  }

  function buildResultPreview() {
    const s = getSituation(state.situationId);
    const action = state.action || s?.defaultAction || 'observe';

    state.action = action;
    state.preview = buildMail(action);

    // Summary
    $('#sumStatus').textContent = s?.label || '-';
    $('#sumCompany').textContent = getCompany(state.companyId)?.name || '-';
    $('#sumPerson').textContent = getPerson(state.personId)?.name || '-';

    const bp = getBodyPart(state.bodyPartId);
    const detail = bp ? `${bp.label}${s?.id === 'pain' ? 'に痛み' : ''}` : '';
    const hasDetail = Boolean(detail);
    $('#sumDetailRow').style.display = hasDetail ? 'flex' : 'none';
    $('#sumDetail').textContent = hasDetail ? detail : '-';

    // Result text
    $('#resultText').textContent = buildResultText(action) || '';

    // Buttons labels/toggles
    const btnE = $('#btnActionEmergency');
    const btnO = $('#btnActionObserve');

    // In emergency mode / emergency default, keep emergency prominent but still allow observe.
    btnE.style.display = 'block';
    btnO.style.display = 'block';

    // Preview
    $('#mailToPreview').textContent = (state.preview.to || []).join(', ') || '-';
    $('#mailSubjectPreview').textContent = state.preview.subject || '-';
    $('#mailBodyPreview').textContent = state.preview.body || '-';

    saveSession({ ...state, nav: nav.stack });
  }

  async function copyPreview() {
    const text =
      `宛先: ${state.preview.to.join(', ')}\n` +
      `件名: ${state.preview.subject}\n` +
      `本文:\n${state.preview.body}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('コピーしました');
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('コピーしました');
    }
  }

  function openMail() {
    const { to, subject, body } = state.preview;
    const href = mailtoLink(to, subject, body);
    // Must be user gesture; called inside click handlers
    window.location.href = href;
  }

  /** =========================
   *  Admin (password-protected)
   *  ========================= */
  const admin = {
    authed: false,
    async initGate() {
      const hasPass = Boolean(master.admin.passwordHash);
      $('#adminFirstSet').classList.toggle('hidden', hasPass);
      $('#adminLogin').classList.toggle('hidden', !hasPass);
      $('#adminGateMsg').textContent = '';
    },
    async setPass() {
      const p1 = $('#adminNewPass1').value;
      const p2 = $('#adminNewPass2').value;
      if (!p1 || p1.length < 4) return (toast('4文字以上で設定してください'), void 0);
      if (p1 !== p2) return (toast('確認が一致しません'), void 0);
      master.admin.passwordHash = await sha256Hex(p1);
      saveMaster(master);
      toast('パスワードを設定しました');
      await admin.initGate();
    },
    async login() {
      const p = $('#adminPass').value;
      if (!p) return toast('パスワードを入力してください');
      const h = await sha256Hex(p);
      if (h !== master.admin.passwordHash) {
        $('#adminGateMsg').textContent = 'パスワードが違います。';
        toast('ログイン失敗');
        return;
      }
      admin.authed = true;
      $('#adminGate').classList.add('hidden');
      $('#adminPanel').classList.remove('hidden');
      toast('ログインしました');
      renderAdminAll();
    },
    logout() {
      admin.authed = false;
      $('#adminGate').classList.remove('hidden');
      $('#adminPanel').classList.add('hidden');
      $('#adminPass').value = '';
      admin.initGate();
    },
    async changePass() {
      const oldP = $('#adminChangeOld').value;
      const n1 = $('#adminChangeNew1').value;
      const n2 = $('#adminChangeNew2').value;
      const msg = $('#adminChangeMsg');
      msg.textContent = '';

      if (!oldP || !n1 || !n2) return (msg.textContent = 'すべて入力してください');
      if (n1 !== n2) return (msg.textContent = '確認が一致しません');
      const hOld = await sha256Hex(oldP);
      if (hOld !== master.admin.passwordHash) return (msg.textContent = '現在のパスワードが違います');
      if (n1.length < 4) return (msg.textContent = '4文字以上で設定してください');

      master.admin.passwordHash = await sha256Hex(n1);
      saveMaster(master);
      msg.textContent = '変更しました';
      toast('パスワードを変更しました');
      $('#adminChangeOld').value = '';
      $('#adminChangeNew1').value = '';
      $('#adminChangeNew2').value = '';
    },
  };

  function renderAdminAll() {
    renderAdminCompanies();
    renderAdminGlobalContacts();
    renderAdminStaffSelectors();
    renderAdminStaffList();
    renderAdminLocations();
    renderAdminSituations();
  }

  function renderAdminCompanies() {
    const wrap = $('#adminCompanies');
    wrap.innerHTML = '';

    master.companies.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'admin-item';

      const emails = (c.emails || []).join(', ');
      div.innerHTML = `
        <div><strong>${escapeHtml(c.name)}</strong> <span class="small">(${escapeHtml(c.id)})</span></div>
        <div class="small">送信先: ${escapeHtml(emails)}</div>
        <div class="form-grid">
          <input data-k="name" value="${escapeHtml(c.name)}" />
          <input data-k="emails" value="${escapeHtml(emails)}" />
          <button class="btn btn-secondary" data-act="save">保存</button>
          <button class="btn btn-secondary" data-act="del">削除</button>
        </div>
      `;

      div.querySelector('[data-act="save"]').addEventListener('click', () => {
        const name = div.querySelector('input[data-k="name"]').value.trim();
        const em = normalizeEmails(div.querySelector('input[data-k="emails"]').value);
        if (!name) return toast('会社名を入力してください');
        c.name = name;
        c.emails = em;
        saveMaster(master);
        toast('保存しました');
        renderCompanyList();
        renderAdminCompanies();
      });

      div.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm('削除しますか？（所属と紐づく職員がいる場合は注意）')) return;
        master.companies = master.companies.filter((x) => x.id !== c.id);
        // detach staff
        master.staff = master.staff.map((s) => (s.companyId === c.id ? { ...s, companyId: '' } : s));
        saveMaster(master);
        toast('削除しました');
        renderCompanyList();
        renderAdminAll();
      });

      wrap.appendChild(div);
    });
  }

  function renderAdminGlobalContacts() {
    $('#gcSafetyHQ').value = master.globalContacts.safetyHQ || '';
    $('#gcRescueTeam').value = master.globalContacts.rescueTeam || '';
    $('#gcAmbulance').value = master.globalContacts.ambulanceCenter || '';

    // scope checkboxes
    $('#scopeSafetyHQ').checked = !!master.sendScope?.safetyHQ;
    $('#scopeRescueTeam').checked = !!master.sendScope?.rescueTeam;
    $('#scopeAmbulance').checked = !!master.sendScope?.ambulanceCenter;
    $('#scopeCompanyEmails').checked = !!master.sendScope?.companyEmails;
  }

  function renderAdminStaffSelectors() {
    const sel1 = $('#staffCompanyFilter');
    const sel2 = $('#newStaffCompany');
    sel1.innerHTML = '';
    sel2.innerHTML = '';

    const optAll = document.createElement('option');
    optAll.value = '__all__';
    optAll.textContent = 'すべて';
    sel1.appendChild(optAll);

    master.companies.forEach((c) => {
      const o1 = document.createElement('option');
      o1.value = c.id;
      o1.textContent = c.name;
      sel1.appendChild(o1);

      const o2 = document.createElement('option');
      o2.value = c.id;
      o2.textContent = c.name;
      sel2.appendChild(o2);
    });
  }

  function renderAdminStaffList() {
    const wrap = $('#adminStaff');
    const filter = $('#staffCompanyFilter').value || '__all__';
    wrap.innerHTML = '';

    let items = master.staff.slice();
    if (filter !== '__all__') items = items.filter((s) => s.companyId === filter);

    if (items.length === 0) {
      const d = document.createElement('div');
      d.className = 'small';
      d.textContent = '職員が未登録です。';
      wrap.appendChild(d);
      return;
    }

    items
      .slice()
      .sort((a, b) => (a.kana || '').localeCompare(b.kana || '', 'ja'))
      .forEach((s) => {
        const div = document.createElement('div');
        div.className = 'admin-item';

        const companyName = getCompany(s.companyId)?.name || '（未設定）';
        div.innerHTML = `
          <div><strong>${escapeHtml(s.name)}</strong> <span class="small">(${escapeHtml(companyName)})</span></div>
          <div class="small">よみ: ${escapeHtml(s.kana || '')} / グループ: ${escapeHtml(kanaGroupFromKana(s.kana))}</div>
          <div class="form-grid">
            <select data-k="company"></select>
            <!-- 職員IDを編集可能にする入力欄を追加 -->
            <input data-k="id" value="${escapeHtml(s.id)}" placeholder="ID" />
            <input data-k="name" value="${escapeHtml(s.name)}" />
            <input data-k="kana" value="${escapeHtml(s.kana || '')}" />
            <input data-k="qr" value="${escapeHtml(s.qr || '')}" placeholder="ヘルメットQR（任意）" />
            <button class="btn btn-secondary" data-act="save">保存</button>
            <button class="btn btn-secondary" data-act="del">削除</button>
          </div>
        `;

        const sel = div.querySelector('select[data-k="company"]');
        master.companies.forEach((c) => {
          const o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.name;
          if (c.id === s.companyId) o.selected = true;
          sel.appendChild(o);
        });

        div.querySelector('[data-act="save"]').addEventListener('click', () => {
          const name = div.querySelector('input[data-k="name"]').value.trim();
          const kana = div.querySelector('input[data-k="kana"]').value.trim();
          const qr = div.querySelector('input[data-k="qr"]').value.trim();
          const companyId = div.querySelector('select[data-k="company"]').value;
          // IDは空欄不可。編集時に重複チェックは行わないが、空欄の場合は警告する
          const idVal = div.querySelector('input[data-k="id"]').value.trim();
          if (!name) return toast('氏名を入力してください');
          if (!kana) return toast('よみ（かな）を入力してください');
          if (!idVal) return toast('IDを入力してください');
          s.name = name;
          s.kana = kana;
          s.qr = qr;
          s.companyId = companyId;
          s.id = idVal;
          saveMaster(master);
          toast('保存しました');
          renderAdminStaffList();
        });

        div.querySelector('[data-act="del"]').addEventListener('click', () => {
          if (!confirm('削除しますか？')) return;
          master.staff = master.staff.filter((x) => x.id !== s.id);
          saveMaster(master);
          toast('削除しました');
          renderAdminStaffList();
        });

        wrap.appendChild(div);
      });
  }

  function renderAdminLocations() {
    const wrap = $('#adminLocations');
    if (!wrap) return;
    wrap.innerHTML = '';

    const items = (master.locations || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ja'));
    if (items.length === 0) {
      const d = document.createElement('div');
      d.className = 'small';
      d.textContent = '場所が未登録です。';
      wrap.appendChild(d);
      return;
    }

    items.forEach((loc) => {
      const div = document.createElement('div');
      div.className = 'admin-item';
      div.innerHTML = `
        <div><strong>${escapeHtml(loc.name || '')}</strong> <span class="small">(${escapeHtml(loc.id || '')})</span></div>
        <div class="small">QR文字列: ${escapeHtml(loc.qr || '')}</div>
        <div class="form-grid">
          <input data-k="name" value="${escapeHtml(loc.name || '')}" placeholder="場所名" />
          <input data-k="qr" value="${escapeHtml(loc.qr || '')}" placeholder="LOC-XXX" />
          <button class="btn btn-secondary" data-act="save">保存</button>
          <button class="btn btn-secondary" data-act="del">削除</button>
        </div>
      `;

      div.querySelector('[data-act="save"]').addEventListener('click', () => {
        const name = div.querySelector('input[data-k="name"]').value.trim();
        const qr = div.querySelector('input[data-k="qr"]').value.trim();
        if (!name) return toast('場所名を入力してください');
        if (!qr) return toast('QR文字列を入力してください');
        loc.name = name;
        loc.qr = qr;
        saveMaster(master);
        toast('保存しました');
        renderAdminLocations();
      });

      div.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (!confirm('削除しますか？')) return;
        master.locations = (master.locations || []).filter((x) => x.id !== loc.id);
        saveMaster(master);
        toast('削除しました');
        renderAdminLocations();
      });

      wrap.appendChild(div);
    });
  }

  function renderAdminSituations() {
    const wrap = $('#adminSituations');
    wrap.innerHTML = '';

    master.situations.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'admin-item';

      const includeE = (s.includeEmergency || []).join(', ');
      const includeO = (s.includeObserve || []).join(', ');

      div.innerHTML = `
        <div><strong>${escapeHtml(s.label)}</strong> <span class="small">(${escapeHtml(s.id)})</span></div>
        <div class="small">推奨: ${escapeHtml(s.defaultAction === 'emergency' ? '緊急' : '様子見')}</div>

        <div class="form-grid">
          <select data-k="defaultAction">
            <option value="emergency">緊急</option>
            <option value="observe">様子見</option>
          </select>
          <label class="field" style="grid-column: span 2;">
            <span>部位選択を使う</span>
            <select data-k="requiresBody">
              <option value="false">いいえ</option>
              <option value="true">はい</option>
            </select>
          </label>
        </div>

        <div class="form-col">
          <label class="field">
            <span>緊急：含める部署（safetyHQ,rescueTeam,ambulanceCenter をカンマ区切り）</span>
            <input data-k="includeEmergency" value="${escapeHtml(includeE)}" />
          </label>
          <label class="field">
            <span>様子見：含める部署（同上）</span>
            <input data-k="includeObserve" value="${escapeHtml(includeO)}" />
          </label>

          <label class="field">
            <span>表示文（緊急）</span>
            <textarea data-k="recommendTextEmergency">${escapeHtml(s.recommendTextEmergency || '')}</textarea>
          </label>
          <label class="field">
            <span>表示文（様子見）</span>
            <textarea data-k="recommendTextObserve">${escapeHtml(s.recommendTextObserve || '')}</textarea>
          </label>

          <label class="field">
            <span>件名テンプレ（例: [命をツナゲル] {company} {person} - ...）</span>
            <input data-k="subjectTpl" value="${escapeHtml(s.subjectTpl || '')}" />
          </label>

          <label class="field">
            <span>本文テンプレ（緊急）</span>
            <textarea data-k="bodyTplEmergency">${escapeHtml(s.bodyTplEmergency || '')}</textarea>
          </label>

          <label class="field">
            <span>本文テンプレ（様子見）</span>
            <textarea data-k="bodyTplObserve">${escapeHtml(s.bodyTplObserve || '')}</textarea>
          </label>

          <button class="btn btn-primary" data-act="save">保存</button>
        </div>
      `;

      div.querySelector('select[data-k="defaultAction"]').value = s.defaultAction;
      div.querySelector('select[data-k="requiresBody"]').value = String(!!s.requiresBody);

      div.querySelector('[data-act="save"]').addEventListener('click', () => {
        s.defaultAction = div.querySelector('select[data-k="defaultAction"]').value;
        s.requiresBody = div.querySelector('select[data-k="requiresBody"]').value === 'true';

        s.includeEmergency = normalizeEmails(div.querySelector('input[data-k="includeEmergency"]').value).map((x) => x);
        // normalizeEmails splits by comma; here we want raw tokens, so do manual:
        s.includeEmergency = String(div.querySelector('input[data-k="includeEmergency"]').value)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);

        s.includeObserve = String(div.querySelector('input[data-k="includeObserve"]').value)
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);

        s.recommendTextEmergency = div.querySelector('textarea[data-k="recommendTextEmergency"]').value.trim();
        s.recommendTextObserve = div.querySelector('textarea[data-k="recommendTextObserve"]').value.trim();
        s.subjectTpl = div.querySelector('input[data-k="subjectTpl"]').value.trim();
        s.bodyTplEmergency = div.querySelector('textarea[data-k="bodyTplEmergency"]').value.replace(/\r\n/g, '\n');
        s.bodyTplObserve = div.querySelector('textarea[data-k="bodyTplObserve"]').value.replace(/\r\n/g, '\n');

        saveMaster(master);
        toast('保存しました');
      });

      wrap.appendChild(div);
    });
  }

  /** =========================
   *  Wire events
   *  ========================= */
  function wireGlobalEvents() {
    const back = $('#btnBack');
    if (back) back.addEventListener('click', () => nav.back());
    const restart = $('#btnRestartGlobal');
    if (restart) restart.addEventListener('click', () => nav.restartAll());

    // オーバーレイの右上×ボタンで閉じる
    const overlayCloseBtn = document.getElementById('overlay-close');
    if (overlayCloseBtn) {
      overlayCloseBtn.addEventListener('click', () => {
        try {
          closeOverlay();
        } catch (e) {
          console.error(e);
        }
      });
    }

    const startEm = $('#btnStartEmergency');
    if (startEm)
      startEm.addEventListener('click', (ev) => {
        // 通常のウィザードは使用せず、ワンページ入力画面を表示する
        ev.preventDefault();
        // 全てのビューを非表示にし、新しい画面をアクティブにする
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        const one = document.getElementById('view-onepage');
        if (one) one.classList.add('active');
        // 更新したビューをナビゲーションスタックに設定し、ヘッダーを更新する
        nav.stack = ['view-onepage'];
        nav.show('view-onepage', { push: false });
        // 常にページの最上部にスクロール
        try {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } catch {
          window.scrollTo(0, 0);
        }
        // 初期化
        if (typeof initOnePage === 'function') initOnePage();
      });

    // Goods search button on home page
    const goodsBtn = $('#btnGoodsSearch');
    if (goodsBtn)
      goodsBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        nav.show('view-goods');
      });

    // Goods page item buttons
    const goodsAed = $('#btnGoodsAED');
    if (goodsAed)
      goodsAed.addEventListener('click', () => {
        // Navigate to AED map without leaving a return callback; after closing,
        // return to goods page.
        showAedMap(() => {
          nav.show('view-goods', { push: false });
        });
      });
    const goodsSt = $('#btnGoodsStretcher');
    if (goodsSt)
      goodsSt.addEventListener('click', () => {
        // Navigate to stretcher map. After closing, return to goods view.
        showStretcherMap(() => {
          nav.show('view-goods', { push: false });
        });
      });
    const goodsOs1 = $('#btnGoodsOS1');
    if (goodsOs1)
      goodsOs1.addEventListener('click', () => {
        // Navigate to OS1 map. After closing, return to goods view.
        showOs1Map(() => {
          nav.show('view-goods', { push: false });
        });
      });

    // Event listeners for AED map interactions
    // Close button on AED map view
    const aedBack = $('#btnAedBack');
    if (aedBack)
      aedBack.addEventListener('click', () => {
        // Reset map state for next time
        const ov = document.getElementById('aed-overview');
        const detail = document.getElementById('aed-detail');
        if (ov) ov.classList.remove('hidden');
        if (detail) detail.classList.add('hidden');
        // Invoke callback if present; otherwise go back
        const cb = aedCloseCallback;
        aedCloseCallback = null;
        if (typeof cb === 'function') {
          cb();
        } else {
          nav.back();
        }
      });
    // Clickable areas on AED overview
    const aedAreas = $$('.aed-area');
    if (aedAreas && aedAreas.length) {
      aedAreas.forEach((areaBtn) => {
        areaBtn.addEventListener('click', () => {
          const area = areaBtn.getAttribute('data-area');
          const detailImg = document.getElementById('aedDetailImg');
          if (detailImg) {
            if (area === '1') detailImg.src = 'map_aed_area1.png';
            else if (area === '2') detailImg.src = 'map_aed_area2.png';
            else detailImg.src = 'map_aed_area3.png';
          }
          // Show detail and hide overview
          const ov = document.getElementById('aed-overview');
          const detail = document.getElementById('aed-detail');
          if (ov) ov.classList.add('hidden');
          if (detail) detail.classList.remove('hidden');
        });
      });
    }

    // Event listeners for stretcher map interactions
    const stretcherBack = $('#btnStretcherBack');
    if (stretcherBack)
      stretcherBack.addEventListener('click', () => {
        // Reset stretcher map state for next time
        const ovSt = document.getElementById('stretcher-overview');
        const detailSt = document.getElementById('stretcher-detail');
        if (ovSt) ovSt.classList.remove('hidden');
        if (detailSt) detailSt.classList.add('hidden');
        // Invoke callback if present; otherwise go back
        const cbSt = stretcherCloseCallback;
        stretcherCloseCallback = null;
        if (typeof cbSt === 'function') {
          cbSt();
        } else {
          nav.back();
        }
      });
    // Clickable areas on stretcher overview
    const stretcherAreas = $$('.stretcher-area');
    if (stretcherAreas && stretcherAreas.length) {
      stretcherAreas.forEach((areaBtn) => {
        areaBtn.addEventListener('click', () => {
          const area = areaBtn.getAttribute('data-area');
          const detailImg = document.getElementById('stretcherDetailImg');
          if (detailImg) {
            if (area === '1') detailImg.src = 'map_tanka_area1.png';
            else if (area === '2') detailImg.src = 'map_tanka_area2.png';
            else detailImg.src = 'map_tanka_area3.png';
          }
          // Show detail and hide overview
          const ovSt2 = document.getElementById('stretcher-overview');
          const detailSt2 = document.getElementById('stretcher-detail');
          if (ovSt2) ovSt2.classList.add('hidden');
          if (detailSt2) detailSt2.classList.remove('hidden');
        });
      });
    }

    // Event listeners for OS1 map interactions
    const os1Back = document.getElementById('btnOs1Back');
    if (os1Back)
      os1Back.addEventListener('click', () => {
        // Reset OS1 map state for next time
        const ovOs1 = document.getElementById('os1-overview');
        const detailOs1 = document.getElementById('os1-detail');
        if (ovOs1) ovOs1.classList.remove('hidden');
        if (detailOs1) detailOs1.classList.add('hidden');
        // Invoke callback if present; otherwise go back
        const cbOs1 = os1CloseCallback;
        os1CloseCallback = null;
        if (typeof cbOs1 === 'function') {
          cbOs1();
        } else {
          nav.back();
        }
      });
    // Clickable areas on OS1 overview
    const os1Areas = $$('.os1-area');
    if (os1Areas && os1Areas.length) {
      os1Areas.forEach((areaBtn) => {
        areaBtn.addEventListener('click', () => {
          const area = areaBtn.getAttribute('data-area');
          const detailImg = document.getElementById('os1DetailImg');
          if (detailImg) {
            if (area === '1') detailImg.src = 'map_os1_area1.png';
            else if (area === '2') detailImg.src = 'map_os1_area2.png';
            else detailImg.src = 'map_os1_area3.png';
          }
          // Show detail and hide overview
          const ovOs1 = document.getElementById('os1-overview');
          const detailOs1 = document.getElementById('os1-detail');
          if (ovOs1) ovOs1.classList.add('hidden');
          if (detailOs1) detailOs1.classList.remove('hidden');
        });
      });
    }

    $('#btnBodyNext').addEventListener('click', () => {
      if (!state.bodyPartId) return;

      // If company/person are already chosen, proceed to the final screen
      if (state.companyId && state.personId) {
        if (state.mode === 'emergency') {
          showEmergencyCallView();
        } else {
          buildResultPreview();
          nav.show('view-result');
        }
        return;
      }

      // Otherwise continue the normal flow (body -> affiliation)
      renderCompanyList();
      nav.show('view-company');
    });

    $('#btnActionEmergency').addEventListener('click', () => {
      state.action = 'emergency';
      buildResultPreview();
    });
    $('#btnActionObserve').addEventListener('click', () => {
      state.action = 'observe';
      buildResultPreview();
    });

    $('#btnOpenMail').addEventListener('click', () => openMail());
    $('#btnOpenMailEmergency')?.addEventListener('click', () => openMail());
    $('#btnCopyMail').addEventListener('click', () => copyPreview());

    // Admin entry
    $('#btnAdmin').addEventListener('click', async () => {
      await admin.initGate();
      $('#adminPanel').classList.add('hidden');
      $('#adminGate').classList.remove('hidden');
      admin.authed = false;
      nav.show('view-admin');
    });

    // Admin gate
    $('#btnAdminSetPass').addEventListener('click', () => admin.setPass());
    $('#btnAdminLogin').addEventListener('click', () => admin.login());
    $('#btnAdminChangePass').addEventListener('click', () => admin.changePass());

    // Admin tabs
    $$('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        $$('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        const key = t.getAttribute('data-tab');

        $$('.admin-tab').forEach((p) => p.classList.remove('active'));
        const panel = document.querySelector(`[data-tab-panel="${key}"]`);
        if (panel) panel.classList.add('active');
      });
    });

    // Admin: add company
    $('#btnAddCompany').addEventListener('click', () => {
      const name = $('#newCompanyName').value.trim();
      const emails = normalizeEmails($('#newCompanyEmails').value);
      if (!name) return toast('会社名を入力してください');

      const id = name === '自社' ? 'own' : uuid().slice(0, 8);
      master.companies.push({ id, name, emails });
      saveMaster(master);

      $('#newCompanyName').value = '';
      $('#newCompanyEmails').value = '';
      toast('追加しました');
      renderCompanyList();
      renderAdminAll();
    });

    // Admin: save global contacts
    $('#btnSaveGlobalContacts').addEventListener('click', () => {
      master.globalContacts.safetyHQ = $('#gcSafetyHQ').value.trim();
      master.globalContacts.rescueTeam = $('#gcRescueTeam').value.trim();
      master.globalContacts.ambulanceCenter = $('#gcAmbulance').value.trim();

      master.sendScope = {
        safetyHQ: $('#scopeSafetyHQ').checked,
        rescueTeam: $('#scopeRescueTeam').checked,
        ambulanceCenter: $('#scopeAmbulance').checked,
        companyEmails: $('#scopeCompanyEmails').checked,
      };
      saveMaster(master);
      toast('保存しました');
    });

    // Admin: staff list filter
    $('#btnStaffFilter').addEventListener('click', () => renderAdminStaffList());

    // Admin: add staff
    $('#btnAddStaff').addEventListener('click', () => {
      const companyId = $('#newStaffCompany').value;
      const name = $('#newStaffName').value.trim();
      const kana = $('#newStaffKana').value.trim();
      const qr = ($('#newStaffQr')?.value || '').trim();
      if (!companyId) return toast('会社を選択してください');
      if (!name) return toast('氏名を入力してください');
      if (!kana) return toast('よみ（かな）を入力してください');

      master.staff.push({ id: uuid(), companyId, name, kana, qr });
      saveMaster(master);

      $('#newStaffName').value = '';
      $('#newStaffKana').value = '';
      if ($('#newStaffQr')) $('#newStaffQr').value = '';
      toast('追加しました');
      renderAdminStaffList();
    });

    // Admin: add location
    $('#btnAddLoc')?.addEventListener('click', () => {
      const name = ($('#newLocName')?.value || '').trim();
      const qr = ($('#newLocQr')?.value || '').trim();
      if (!name) return toast('場所名を入力してください');
      if (!qr) return toast('場所QR（文字列）を入力してください');

      if (!Array.isArray(master.locations)) master.locations = [];
      master.locations.push({ id: uuid(), name, qr });
      saveMaster(master);

      $('#newLocName').value = '';
      $('#newLocQr').value = '';
      toast('追加しました');
      renderAdminLocations();
    });

    // Admin: Export JSON
    $('#btnExportJson').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(master, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'inochi_master.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('JSONを書き出しました');
    });

    /** ===== Guided emergency flow events ===== */
    // Stepper navigation
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.step-btn');
      if (!btn) return;
      const step = btn.dataset.step;
      if (!step) return;
      goWizardStep(step);
      saveSession({ ...state, nav: nav.stack });
    });

    // Segmented selections (triage)
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      let field = btn.dataset.field;
      const val = btn.dataset.val;
      if (!field) {
        const seg = btn.closest('.seg');
        const sid = seg?.id || '';
        if (sid === 'segConscious') field = 'conscious';
        else if (sid === 'segBreathing') field = 'breathing';
      }
      if (!field || !val) return;
      if (!state.wiz?.triage) state.wiz = defaultWizardState();
      state.wiz.triage[field] = val;
      renderWizardTriage();
      saveSession({ ...state, nav: nav.stack });
    });

    // Triage actions
    $('#btnTriageNext')?.addEventListener('click', () => goWizardStep('location'));
    $('#btnQuickToReview1')?.addEventListener('click', () => goWizardStep('review'));
    $('#btnTriageQuickShare')?.addEventListener('click', () => goWizardStep('review'));
    // Location actions
    $('#btnScanLocation')?.addEventListener('click', () => openQrModal('location'));
    $('#btnMapSelect')?.addEventListener('click', () => openMapModal());
    $('#btnLocationNext')?.addEventListener('click', () => goWizardStep('accident'));
    $('#btnQuickToReview2')?.addEventListener('click', () => goWizardStep('review'));

    // Map modal events
    $('#btnMapClose')?.addEventListener('click', () => closeMapModal());
    $('#btnMapCancel')?.addEventListener('click', () => closeMapModal());
    $('#btnMapUse')?.addEventListener('click', () => applyMapSelectionToLocation());

    // Map view tabs
    $('#btnMapViewAll')?.addEventListener('click', () => setMapView('all'));
    $('#btnMapViewA1')?.addEventListener('click', () => setMapView('a1'));
    $('#btnMapViewA2')?.addEventListener('click', () => setMapView('a2'));
    $('#btnMapViewA3')?.addEventListener('click', () => setMapView('a3'));
    $('#btnMapResetZoom')?.addEventListener('click', () => setMapView('all'));

    $('#mapSearch')?.addEventListener('input', (e) => renderMapList(e.target.value || ''));
    $('#btnMapClear')?.addEventListener('click', () => {
      const q = $('#mapSearch');
      if (q) q.value = '';
      resetMapSelection({ keepView: true });
      renderMapList('');
    });

    // Candidates (tap -> auto-select nearest 1, but can change here)
    $('#mapCandidates')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.map-cand');
      if (!btn) return;
      const p = findPlaceByName(btn.dataset.name);
      if (!p) return;
      setMapSelected(p);
    });

    // List selection (search result)
    $('#mapList')?.addEventListener('click', (e) => {
      const row = e.target.closest('.map-row');
      if (!row) return;
      const p = findPlaceByName(row.dataset.name);
      if (!p) return;
      if (mapView === 'all') {
        setMapView(p.areaKey);
      }
      setMapSelected(p);
    });

    // Tap/click can be on SVG overlay or the image itself
    $('#yardSvg')?.addEventListener('click', (e) => handleMapTap(e));
    $('#yardSvg')?.addEventListener('touchstart', (e) => handleMapTap(e), { passive: true });
    $('#mapModal')?.addEventListener('click', (e) => {
      if (e.target === $('#mapModal')) closeMapModal();
    });

    $('#btnLocationUnknown')?.addEventListener('click', () => {
      state.wiz.location = { qr: '', name: '不明', unknown: true };
      if ($('#locationManual')) $('#locationManual').value = '';
      renderWizardLocation();
      saveSession({ ...state, nav: nav.stack });
    });

    $('#btnLocationSetManual')?.addEventListener('click', () => {
      const v = ($('#locationManual')?.value || '').trim();
      if (!v) return toast('場所名を入力してください');
      state.wiz.location = { qr: state.wiz.location.qr || '', name: v, unknown: false };
      renderWizardLocation();
      saveSession({ ...state, nav: nav.stack });
    });

    $('#locationManual')?.addEventListener('input', (e) => {
      const v = (e.target.value || '').trim();
      if (!state.wiz.location) state.wiz.location = { qr: '', name: '', unknown: true };
      if (v) {
        state.wiz.location.name = v;
        state.wiz.location.unknown = false;
      }
      renderWizardLocation();
      saveSession({ ...state, nav: nav.stack });
    });

    $('#locationList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.list-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!id) return;
      const loc = (master.locations || []).find((x) => x.id === id);
      if (!loc) return;
      state.wiz.location = { qr: loc.qr || '', name: loc.name || '', unknown: false };
      if ($('#locationManual')) $('#locationManual').value = state.wiz.location.name || '';
      renderWizardLocation();
      saveSession({ ...state, nav: nav.stack });
    });

    // Accident actions
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (!document.getElementById(WIZ.accident)?.classList.contains('active')) return;
      const t = chip.dataset.acc;
      if (!t) return;
      const arr = state.wiz.accident.types;
      const idx = arr.indexOf(t);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(t);
      renderWizardAccident();
      saveSession({ ...state, nav: nav.stack });
    });
    $('#btnAccidentNone')?.addEventListener('click', () => {
      state.wiz.accident.types = [];
      renderWizardAccident();
      saveSession({ ...state, nav: nav.stack });
    });
    $('#accidentNote')?.addEventListener('input', (e) => {
      state.wiz.accident.note = e.target.value || '';
      saveSession({ ...state, nav: nav.stack });
    });
    $('#btnAccidentNext')?.addEventListener('click', () => goWizardStep('victim'));
    $('#btnQuickToReview3')?.addEventListener('click', () => goWizardStep('review'));

    // Victim actions
    $('#btnScanVictim')?.addEventListener('click', () => openQrModal('victim'));
    $('#btnVictimNext')?.addEventListener('click', () => goWizardStep('review'));
    $('#btnQuickToReview4')?.addEventListener('click', () => goWizardStep('review'));
    $('#btnVictimUnknown')?.addEventListener('click', () => {
      state.wiz.victim = { staffId: null, name: '', unknown: true, qr: '' };
      $('#victimSearch').value = '';
      renderWizardVictim();
      saveSession({ ...state, nav: nav.stack });
    });
    $('#victimSearch')?.addEventListener('input', (e) => {
      const q = (e.target.value || '').trim();
      renderVictimSearchList(q);
    });
    $('#victimList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.list-btn');
      if (!btn) return;
      const staffId = btn.dataset.staff;
      if (!staffId) return;
      const p = getPerson(staffId);
      if (!p) return;
      state.wiz.victim = { staffId: p.id, name: p.name, unknown: false, qr: p.qr || '' };
      $('#victimSelected').textContent = p.name;
      $('#victimSearch').value = '';
      renderWizardVictim();
      saveSession({ ...state, nav: nav.stack });
    });

    // Review actions
    $('#btnWizardCopy')?.addEventListener('click', () => {
      state.preview = buildWizardPreview();
      copyPreview();
      saveSession({ ...state, nav: nav.stack });
    });
    $('#btnWizardOpenMail')?.addEventListener('click', () => {
      state.preview = buildWizardPreview();
      openMail();
      saveSession({ ...state, nav: nav.stack });
    });

    // QR modal controls
    $('#btnQrClose')?.addEventListener('click', closeQrModal);
    $('#btnQrCancel')?.addEventListener('click', closeQrModal);
    $('#qrModal')?.addEventListener('click', (e) => {
      if (e.target?.id === 'qrModal') closeQrModal();
    });

    // Esc キーでも閉じられるように（PC/キーボード利用時）
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = $('#qrModal');
      if (m && !m.classList.contains('hidden')) closeQrModal();
    });
    $('#btnQrUseManual')?.addEventListener('click', () => {
      const v = ($('#qrManual')?.value || '').trim();
      if (!v) return toast('QR文字列を入力してください');
      handleQrValue(v);
    });

    // QR modal: photo fallback
    $('#btnQrPhoto')?.addEventListener('click', () => {
      const f = $('#qrFile');
      if (f) f.click();
    });
    $('#qrFile')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setQrStatus('画像を解析中…');
      const raw = await decodeQrFromFile(file);
      if (raw) {
        handleQrValue(raw);
      } else {
        setQrStatus('画像からQRを読み取れませんでした。別の角度で撮影するか、貼り付けをご利用ください。');
      }
      e.target.value = '';
    });

    // Admin: Import JSON
    $('#importJson').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!imported || typeof imported !== 'object') throw new Error('invalid');
        // Keep backward/forward compatibility by loading through merger
        localStorage.setItem(MASTER_KEY, JSON.stringify(imported));
        master = loadMaster();
        toast('読み込みました');
        $('#adminIoMsg').textContent = '読み込みました。画面を更新しました。';
        renderAdminAll();
        renderStatusGrid();
        renderCompanyList();
      } catch (err) {
        console.error(err);
        $('#adminIoMsg').textContent = '読み込みに失敗しました。JSON形式を確認してください。';
        toast('読み込み失敗');
      } finally {
        e.target.value = '';
      }
    });
  }

  /** =========================
   *  Boot
   *  ========================= */
  function restoreIfPossible() {
    const ses = loadSession();
    if (!ses) return;

    // Restore selection state only (do not auto-open deep screens)
    state.mode = 'emergency';
    state.situationId = ses.situationId || null;
    state.companyId = ses.companyId || null;
    state.personId = ses.personId || null;
    state.bodyPartId = ses.bodyPartId || null;
    state.action = ses.action || null;
    state.detailNote = ses.detailNote || '';
    state.preview = ses.preview || state.preview;
    state.wiz = ses.wiz ? { ...defaultWizardState(), ...ses.wiz } : state.wiz;

    // Restore nav stack if valid
    if (Array.isArray(ses.nav) && ses.nav.length) {
      nav.stack = ses.nav.filter((id) => typeof id === 'string' && document.getElementById(id));
      if (!nav.stack.length) nav.stack = ['view-home'];
    }

    // If in body view, restore selection highlight
    if (state.bodyPartId) {
      const el = document.querySelector(`#bodySvg .body-part[data-part="${state.bodyPartId}"]`);
      if (el) {
        el.classList.add('selected');
        const bp = getBodyPart(state.bodyPartId);
        $('#bodySelectedLabel').textContent = bp ? bp.label : '選択中';
        $('#btnBodyNext').disabled = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // QR scanning overrides using the QrScanner library
  // ---------------------------------------------------------------------------
  // Replace the existing implementations of startQrCamera, stopQrCamera, and decodeQrFromFile.
  startQrCamera = async function(opts = {}) {
    const autoFallback = !!opts.autoFallback;
    const wrap = $('#qrCameraWrap');
    if (wrap) wrap.classList.remove('hidden');
    const video = $('#qrVideo');
    if (!video) {
      return;
    }
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    try {
      if (qrScanner) {
        await qrScanner.stop();
        const prevStream = qrScanner.$video && qrScanner.$video.srcObject;
        if (prevStream) {
          try {
            prevStream.getTracks().forEach((t) => t.stop());
          } catch {}
          qrScanner.$video.srcObject = null;
        }
        qrScanner.destroy();
        qrScanner = null;
      }
      if (typeof QrScanner === 'undefined') {
        throw new Error('QrScanner is not available');
      }
      qrScanner = new QrScanner(
        video,
        (result) => {
          try {
            let raw;
            if (typeof result === 'string') {
              raw = result;
            } else if (result && typeof result.data === 'string') {
              raw = result.data;
            }
            raw = (raw || '').trim();
            if (raw) {
              handleQrValue(raw);
            }
          } catch (err) {
            console.warn('QR callback error', err);
          }
        },
        {
          returnDetailedScanResult: true,
          onDecodeError: () => {},
        }
      );
      await qrScanner.start();
      qrStream = qrScanner.$video && qrScanner.$video.srcObject;
      setQrStatus('カメラ起動中… QRを枠内に合わせてください。');
    } catch (e) {
      console.warn('Failed to start live QR scanner', e);
      if (wrap) wrap.classList.add('hidden');
      setQrStatus('カメラの起動に失敗しました。権限設定を確認するか、"写真で読み取る"（撮影）をご利用ください。');
      if (autoFallback) openQrPhotoCapture();
    }
  };

  stopQrCamera = function() {
    try {
      if (qrScanner) {
        qrScanner.stop();
        const stream = qrScanner.$video && qrScanner.$video.srcObject;
        if (stream) {
          try {
            stream.getTracks().forEach((t) => t.stop());
          } catch {}
          qrScanner.$video.srcObject = null;
        }
        qrScanner.destroy();
      }
    } catch {}
    qrScanner = null;
    qrStream = null;
    qrRunning = false;
    qrDetector = null;
    qrCanvas = null;
    qrCtx = null;
  };

  decodeQrFromFile = async function(file) {
    if (!file) return null;
    if (typeof QrScanner === 'undefined' || typeof QrScanner.scanImage !== 'function') {
      console.warn('QrScanner.scanImage is unavailable');
      return null;
    }
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      let raw;
      if (typeof result === 'string') {
        raw = result;
      } else if (result && typeof result.data === 'string') {
        raw = result.data;
      }
      raw = (raw || '').trim();
      return raw || null;
    } catch (err) {
      console.warn('QR decode failed', err);
      return null;
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    try {
      // init
    renderStatusGrid();
    renderCompanyList();
    renderBodyPartsHandlers();
    wireGlobalEvents();
    restoreIfPossible();

    // Start on home always (safer), but keep session state
    nav.show('view-home', { push: false });
    nav.stack = ['view-home'];
    saveSession({ ...state, nav: nav.stack });

    // If first time, show admin set screen on admin view when opened
    admin.initGate();
    } catch (e) {
      console.error(e);
      const t = document.getElementById('toast');
      if (t) {
        t.textContent = 'エラーが発生しました。管理→設定の見直し、またはファイルの再配布をご確認ください。';
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 4000);
      }
    }
  });
})();
