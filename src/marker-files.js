/**
 * マーカーファイルによるAgent状態管理
 *
 * /tmp/zundamon-markers/<session_id>/ 配下にマーカーファイルを配置し、
 * hooks非依存でエージェントの状態遷移を追跡する。
 *
 * 状態遷移:
 *   .prompt_submitted あり, .agent_stopped なし → "working" (作業中)
 *   .prompt_submitted あり, .agent_stopped あり → "waiting" (入力待ち)
 *   どちらもなし                                → "idle" (待機中)
 */

const fs = require('fs');
const path = require('path');

const MARKER_BASE_DIR = '/tmp/zundamon-markers';

/**
 * セッションのAgent状態を取得する
 * @param {string} sessionId - セッションID
 * @returns {'working'|'waiting'|'idle'} Agent状態
 */
function getAgentState(sessionId) {
  const dir = path.join(MARKER_BASE_DIR, sessionId || 'default');
  const promptSubmitted = fs.existsSync(path.join(dir, '.prompt_submitted'));
  const agentStopped = fs.existsSync(path.join(dir, '.agent_stopped'));

  if (promptSubmitted && !agentStopped) return 'working';
  if (promptSubmitted && agentStopped) return 'waiting';
  return 'idle';
}

/**
 * セッションのマーカーファイルをクリーンアップする
 * @param {string} sessionId - セッションID
 */
function cleanupSession(sessionId) {
  const dir = path.join(MARKER_BASE_DIR, sessionId || 'default');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

/**
 * 全セッションIDの一覧を取得する
 * @returns {string[]} セッションIDの配列
 */
function listSessions() {
  try {
    return fs.readdirSync(MARKER_BASE_DIR).filter((f) => {
      return fs.statSync(path.join(MARKER_BASE_DIR, f)).isDirectory();
    });
  } catch {
    return [];
  }
}

module.exports = { getAgentState, cleanupSession, listSessions, MARKER_BASE_DIR };
