const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const bubbleButtons = document.getElementById('bubble-buttons');
const btnAllow = document.getElementById('btn-allow');
const btnDeny = document.getElementById('btn-deny');
const btnAlwaysAllow = document.getElementById('btn-always-allow');
const character = document.getElementById('character');
const statusText = document.getElementById('status-text');
const appEl = document.getElementById('app');

// 足元ステータステキスト更新
const statusLabel = document.getElementById('status-label');
const statusSpinner = statusText.querySelector('.status-spinner');

function updateStatusText(text) {
  statusLabel.textContent = text;
  statusText.classList.remove('hidden');
  statusSpinner.classList.remove('hidden');
}

function pauseStatusSpinner() {
  statusSpinner.classList.add('hidden');
}

function hideStatusText() {
  statusText.classList.add('hidden');
  statusLabel.textContent = '';
}

// HTMLエスケープ
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Permission リクエストのキュー（複数同時対応）
let permissionQueue = [];
let bubbleVisible = false;
let isAutoApproveBubble = false; // ✅自動許可の吹き出しはdismissで消さない

// マウスがUI要素に乗ったらクリックスルーを解除、離れたら復活
function setupMouseForwarding() {
  document.addEventListener('mouseleave', () => {
    window.electronAPI.setIgnoreMouse(true);
  });

  // mousemoveでチェック（forward: trueでmousemoveが来る）
  document.addEventListener('mousemove', (e) => {
    // ドラッグ中はマウスイベントを常に受け取る（ウィンドウ移動の非同期ズレで途切れるのを防止）
    if (isDragging) {
      window.electronAPI.setIgnoreMouse(false);
      return;
    }
    const isOverCharacter = isPointInElement(e, character);
    const isOverBubble = bubbleVisible && isPointInElement(e, bubble);
    if (isOverCharacter || isOverBubble) {
      window.electronAPI.setIgnoreMouse(false);
    } else {
      window.electronAPI.setIgnoreMouse(true);
    }
  });
}

function isPointInElement(e, el) {
  const rect = el.getBoundingClientRect();
  return (
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom
  );
}

function showBubble(text, showButtons = false, { html = false } = {}) {
  if (html) {
    bubbleText.innerHTML = text;
  } else {
    bubbleText.textContent = text;
  }
  bubbleVisible = true;

  if (showButtons) {
    bubbleButtons.classList.remove('hidden');
  } else {
    bubbleButtons.classList.add('hidden');
  }

  bubble.classList.remove('hidden');

  // DOM描画後に吹き出しの実際の高さを測ってウィンドウを拡張
  requestAnimationFrame(() => {
    const bubbleHeight = bubble.offsetHeight;
    // 吹き出しはbottom:310pxに配置。必要なウィンドウ高さ = 310 + 吹き出し高さ + マージン
    const neededHeight = 310 + bubbleHeight + 20;
    window.electronAPI.expandWindow(neededHeight);
  });

  // 吹き出し表示中は作業中スピナーを止める
  pauseStatusSpinner();
}

function hideBubble() {
  bubble.classList.add('hidden');
  bubbleVisible = false;
  window.electronAPI.compactWindow();
  btnAlwaysAllow.classList.add('hidden');

  // クリックスルーを復活
  window.electronAPI.setIgnoreMouse(true);
}

/**
 * キュー先頭のPermissionを表示する
 * キューが空ならhideBubble
 */
