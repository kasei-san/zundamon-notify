/**
 * PR マージ検知モニター
 * GitHub PR の状態をポーリングし、マージされたら通知する
 */

const { exec } = require('child_process');

class PrMonitor {
  /**
   * @param {object} options
   * @param {function} options.onMerged - (info: {url, sessionId, owner, repo, number}) マージ検知時のコールバック
   * @param {number} [options.interval=60000] - ポーリング間隔（ミリ秒）
   */
  constructor({ onMerged, interval = 60000 }) {
    this.onMerged = onMerged;
    this.interval = interval;
    // Map<url, {owner, repo, number, sessionId, addedAt}>
    this.watchList = new Map();
    this.timer = null;
  }

  /**
   * GitHub PR URLからowner/repo/numberを抽出する
   * @param {string} url - https://github.com/<owner>/<repo>/pull/<number>
   * @returns {{owner: string, repo: string, number: number}|null}
   */
  static parseUrl(url) {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  /**
   * PRを監視リストに追加する
   * @param {string} url - GitHub PR URL
   * @param {string} sessionId - セッションID
   * @returns {boolean} 追加成功したかどうか
   */
  addPr(url, sessionId) {
    const parsed = PrMonitor.parseUrl(url);
    if (!parsed) {
      console.warn(`[PrMonitor] Invalid PR URL: ${url}`);
      return false;
    }

    // 既に監視中の場合はスキップ
    if (this.watchList.has(url)) {
      console.log(`[PrMonitor] Already watching: ${url}`);
      return false;
    }

    this.watchList.set(url, {
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      sessionId,
      addedAt: Date.now(),
    });

    console.log(`[PrMonitor] Watching PR: ${url} (session: ${sessionId})`);
    return true;
  }

  /**
   * PRを監視リストから削除する
   * @param {string} url - GitHub PR URL
   */
  removePr(url) {
    if (this.watchList.delete(url)) {
      console.log(`[PrMonitor] Removed PR: ${url}`);
    }
  }

  /**
   * 特定セッションのPRをすべて削除する
   * @param {string} sessionId
   */
  removeBySession(sessionId) {
    for (const [url, info] of this.watchList) {
      if (info.sessionId === sessionId) {
        this.watchList.delete(url);
        console.log(`[PrMonitor] Removed PR (session end): ${url}`);
      }
    }
  }

  /**
   * ポーリングを開始する
   */
  startPolling() {
    if (this.timer) return;
    console.log(`[PrMonitor] Polling started (interval: ${this.interval}ms)`);
    this.timer = setInterval(() => this.checkAll(), this.interval);
  }

  /**
   * ポーリングを停止する
   */
  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[PrMonitor] Polling stopped');
    }
  }

  /**
   * 全PRの状態をチェックする
   */
  async checkAll() {
    if (this.watchList.size === 0) return;

    console.log(`[PrMonitor] Checking ${this.watchList.size} PRs...`);

    for (const [url, info] of this.watchList) {
      try {
        const state = await this.checkPrState(info.owner, info.repo, info.number);
        if (state === 'MERGED') {
          console.log(`[PrMonitor] PR merged: ${url}`);
          this.watchList.delete(url);
          if (this.onMerged) {
            this.onMerged({
              url,
              sessionId: info.sessionId,
              owner: info.owner,
              repo: info.repo,
              number: info.number,
            });
          }
        }
      } catch (err) {
        console.error(`[PrMonitor] Error checking ${url}: ${err.message}`);
      }
    }
  }

  /**
   * gh コマンドでPRの状態を取得する
   * @param {string} owner
   * @param {string} repo
   * @param {number} number
   * @returns {Promise<string>} PR state (OPEN, CLOSED, MERGED)
   */
  checkPrState(owner, repo, number) {
    return new Promise((resolve, reject) => {
      const cmd = `gh pr view ${number} --repo ${owner}/${repo} --json state -q '.state'`;
      exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh command failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * 監視中のPR数を返す
   */
  get size() {
    return this.watchList.size;
  }
}

module.exports = { PrMonitor };
