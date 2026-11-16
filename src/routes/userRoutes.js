import { Router } from 'express';
import { body, param } from 'express-validator';
import { pool, withTransaction } from '../config/db.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { writeAudit } from '../services/auditService.js';
import { hashPassword } from '../services/authService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/errors.js';

const router = Router();
const roleName = (value) => value === 'Administrator' ? 'Admin' : value;

router.use((req, res, next) => {
  const resource = req.path.split('/')[1];
  if (!['users', 'roles', 'permissions'].includes(resource)) return next();
  return authenticate(req, res, next);
});

router.get('/users', authorize('users', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.department, u.status, u.last_login, r.role_name
     FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.created_at DESC LIMIT 1000`,
  );
  const records = rows.map((row) => ({
    id: `US-${String(row.id).padStart(4, '0')}`,
    name: row.full_name, email: row.email,
    role: row.role_name === 'Admin' ? 'Administrator' : row.role_name,
    department: row.department || '', lastLogin: row.last_login, status: row.status,
  }));
  return sendSuccess(res, { records, total: records.length });
}));

router.post('/users', authorize('users', 'create'), [
  body('name').trim().isLength({ min: 2, max: 160 }),
  body('email').trim().isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 12, max: 128 }),
  body('role').trim().isLength({ min: 2, max: 80 }),
  body('status').optional().isIn(['Active', 'Inactive', 'Locked']),
], validateRequest, asyncHandler(async (req, res) => {
  const [roles] = await pool.execute('SELECT id, role_name FROM roles WHERE role_name = ?', [roleName(req.body.role)]);
  if (!roles.length) throw new AppError(422, 'Selected role does not exist.');
  const user = await withTransaction(async (connection) => {
    const [result] = await connection.execute(
      'INSERT INTO users (full_name, email, password_hash, role_id, department, status) VALUES (?, ?, ?, ?, ?, ?)',
      [req.body.name, req.body.email, await hashPassword(req.body.password), roles[0].id, req.body.department || null, req.body.status || 'Active'],
    );
    await writeAudit(connection, { userId: req.user.id, module: 'users', action: 'created', recordId: String(result.insertId), ip: req.ip });
    return { id: `US-${String(result.insertId).padStart(4, '0')}`, name: req.body.name, email: req.body.email, role: req.body.role, status: req.body.status || 'Active' };
  });
  return sendSuccess(res, user, 'User created successfully.', 201);
}));

router.put('/users/:id', authorize('users', 'update'), param('id').matches(/^US-\d{4,}$/),
  body().isObject(), validateRequest, asyncHandler(async (req, res) => {
    const numericId = req.params.id.slice(3);
    const [existing] = await pool.execute('SELECT id, full_name, email, role_id, department, status FROM users WHERE id = ?', [numericId]);
    if (!existing.length) throw new AppError(404, 'User not found.');
    const user = existing[0];
    const nextName = req.body.name ?? user.full_name;
    const nextEmail = req.body.email ?? user.email;
    const nextDepartment = req.body.department ?? user.department;
    const nextStatus = req.body.status ?? user.status;
    let nextRoleId = user.role_id;
    if (req.body.role) {
      const [roles] = await pool.execute('SELECT id FROM roles WHERE role_name = ?', [roleName(req.body.role)]);
      if (!roles.length) throw new AppError(422, 'Selected role does not exist.');
      nextRoleId = roles[0].id;
    }
    if (!nextName || nextName.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      throw new AppError(422, 'A valid user name and email are required.');
    }
    if (!['Active', 'Inactive', 'Locked'].includes(nextStatus)) throw new AppError(422, 'Invalid user status.');
    await withTransaction(async (connection) => {
      await connection.execute(
        'UPDATE users SET full_name = ?, email = ?, role_id = ?, department = ?, status = ? WHERE id = ?',
        [nextName, nextEmail, nextRoleId, nextDepartment || null, nextStatus, numericId],
      );
      if (req.body.password) {
        if (req.body.password.length < 12 || req.body.password.length > 128) throw new AppError(422, 'Password must be at least 12 characters.');
        await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(req.body.password), numericId]);
        await connection.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [numericId]);
      }
      await writeAudit(connection, { userId: req.user.id, module: 'users', action: 'updated', recordId: req.params.id, oldValues: user, newValues: { name: nextName, email: nextEmail, status: nextStatus }, ip: req.ip });
    });
    return sendSuccess(res, { id: req.params.id, name: nextName, email: nextEmail, status: nextStatus }, 'User updated successfully.');
  }));

router.get('/users/:id', authorize('users', 'read'), param('id').matches(/^US-\d{4,}$/),
  validateRequest, asyncHandler(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT u.id, u.full_name, u.email, u.department, u.status, u.last_login, r.role_name
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [req.params.id.slice(3)],
    );
    if (!rows.length) throw new AppError(404, 'User not found.');
    const user = rows[0];
    return sendSuccess(res, {
      id: req.params.id, name: user.full_name, email: user.email,
      department: user.department || '', role: user.role_name === 'Admin' ? 'Administrator' : user.role_name,
      status: user.status, lastLogin: user.last_login,
    });
  }));

router.patch('/users/:id/status', authorize('users', 'update'), param('id').matches(/^US-\d{4,}$/),
  body('status').isIn(['Active', 'Inactive', 'Locked']), validateRequest, asyncHandler(async (req, res) => {
    await withTransaction(async (connection) => {
      const [result] = await connection.execute('UPDATE users SET status = ? WHERE id = ?',
        [req.body.status, req.params.id.slice(3)]);
      if (!result.affectedRows) {
        const [existing] = await connection.execute('SELECT id FROM users WHERE id = ?', [req.params.id.slice(3)]);
        if (!existing.length) throw new AppError(404, 'User not found.');
      }
      await connection.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL',
        [req.params.id.slice(3)]);
      await writeAudit(connection, { userId: req.user.id, module: 'users', action: 'status_updated', recordId: req.params.id, newValues: { status: req.body.status }, ip: req.ip });
    });
    return sendSuccess(res, { id: req.params.id, status: req.body.status });
  }));

router.delete('/users/:id', authorize('users', 'delete'), param('id').matches(/^US-\d{4,}$/),
  validateRequest, asyncHandler(async (req, res) => {
    if (req.params.id === `US-${String(req.user.id).padStart(4, '0')}`) throw new AppError(409, 'You cannot deactivate your own account.');
    await withTransaction(async (connection) => {
      const [result] = await connection.execute('UPDATE users SET status = ? WHERE id = ?', ['Inactive', req.params.id.slice(3)]);
      if (!result.affectedRows) {
        const [existing] = await connection.execute('SELECT id FROM users WHERE id = ?', [req.params.id.slice(3)]);
        if (!existing.length) throw new AppError(404, 'User not found.');
      }
      await connection.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL',
        [req.params.id.slice(3)]);
      await writeAudit(connection, { userId: req.user.id, module: 'users', action: 'deactivated', recordId: req.params.id, ip: req.ip });
    });
    return sendSuccess(res, { id: req.params.id }, 'User deactivated.');
  }));

router.get('/roles', authorize('users', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id, role_name AS name, description FROM roles ORDER BY role_name');
  return sendSuccess(res, rows);
}));

router.post('/roles', authorize('users', 'create'), body('name').trim().isLength({ min: 2, max: 80 }),
  body('description').optional().isLength({ max: 255 }), validateRequest, asyncHandler(async (req, res) => {
    const role = await withTransaction(async (connection) => {
      const [result] = await connection.execute('INSERT INTO roles (role_name, description) VALUES (?, ?)', [req.body.name, req.body.description || null]);
      await writeAudit(connection, { userId: req.user.id, module: 'roles', action: 'created', recordId: String(result.insertId), newValues: { name: req.body.name }, ip: req.ip });
      return { id: result.insertId, name: req.body.name };
    });
    return sendSuccess(res, role, 'Role created.', 201);
  }));

router.put('/roles/:id', authorize('users', 'update'), param('id').isInt({ min: 1 }),
  body('name').optional().trim().isLength({ min: 2, max: 80 }), body('description').optional().isLength({ max: 255 }),
  validateRequest, asyncHandler(async (req, res) => {
    await withTransaction(async (connection) => {
      const [rows] = await connection.execute('SELECT id, role_name, description FROM roles WHERE id = ? FOR UPDATE', [req.params.id]);
      if (!rows.length) throw new AppError(404, 'Role not found.');
      await connection.execute('UPDATE roles SET role_name = COALESCE(?, role_name), description = COALESCE(?, description) WHERE id = ?',
        [req.body.name || null, req.body.description || null, req.params.id]);
      await writeAudit(connection, { userId: req.user.id, module: 'roles', action: 'updated', recordId: req.params.id,
        oldValues: rows[0], newValues: { name: req.body.name, description: req.body.description }, ip: req.ip });
    });
    return sendSuccess(res, { id: Number(req.params.id), name: req.body.name });
  }));

router.get('/permissions', authorize('users', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id, permission_name AS name, module_name AS module FROM permissions ORDER BY module_name, permission_name');
  return sendSuccess(res, rows);
}));

export default router;
