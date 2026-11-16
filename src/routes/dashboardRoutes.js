import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';
import { asyncHandler, sendSuccess } from '../utils/errors.js';
import { hasPermission } from '../../shared/permissions.js';

const router = Router();
router.use(authenticate, authorize('dashboard', 'read'));

async function count(module, status) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM module_records WHERE module_key = ? AND deleted_at IS NULL${status ? ' AND status = ?' : ''}`,
    status ? [module, status] : [module],
  );
  return Number(rows[0].total);
}

router.get('/overview', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const canRead = (module) => hasPermission(req.user.role, module, 'read');
  const [patients, doctors, appointments, todayAppointments, availableRooms, occupiedRooms, bills] = await Promise.all([
    canRead('patients') ? count('patients') : Promise.resolve(null),
    canRead('doctors') ? count('doctors') : Promise.resolve(null),
    canRead('appointments') ? count('appointments') : Promise.resolve(null),
    canRead('appointments')
      ? pool.execute(`SELECT COUNT(*) AS total FROM module_records WHERE module_key = 'appointments' AND deleted_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')) = ?`, [today])
      : Promise.resolve(null),
    canRead('rooms') ? count('rooms', 'Available') : Promise.resolve(null),
    canRead('rooms') ? count('rooms', 'Occupied') : Promise.resolve(null),
    canRead('billing') ? pool.execute(`SELECT data FROM module_records WHERE module_key = 'billing' AND deleted_at IS NULL`) : Promise.resolve(null),
  ]);
  const billRows = bills?.[0] || [];
  const revenue = billRows.reduce((sum, row) => sum + Number(row.data.paidAmount || (row.data.status === 'Paid' ? row.data.amount : 0)), 0);
  const pendingPayments = billRows.reduce((sum, row) => sum + Number(row.data.balanceAmount ?? (['Pending', 'Overdue'].includes(row.data.status) ? row.data.amount : 0)), 0);
  return sendSuccess(res, {
    ...(patients !== null && { totalPatients: patients }),
    ...(doctors !== null && { totalDoctors: doctors }),
    ...(appointments !== null && { totalAppointments: appointments }),
    ...(todayAppointments && { todaysAppointments: Number(todayAppointments[0][0].total) }),
    ...(availableRooms !== null && { availableRooms }),
    ...(occupiedRooms !== null && { occupiedRooms }),
    ...(canRead('billing') && { totalRevenue: Number(revenue.toFixed(2)), pendingPayments: Number(pendingPayments.toFixed(2)) }),
  });
}));

router.get('/patient-statistics', authorize('patients', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.department')), 'Other') AS name, COUNT(*) AS value
     FROM module_records WHERE module_key = 'patients' AND deleted_at IS NULL GROUP BY name ORDER BY value DESC`,
  );
  return sendSuccess(res, rows);
}));

router.get('/appointment-statistics', authorize('appointments', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT COALESCE(status, 'Unspecified') AS status, COUNT(*) AS count
     FROM module_records WHERE module_key = 'appointments' AND deleted_at IS NULL GROUP BY status ORDER BY status`,
  );
  return sendSuccess(res, rows);
}));

router.get('/revenue-statistics', authorize('billing', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT COALESCE(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(data, '$.service')), ' ', 1), 'Other') AS name,
       SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.paidAmount')) AS DECIMAL(12,2)),
         IF(status = 'Paid', CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.amount')) AS DECIMAL(12,2)), 0))) AS amount
     FROM module_records WHERE module_key = 'billing' AND deleted_at IS NULL GROUP BY name ORDER BY amount DESC`,
  );
  return sendSuccess(res, rows);
}));

router.get('/room-statistics', authorize('rooms', 'read'), asyncHandler(async (req, res) => sendSuccess(res, {
  available: await count('rooms', 'Available'),
  occupied: await count('rooms', 'Occupied'),
  total: await count('rooms'),
})));

router.get('/recent-patients', authorize('patients', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT * FROM module_records WHERE module_key = 'patients' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10`,
  );
  return sendSuccess(res, rows.map((row) => ({ ...row.data, id: row.external_id })));
}));

router.get('/recent-activity', authorize('auditLogs', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.action, a.module_name, a.record_id, a.created_at, u.full_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 10`,
  );
  return sendSuccess(res, rows.map((row) => ({
    id: `LOG-${String(row.id).padStart(4, '0')}`,
    user: row.full_name || 'System', action: row.action,
    target: `${row.module_name}${row.record_id ? ` · ${row.record_id}` : ''}`,
    date: row.created_at, status: 'Success',
  })));
}));

router.get('/upcoming-appointments', authorize('appointments', 'read'), asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT * FROM module_records WHERE module_key = 'appointments' AND deleted_at IS NULL
     AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')) >= ? AND COALESCE(status, '') NOT IN ('Cancelled', 'Completed')
     ORDER BY JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')), JSON_UNQUOTE(JSON_EXTRACT(data, '$.time')) LIMIT 10`,
    [new Date().toISOString().slice(0, 10)],
  );
  return sendSuccess(res, rows.map((row) => ({ ...row.data, id: row.external_id })));
}));

export default router;
