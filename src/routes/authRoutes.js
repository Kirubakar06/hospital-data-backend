import { Router } from 'express';
import { body } from 'express-validator';
import { pool, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { writeAudit } from '../services/auditService.js';
import { createAccessToken, createRefreshToken, hashPassword, hashToken, verifyPassword } from '../services/authService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/errors.js';

const router = Router();
const cookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: env.refreshDays * 86400000,
};

function setRefreshCookie(res, token) {
  res.cookie('refreshToken', token, cookieOptions);
}

function clearRefreshCookie(res) {
  res.clearCookie('refreshToken', { ...cookieOptions, maxAge: undefined });
}

router.get('/setup-status', asyncHandler(async (req, res) => {
  const [rows] = await pool.execute('SELECT EXISTS(SELECT 1 FROM users LIMIT 1) AS has_users');
  return sendSuccess(res, { setupRequired: !Boolean(rows[0].has_users) });
}));

router.post('/setup', [
  body('name').trim().isLength({ min: 2, max: 160 }),
  body('email').trim().isEmail().normalizeEmail(),
  body('password').isLength({ min: 12, max: 128 }),
], validateRequest, asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const session = await withTransaction(async (connection) => {
    const [roles] = await connection.execute(`SELECT id, role_name FROM roles WHERE role_name = 'Super Admin' FOR UPDATE`);
    if (!roles.length) throw new AppError(500, 'Role seed data is missing. Run the database setup script.');
    const [existing] = await connection.execute('SELECT id FROM users LIMIT 1');
    if (existing.length) throw new AppError(409, 'Initial administrator setup has already been completed.');
    const [created] = await connection.execute(
      'INSERT INTO users (full_name, email, password_hash, role_id) VALUES (?, ?, ?, ?)',
      [name, email, await hashPassword(password), roles[0].id],
    );
    const user = { id: created.insertId, full_name: name, email, role_name: roles[0].role_name };
    const refresh = createRefreshToken(user.id);
    await connection.execute('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.id, refresh.tokenHash, refresh.expiresAt]);
    await writeAudit(connection, { userId: user.id, module: 'users', action: 'bootstrap', recordId: String(user.id), ip: req.ip });
    return { user, accessToken: createAccessToken(user), refreshToken: refresh.token };
  });
  setRefreshCookie(res, session.refreshToken);
  return sendSuccess(res, { user: { id: session.user.id, name: session.user.full_name, email, role: session.user.role_name }, accessToken: session.accessToken },
    'Administrator account created.', 201);
}));

router.post('/register', [
  body('name').trim().isLength({ min: 2, max: 160 }),
  body('email').trim().isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 12, max: 128 }),
], validateRequest, asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const registration = await withTransaction(async (connection) => {
    const [roles] = await connection.execute(
      `SELECT id FROM roles WHERE role_name = 'Receptionist' LIMIT 1`,
    );
    if (!roles.length) throw new AppError(500, 'Role seed data is missing. Run the database setup script.');
    const [created] = await connection.execute(
      `INSERT INTO users (full_name, email, password_hash, role_id, status)
       VALUES (?, ?, ?, ?, 'Inactive')`,
      [name, email, await hashPassword(password), roles[0].id],
    );
    await writeAudit(connection, {
      userId: null, module: 'users', action: 'self_registration_pending',
      recordId: String(created.insertId), newValues: { email, role: 'Receptionist', status: 'Inactive' }, ip: req.ip,
    });
    return { id: created.insertId, name, email };
  });
  return sendSuccess(res, {
    user: { id: registration.id, name: registration.name, email: registration.email, role: 'Receptionist', status: 'Inactive' },
  }, 'Account created. An administrator must approve it before you can sign in.', 201);
}));

router.post('/login', [
  body('email').trim().isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 1, max: 128 }),
], validateRequest, asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, u.password_hash, u.status, r.role_name
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ? LIMIT 1`,
    [req.body.email],
  );
  const user = rows[0];
  if (!user || user.status !== 'Active' || !(await verifyPassword(req.body.password, user.password_hash))) {
    throw new AppError(401, 'Email or password is incorrect.');
  }
  const refresh = createRefreshToken(user.id);
  await withTransaction(async (connection) => {
    await connection.execute('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.id, refresh.tokenHash, refresh.expiresAt]);
    await connection.execute('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    await writeAudit(connection, { userId: user.id, module: 'auth', action: 'login', recordId: String(user.id), ip: req.ip });
  });
  setRefreshCookie(res, refresh.token);
  return sendSuccess(res, {
    user: { id: user.id, name: user.full_name, email: user.email, role: user.role_name },
    accessToken: createAccessToken(user),
  }, 'Signed in successfully.');
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) throw new AppError(401, 'Refresh token is required.');
  const tokenHash = hashToken(token);
  const session = await withTransaction(async (connection) => {
    const [rows] = await connection.execute(
      `SELECT rt.id AS token_id, u.id, u.full_name, u.email, u.status, r.role_name
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id JOIN roles r ON r.id = u.role_id
       WHERE rt.token_hash = ? AND rt.revoked_at IS NULL AND rt.expires_at > CURRENT_TIMESTAMP FOR UPDATE`,
      [tokenHash],
    );
    const user = rows[0];
    if (!user || user.status !== 'Active') throw new AppError(401, 'Refresh token is invalid or expired.');
    const refresh = createRefreshToken(user.id);
    await connection.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [user.token_id]);
    await connection.execute('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [user.id, refresh.tokenHash, refresh.expiresAt]);
    return { user, refresh };
  });
  setRefreshCookie(res, session.refresh.token);
  return sendSuccess(res, {
    user: { id: session.user.id, name: session.user.full_name, email: session.user.email, role: session.user.role_name },
    accessToken: createAccessToken(session.user),
  }, 'Access token refreshed.');
}));

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    await pool.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL',
      [hashToken(token)]);
  }
  clearRefreshCookie(res);
  if (req.user) {
    await withTransaction((connection) => writeAudit(connection, {
      userId: req.user.id, module: 'auth', action: 'logout', recordId: String(req.user.id), ip: req.ip,
    }));
  }
  return sendSuccess(res, null, 'Signed out successfully.');
}));

router.get('/me', authenticate, (req, res) => sendSuccess(res, { user: req.user }));

router.post('/change-password', authenticate, [
  body('currentPassword').isString().isLength({ min: 1, max: 128 }),
  body('newPassword').isString().isLength({ min: 12, max: 128 }),
], validateRequest, asyncHandler(async (req, res) => {
  const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!rows[0] || !(await verifyPassword(req.body.currentPassword, rows[0].password_hash))) {
    throw new AppError(400, 'Current password is incorrect.');
  }
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(req.body.newPassword), req.user.id]);
    await connection.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [req.user.id]);
    await writeAudit(connection, { userId: req.user.id, module: 'users', action: 'password_change', recordId: String(req.user.id), ip: req.ip });
  });
  clearRefreshCookie(res);
  return sendSuccess(res, null, 'Password changed. Please sign in again.');
}));

export default router;
