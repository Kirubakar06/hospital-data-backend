import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const hashPassword = (password) => bcrypt.hash(password, 12);
export const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

export function createAccessToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role_name }, env.jwtSecret, { expiresIn: env.accessTtl });
}

export function createRefreshToken(userId) {
  const token = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + env.refreshDays * 86400000);
  return { token, tokenHash: hashToken(token), expiresAt };
}
