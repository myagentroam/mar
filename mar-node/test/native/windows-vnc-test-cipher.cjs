// Test-only VNC password storage and challenge encryption for the Windows runner.
const { createCipheriv } = require('node:crypto');

const password = Buffer.from(process.env.MAR_RFB_PASSWORD, 'ascii');
if (!password.length || password.length > 8 || password.includes(0)) throw new Error('test password');
const reverse = (v) => parseInt(v.toString(2).padStart(8, '0').split('').reverse().join(''), 2);
const key = Buffer.alloc(8);
if (process.argv[2] !== 'challenge') Buffer.from([23, 82, 107, 6, 35, 78, 88, 7]).forEach((v, i) => (key[i] = reverse(v)));
else password.forEach((v, i) => (key[i] = reverse(v)));
const input = process.argv[2] === 'challenge' ? Buffer.from(process.argv[3], 'hex') : Buffer.alloc(8);
if (process.argv[2] !== 'challenge') password.copy(input);
const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
cipher.setAutoPadding(false);
const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
if (process.argv[2] === 'profile') {
  const checksum = encrypted.reduce((sum, byte) => (sum + byte) & 255, 0);
  process.stdout.write(Buffer.concat([encrypted, Buffer.from([checksum])]).toString('hex'));
} else process.stdout.write(encrypted.toString('hex'));
