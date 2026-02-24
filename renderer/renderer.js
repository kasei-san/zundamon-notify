const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const bubbleButtons = document.getElementById('bubble-buttons');
const btnAllow = document.getElementById('btn-allow');
const btnDeny = document.getElementById('btn-deny');
const btnClose = document.getElementById('btn-close');
const btnAlwaysAllow = document.getElementById('btn-always-allow');
const character = document.getElementById('character');
const projectName = document.getElementById('project-name');
const appEl = document.getElementById('app');

// Permission リクエストのキュー（複数同時対応）
let permissionQueue = [];
let bubbleVisible = false;

// マウスがUI要素に乗ったらクリックスルーを解除、離れたら復活
function setupMouseForwarding() {
  document.addEventListener('mouseenter', () => {
    // 吹き出し表示中はクリックスルーを解除
    if (bubbleVisible) {
      window.electronAPI.setIgnoreMouse(false);
    }
  });

  document.addEventListener('mouseleave', () => {
    window.electronAPI.setIgnoreMouse(true);
  });

  // mousemoveでもチェック（forward: trueでmousemoveが来る）
  document.addEventListener('mousemove', (e) => {
    const isOverCharacter = isPointInElement(e, character);
    const isOverBubble = bubbleVisible && isPointInElement(e, bubble);
    const isOverProjectName = projectName.textContent && isPointInElement(e, projectName);

    if (isOverCharacter || isOverBubble || isOverProjectName) {
      window.electronAPI.setIgnoreMouse(false);
    } else if (!bubbleVisible) {
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

function showBubble(text, showButtons = false) {
  bubbleText.textContent = text;
  bubbleVisible = true;

  if (showButtons) {
    bubbleButtons.classList.remove('hidden');
    btnClose.classList.add('hidden');
  } else {
    bubbleButtons.classList.add('hidden');
    btnClose.classList.remove('hidden');
  }

  bubble.classList.remove('hidden');

  // 吹き出し表示中はクリックスルーを解除
  window.electronAPI.setIgnoreMouse(false);
}

function hideBubble() {
  bubble.classList.add('hidden');
  bubbleVisible = false;
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
  let description = data.description || '';

  if (data.tool_input && data.tool_input.command) {
    description = data.tool_input.command;
  }

  // 長すぎる場合は切り詰め
  if (description.length > 120) {
    description = description.substring(0, 120) + '...';
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

  // セッションタイトルを表示（タイトルがなければcwdのディレクトリ名）
  if (info.title) {
    projectName.textContent = info.title;
  } else if (info.cwd) {
    const dirName = info.cwd.split('/').filter(Boolean).pop() || '';
    projectName.textContent = dirName;
  }

  // 色テーマ適用
  if (info.colorTheme) {
    const theme = info.colorTheme;
    appEl.style.setProperty('--theme-primary', theme.primary);
    appEl.style.setProperty('--theme-hover-bg', theme.hoverBg);
    appEl.style.setProperty('--theme-shadow', theme.shadow.replace('@@', '0.4'));
    appEl.style.setProperty('--theme-shadow-light', theme.shadow.replace('@@', '0.2'));

    // ずんだもんの色相を変更
    if (theme.hueRotate) {
      const img = character.querySelector('img');
      if (img) {
        img.style.filter = `hue-rotate(${theme.hueRotate}deg)`;
      }
    }
  }
});

// Permission Request
window.electronAPI.onPermissionRequest((data) => {
  permissionQueue.push(data);
  displayCurrentPermission();
});

// Notification
window.electronAPI.onNotification((data) => {
  // Permissionキューがある場合はNotificationを表示しない（キューを維持）
  if (permissionQueue.length > 0) return;
  showBubble(data.message || '通知なのだ！');
});

// Stop (入力待ち)
window.electronAPI.onStop((data) => {
  // Permissionキューがある場合はStopを表示しない（キューを維持）
  if (permissionQueue.length > 0) return;
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

// 閉じるボタン
btnClose.addEventListener('click', () => {
  hideBubble();
});

// コンソール側で許可/拒否された場合、該当IDをキューから除去
window.electronAPI.onPermissionDismissed((data) => {
  const wasFirst = permissionQueue.length > 0 && permissionQueue[0].id === data.id;
  permissionQueue = permissionQueue.filter((item) => item.id !== data.id);

  if (wasFirst) {
    // 先頭が除去された場合、次を表示
    displayCurrentPermission();
  } else if (permissionQueue.length > 0) {
    // 待ち件数が変わったので再表示
    displayCurrentPermission();
  }
});

// dismiss メッセージで吹き出しを閉じる（キュー全クリア）
window.electronAPI.onDismissBubble(() => {
  permissionQueue = [];
  if (bubbleVisible) {
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
function setupDrag() {
  let isDragging = false;
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

// 右クリックコンテキストメニュー
character.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.electronAPI.showContextMenu();
});

setupMouseForwarding();
setupDrag();
