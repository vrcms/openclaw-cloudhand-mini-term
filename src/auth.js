const crypto = require('crypto');
const EventEmitter = require('events');

// 配对码 + Token 认证管理
class AuthManager extends EventEmitter {
  constructor() {
    super();
    this.pairCode = null;
    this.pairCodeExpiry = null;
    this.tokens = new Map();
    this.refreshInterval = null;

    const interval = parseInt(process.env.PAIR_CODE_INTERVAL || '300') * 1000;

    this._generatePairCode();
    this.refreshInterval = setInterval(() => {
      this._generatePairCode();
    }, interval);
  }

  // 生成 6 位随机数字配对码
  _generatePairCode() {
    this.pairCode = crypto.randomInt(100000, 999999).toString();
    const interval = parseInt(process.env.PAIR_CODE_INTERVAL || '300') * 1000;
    this.pairCodeExpiry = Date.now() + interval;
    this.emit('pairCodeChanged', {
      pairCode: this.pairCode,
      expiresAt: this.pairCodeExpiry
    });
  }

  // 验证配对码
  verify(code) {
    return this.pairCode === String(code);
  }

  // 签发 Token
  issueToken() {
    const token = crypto.randomUUID();
    this.tokens.set(token, { createdAt: Date.now() });
    return token;
  }

  // 验证 Token
  validateToken(token) {
    return this.tokens.has(token);
  }

  // 吊销 Token
  revokeToken(token) {
    this.tokens.delete(token);
  }

  // 获取当前配对码信息
  getPairCode() {
    return {
      pairCode: this.pairCode,
      expiresAt: this.pairCodeExpiry
    };
  }

  destroy() {
    clearInterval(this.refreshInterval);
  }
}

module.exports = AuthManager;
