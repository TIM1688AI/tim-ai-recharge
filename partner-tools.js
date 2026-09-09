// Offline provisioning helper. Never calls a provider or changes configuration.
const crypto = require('node:crypto');
const { cardHash } = require('./partner-api');
const action = process.argv[2];
if (action === 'key') {
  const key = crypto.randomBytes(32).toString('base64url');
  console.log(JSON.stringify({ api_key: key, key_hash: crypto.createHash('sha256').update(key).digest('hex') }, null, 2));
} else if (action === 'card-hash') {
  const secret = process.env.PARTNER_HASH_SECRET;
  const channel = process.argv[3];
  if (!secret || secret.length < 32 || !['advanced', 'regular'].includes(channel)) throw new Error('Set PARTNER_HASH_SECRET and select advanced or regular');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 20000) process.exit(1); });
  process.stdin.on('end', () => {
    for (const card of input.split(/\r?\n/).filter(v => v.trim())) console.log(cardHash(secret, channel, card));
  });
} else {
  console.log('node partner-tools.js key\nnode partner-tools.js card-hash advanced < cards.txt');
  process.exitCode = 1;
}