function displayCurrentPermission() {
  if (permissionQueue.length === 0) {
    hideBubble();
    return;
  }

  const data = permissionQueue[0];
  const toolName = data.tool_name || 'Unknown';

  // AskUserQuestion の場合は専用表示
  if (toolName === 'AskUserQuestion' && data.tool_input && data.tool_input.questions && data.tool_input.questions.length > 0) {
    const q = data.tool_input.questions[0];
    const questionText = escapeHtml(q.question || '');
    let optionsHtml = '';
    if (q.options && q.options.length > 0) {
      const items = q.options.map((opt, i) => {
        const label = escapeHtml(opt.label || '');
        const desc = opt.description ? escapeHtml(opt.description) : '';
        return `<li><span class="ask-option-number">${i + 1}.</span> <span class="ask-option-label">${label}</span>${desc ? `<span class="ask-option-desc"> - ${desc}</span>` : ''}</li>`;
      }).join('');
      optionsHtml = `<ul class="ask-options-list">${items}</ul>`;
    }
    btnAlwaysAllow.classList.add('hidden');
    showBubble(`<div class="ask-question">❓ ${questionText}</div>${optionsHtml}`, false, { html: true });
    return;
  }

  let description = data.description || '';

  if (data.tool_input && data.tool_input.command) {
    // descriptionに⚠️リスク理由が含まれる場合はそれを保持
    const riskPrefix = description.startsWith('⚠️') ? description.split('\n')[0] + '\n' : '';
    description = riskPrefix + data.tool_input.command;
  }

  // 長すぎる場合は切り詰め（⚠️行は保持）
  if (description.length > 150) {
    const lines = description.split('\n');
    if (lines.length > 1 && lines[0].startsWith('⚠️')) {
      // ⚠️行 + コマンド切り詰め
      description = lines[0] + '\n' + lines.slice(1).join('\n').substring(0, 100) + '...';
    } else {
      description = description.substring(0, 120) + '...';
    }
  }

  // 待ち件数の表示
  const waitCount = permissionQueue.length - 1;
  const waitText = waitCount > 0 ? `\n(${waitCount}件待ち)` : '';

  // permission_suggestionsがあれば「次回から聞かない」ボタンを表示
  const suggestions = data.permission_suggestions || null;
  if (suggestions && suggestions.length > 0) {
    btnAlwaysAllow.classList.remove('hidden');
  } else {
    btnAlwaysAllow.classList.add('hidden');
  }

  showBubble(`🔧 ${toolName}\n${description}${waitText}`, true);
}

/**
 * キュー先頭のリクエスト情報を取得する
 */
function getCurrentRequest() {
  return permissionQueue.length > 0 ? permissionQueue[0] : null;
}

// セッション情報の受信
window.electronAPI.onSessionInfo((info) => {
  console.log('Session info received:', info);

  // モニター用ずんだもん: プルプル震えアニメーション
  if (info.sessionId === 'zundamon-monitor') {
    character.classList.add('monitor-shake');
  }

  // 色テーマ適用
  if (info.colorTheme) {
    const theme = info.colorTheme;
    appEl.style.setProperty('--theme-primary', theme.primary);
    appEl.style.setProperty('--theme-hover-bg', theme.hoverBg);
    appEl.style.setProperty('--theme-shadow', theme.shadow.replace('@@', '0.4'));
    appEl.style.setProperty('--theme-shadow-light', theme.shadow.replace('@@', '0.2'));

    // ずんだもんの色違い画像を適用
    if (theme.image) {
      const img = character.querySelector('img');
      if (img) {
        img.src = `../assets/${theme.image}`;
      }
    }
  }
});

// Permission Request
window.electronAPI.onPermissionRequest((data) => {
  console.log('[DEBUG] onPermissionRequest:', JSON.stringify({ id: data.id, tool_name: data.tool_name, queueBefore: permissionQueue.length }));
  isAutoApproveBubble = false;
  permissionQueue.push(data);
  displayCurrentPermission();
});

// Notification
window.electronAPI.onNotification((data) => {
  console.log('[DEBUG] onNotification:', JSON.stringify({ message: data.message, queueLength: permissionQueue.length, bubbleVisible }));
  // Permissionキューがある場合はNotificationを表示しない（キューを維持）
  if (permissionQueue.length > 0) return;
  const message = data.message || '通知なのだ！';
  // ✅自動許可の通知はdismissで消さないフラグを立てる
  isAutoApproveBubble = message.startsWith('✅');
  showBubble(message);
});

// Status Update (足元テキスト: PreToolUseから送信)
window.electronAPI.onStatusUpdate((data) => {
  console.log('[DEBUG] onStatusUpdate:', JSON.stringify({ message: data.message }));
  updateStatusText(data.message || '');
});

// Stop (入力待ち)
window.electronAPI.onStop((data) => {
  console.log('[DEBUG] onStop:', JSON.stringify({ message: data.message, queueLength: permissionQueue.length, bubbleVisible }));
  // Permissionキューがある場合はStopを表示しない（キューを維持）
  if (permissionQueue.length > 0) return;
  isAutoApproveBubble = false;
  showBubble(data.message || '入力を待っているのだ！');
});

