const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const bubbleButtons = document.getElementById('bubble-buttons');
const btnAllow = document.getElementById('btn-allow');
const btnDeny = document.getElementById('btn-deny');
const btnClose = document.getElementById('btn-close');
const btnAlwaysAllow = document.getElementById('btn-always-allow');
const character = document.getElementById('character');

let currentRequestId = null;
let currentPermissionSuggestions = null;
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

    if (isOverCharacter || isOverBubble) {
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
  currentRequestId = null;
  currentPermissionSuggestions = null;
  btnAlwaysAllow.classList.add('hidden');

  // クリックスルーを復活
  window.electronAPI.setIgnoreMouse(true);
}

// Permission Request
window.electronAPI.onPermissionRequest((data) => {
  currentRequestId = data.id;
  const toolName = data.tool_name || 'Unknown';
  let description = data.description || '';

  if (data.tool_input && data.tool_input.command) {
    description = data.tool_input.command;
  }

  // 長すぎる場合は切り詰め
  if (description.length > 120) {
    description = description.substring(0, 120) + '...';
  }

  // permission_suggestionsがあれば「次回から聞かない」ボタンを表示
  currentPermissionSuggestions = data.permission_suggestions || null;
  if (currentPermissionSuggestions && currentPermissionSuggestions.length > 0) {
    btnAlwaysAllow.classList.remove('hidden');
  } else {
    btnAlwaysAllow.classList.add('hidden');
  }

  showBubble(`🔧 ${toolName}\n${description}`, true);
});

// Notification
window.electronAPI.onNotification((data) => {
  showBubble(data.message || '通知なのだ！');
});

// Stop (入力待ち)
window.electronAPI.onStop((data) => {
  showBubble(data.message || '入力を待っているのだ！');
});

// ボタンクリック
btnAllow.addEventListener('click', () => {
  if (currentRequestId) {
    window.electronAPI.sendPermissionResponse({
      id: currentRequestId,
      decision: 'allow',
    });
    hideBubble();
  }
});

// 「次回から聞かない」ボタン（許可 + updatedPermissions）
btnAlwaysAllow.addEventListener('click', () => {
  if (currentRequestId) {
    const response = {
      id: currentRequestId,
      decision: 'allow',
    };
    if (currentPermissionSuggestions) {
      response.updatedPermissions = currentPermissionSuggestions;
    }
    window.electronAPI.sendPermissionResponse(response);
    hideBubble();
  }
});

btnDeny.addEventListener('click', () => {
  if (currentRequestId) {
    window.electronAPI.sendPermissionResponse({
      id: currentRequestId,
      decision: 'deny',
      message: 'ユーザーが拒否したのだ',
    });
    hideBubble();
  }
});

// 閉じるボタン
btnClose.addEventListener('click', () => {
  hideBubble();
});

// コンソール側で許可/拒否された場合、吹き出しを閉じる
window.electronAPI.onPermissionDismissed((data) => {
  if (currentRequestId === data.id) {
    hideBubble();
  }
});

// dismiss メッセージで吹き出しを閉じる
window.electronAPI.onDismissBubble(() => {
  if (bubbleVisible) {
    hideBubble();
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
