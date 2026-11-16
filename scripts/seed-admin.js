import bcrypt from 'bcryptjs';
import { pool } from '../src/config/db.js';

const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password, BOOTSTRAP_ADMIN_NAME: name = 'Hospital Administrator' } = process.env;
if (!email || !password || password.length < 12) {
  throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 12 characters in backend/.env.');
}

try {
  const [existing] = await pool.execute('SELECT id FROM users LIMIT 1');
  if (existing.length) throw new Error('An administrator already exists. The seed command only works on an empty users table.');
  const [roles] = await pool.execute(`SELECT id FROM roles WHERE role_name = 'Super Admin'`);
  if (!roles.length) throw new Error('Role seed data is missing. Run npm run db:setup first.');
  await pool.execute('INSERT INTO users (full_name, email, password_hash, role_id) VALUES (?, ?, ?, ?)',
    [name, email, await bcrypt.hash(password, 12), roles[0].id]);
  console.log(`Initial administrator created for ${email}.`);
} finally {
  await pool.end();
}
