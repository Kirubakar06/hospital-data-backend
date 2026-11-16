import { Router } from 'express';
import { pool } from '../config/db.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';
import { asyncHandler, sendSuccess } from '../utils/errors.js';

const router = Router();
router.use(authenticate, authorize('reports', 'read'));

router.get('/patients', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT COALESCE(status, 'Unspecified') AS status, COUNT(*) AS total
     FROM module_records WHERE module_key = 'patients' AND deleted_at IS NULL GROUP BY status`,
  );
  return sendSuccess(res, rows);
}));

router.get('/appointments', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')) AS date, COALESCE(status, 'Unspecified') AS status, COUNT(*) AS total
     FROM module_records WHERE module_key = 'appointments' AND deleted_at IS NULL
     GROUP BY date, status ORDER BY date DESC LIMIT 366`,
  );
  return sendSuccess(res, rows);
}));

router.get('/revenue', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       SUM(COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.paidAmount')) AS DECIMAL(12,2)),
         IF(status = 'Paid', CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.amount')) AS DECIMAL(12,2)), 0))) AS revenue
     FROM module_records WHERE module_key = 'billing' AND deleted_at IS NULL
     GROUP BY month ORDER BY month DESC LIMIT 60`,
  );
  return sendSuccess(res, rows);
}));

router.get('/payments', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT external_id AS id, data, created_at FROM module_records
     WHERE module_key = 'payments' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`,
  );
  return sendSuccess(res, rows.map((row) => ({ ...row.data, id: row.id, createdAt: row.created_at })));
}));

export default router;
