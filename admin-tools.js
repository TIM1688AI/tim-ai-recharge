'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { passwordHash } = require('./workbench-security');
async function main() {
  if (process.argv[2] === 'migrate') {
    if (!process.env.DATABASE_URL) throw new Error('请先配置 DATABASE_URL');
    const pool = new (require('pg').Pool)({ connectionString: process.env.DATABASE_URL });
    try { await pool.query(fs.readFileSync(path.join(__dirname, 'workbench-schema.sql'), 'utf8')); console.log('工作台数据库迁移完成。'); } finally { await pool.end(); }
    return;
  }
  if (process.argv[2] !== 'setup') throw new Error('用法：npm run admin:setup 或 npm run admin:migrate');
  if (!process.stdin.isTTY) throw new Error('请在本机交互式终端执行 setup；不要在云端构建日志中生成密钥');
  console.log('设置管理员密码（至少 14 字符，输入不回显）：');
  readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true);
  const password = await new Promise(resolve => {
    let value = '';
    const onKey = (str, key) => { if (key?.ctrl && key.name === 'c') process.exit(1); if (key?.name === 'return') { process.stdin.off('keypress', onKey); process.stdin.setRawMode(false); process.stdin.pause(); resolve(value); } else if (key?.name === 'backspace') value = value.slice(0, -1); else if (str && !key?.ctrl) value += str; };
    process.stdin.on('keypress', onKey);
  });
  if (password.length < 14 || password.length > 256) throw new Error('密码须为 14–256 字符');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const secret = [...crypto.randomBytes(32)].map(b => alphabet[b & 31]).join('');
  console.log('\n仅在此可信终端显示一次；请存入密码管理器和 Render 环境变量，不要截图或提交 Git。');
  console.log('ADMIN_PASSWORD_HASH=' + await passwordHash(password));
  console.log('ADMIN_TOTP_SECRET=' + secret);
  console.log('ADMIN_DATA_KEY=' + crypto.randomBytes(32).toString('base64'));
  console.log('将 ADMIN_TOTP_SECRET 手动加入验证器：时间型、6 位、30 秒。不要重复运行后覆盖已有 ADMIN_DATA_KEY。');
}
main().catch(() => { console.error('操作未完成。请核对命令、数据库连接及密码要求；未打印连接信息。'); process.exitCode = 1; });
