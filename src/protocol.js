/**
 * メッセージプロトコル定義
 * Hook Script ⇔ Electron App 間のJSON Lines通信
 */

const MESSAGE_TYPES = {
  PERMISSION_REQUEST: 'permission_request',
  NOTIFICATION: 'notification',
  STOP: 'stop',
  DISMISS: 'dismiss',
  SESSION_END: 'session_end',
};

/**
 * JSON Linesからメッセージをパースする
 * @param {string} line - JSON文字列（1行）
 * @returns {object|null}
 */
function parseMessage(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const msg = JSON.parse(trimmed);
    if (!msg.type || !msg.id) return null;
    // session_id未設定時は"default"にフォールバック
    if (!msg.session_id) {
      msg.session_id = 'default';
    }
    return msg;
  } catch {
    return null;
  }
}

/**
 * レスポンスをJSON文字列にシリアライズする
 * @param {object} response - {id, decision, message?}
 * @returns {string}
 */
function serializeResponse(response) {
  return JSON.stringify(response) + '\n';
}

module.exports = { MESSAGE_TYPES, parseMessage, serializeResponse };
