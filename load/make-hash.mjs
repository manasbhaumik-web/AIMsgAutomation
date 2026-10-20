// Prints a password hash in the format the API verifies:  node load/make-hash.mjs LoadTest-Pass-123   (run npm run build first)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { hashPassword } = require('../apps/api/dist/auth/password.js');
console.log(await hashPassword(process.argv[2] ?? 'LoadTest-Pass-123'));