// ボタンクリック
btnAllow.addEventListener('click', () => {
  const current = getCurrentRequest();
  if (current) {
    window.electronAPI.sendPermissionResponse({
      id: current.id,
      decision: 'allow',
    });
    permissionQueue.shift();
    displayCurrentPermission();
  }
});

// 「次回から聞かない」ボタン（許可 + updatedPermissions）
btnAlwaysAllow.addEventListener('click', () => {
  const current = getCurrentRequest();
  if (current) {
    const response = {
      id: current.id,
      decision: 'allow',
    };
    const suggestions = current.permission_suggestions || null;
    if (suggestions) {
      response.updatedPermissions = suggestions;
    }
    window.electronAPI.sendPermissionResponse(response);
    permissionQueue.shift();
    displayCurrentPermission();
  }
});

btnDeny.addEventListener('click', () => {
  const current = getCurrentRequest();
  if (current) {
    window.electronAPI.sendPermissionResponse({
      id: current.id,
      decision: 'deny',
      message: 'ユーザーが拒否したのだ',
    });
    permissionQueue.shift();
    displayCurrentPermission();
  }
});

// コンソール側で許可/拒否された場合、該当IDをキューから除去
window.electronAPI.onPermissionDismissed((data) => {
  const wasFirst = permissionQueue.length > 0 && permissionQueue[0].id === data.id;
  const queueBefore = permissionQueue.map((item) => item.id);
  permissionQueue = permissionQueue.filter((item) => item.id !== data.id);
  console.log('[DEBUG] onPermissionDismissed:', JSON.stringify({ dismissedId: data.id, wasFirst, queueBefore, queueAfter: permissionQueue.map((item) => item.id) }));

  if (wasFirst) {
    // 先頭が除去された場合、次を表示
    displayCurrentPermission();
  } else if (permissionQueue.length > 0) {
    // 待ち件数が変わったので再表示
    displayCurrentPermission();
  }
});

// dismiss メッセージで吹き出しを閉じる（キュー全クリア）
// ✅自動許可の吹き出しはdismissでは消さない（次の吹き出しで上書きされる）
window.electronAPI.onDismissBubble(() => {
  console.log('[DEBUG] onDismissBubble:', JSON.stringify({ queueBefore: permissionQueue.map((item) => item.id), bubbleVisible, isAutoApproveBubble }));
  permissionQueue = [];
  if (bubbleVisible && !isAutoApproveBubble) {
    hideBubble();
  }
});

// グローバルショートカットで許可/拒否
window.electronAPI.onShortcutAllow(() => {
  const current = getCurrentRequest();
  if (current) {
    window.electronAPI.sendPermissionResponse({
      id: current.id,
      decision: 'allow',
    });
    permissionQueue.shift();
    displayCurrentPermission();
  }
});

window.electronAPI.onShortcutDeny(() => {
  const current = getCurrentRequest();
  if (current) {
    window.electronAPI.sendPermissionResponse({
      id: current.id,
      decision: 'deny',
      message: 'ユーザーが拒否したのだ',
    });
    permissionQueue.shift();
    displayCurrentPermission();
  }
});

window.electronAPI.onShortcutAlwaysAllow(() => {
  const current = getCurrentRequest();
  if (current) {
    const response = {
      id: current.id,
      decision: 'allow',
    };
    const suggestions = current.permission_suggestions || null;
    if (suggestions) {
      response.updatedPermissions = suggestions;
    }
    window.electronAPI.sendPermissionResponse(response);
    permissionQueue.shift();
    displayCurrentPermission();
  }
});

// ドラッグ&ドロップによるウィンドウ移動
let isDragging = false;
function setupDrag() {
  let startMouseX = 0;
  let startMouseY = 0;
  let startWinX = 0;
  let startWinY = 0;

  character.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startMouseX = e.screenX;
    startMouseY = e.screenY;
    const [winX, winY] = await window.electronAPI.getWindowPosition();
    startWinX = winX;
    startWinY = winY;
    character.classList.add('dragging');
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.screenX - startMouseX;
    const dy = e.screenY - startMouseY;
    window.electronAPI.setWindowPosition(startWinX + dx, startWinY + dy);
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    character.classList.remove('dragging');
  });
}

// 右クリックメニューからの吹き出し非表示
window.electronAPI.onHideBubble(() => {
  hideBubble();
});

// 右クリックコンテキストメニュー
character.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.electronAPI.showContextMenu();
});

setupMouseForwarding();
setupDrag();
