import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { AppError, asyncHandler } from '../utils/errors.js';

export const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new AppError(401, 'Authentication is required.');

  let claims;
  try {
    claims = jwt.verify(token, env.jwtSecret);
  } catch {
    throw new AppError(401, 'Access token is invalid or expired.');
  }

  const [rows] = await pool.execute(
    `SELECT u.id, u.full_name, u.email, u.status, r.role_name
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [claims.sub],
  );
  const user = rows[0];
  if (!user || user.status !== 'Active') throw new AppError(401, 'User account is unavailable.');
  req.user = { id: user.id, name: user.full_name, email: user.email, role: user.role_name };
  next();
});
