import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { body, param } from 'express-validator';
import { pool, withTransaction } from '../config/db.js';
import { authenticate } from '../middleware/authMiddleware.js';
import { authorize } from '../middleware/roleMiddleware.js';
import { validateRequest } from '../middleware/validationMiddleware.js';
import { writeAudit } from '../services/auditService.js';
import { AppError, asyncHandler, sendSuccess } from '../utils/errors.js';

const router = Router();
const prefixes = {
  patients: 'PT', doctors: 'DR', departments: 'DEP', appointments: 'AP', rooms: 'RM',
  admissions: 'AD', medicalRecords: 'MR', prescriptions: 'RX', laboratory: 'LB',
  billing: 'BL', payments: 'PY', staff: 'ST', reports: 'RP', users: 'US',
  settings: 'SET',
};
const readOnlyModules = new Set(['auditLogs']);
const noDeleteModules = new Set(['medicalRecords', 'payments']);
const sensitiveKey = /(password|token|secret|card.?number|cvv)/i;

function requireModuleAction(action) {
  return (req, res, next) => {
    const module = req.params.module;
    if (!prefixes[module] && module !== 'auditLogs') return next(new AppError(404, `Route not found: ${req.method} ${req.path}`));
    return authorize(module, action)(req, res, next);
  };
}

function assertRecord(module, value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new AppError(422, 'Record data must be a JSON object.');
  if (Object.keys(value).length > 80 || Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) {
    throw new AppError(422, 'Record data exceeds the allowed size.');
  }
  for (const key of Object.keys(value)) {
    if (sensitiveKey.test(key)) throw new AppError(422, `Sensitive field "${key}" cannot be stored in this record.`);
  }
  if (module === 'patients') {
    if (!String(value.name || '').trim()) throw new AppError(422, 'Patient name is required.');
    if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) throw new AppError(422, 'Patient email is invalid.');
    if (value.dateOfBirth && Number.isNaN(Date.parse(value.dateOfBirth))) throw new AppError(422, 'Date of birth is invalid.');
  }
  if (module === 'appointments') {
    if (!value.patient || !value.doctor || !/^\d{4}-\d{2}-\d{2}$/.test(value.date || '') || !/^\d{2}:\d{2}$/.test(value.time || '')) {
      throw new AppError(422, 'Appointment requires a patient, doctor, valid date, and time.');
    }
    const appointmentTime = Date.parse(`${value.date}T${value.time}:00`);
    if (Number.isNaN(appointmentTime) || appointmentTime < Date.now() - 60000
      || Number(value.time.slice(0, 2)) > 23 || Number(value.time.slice(3, 5)) > 59) {
      throw new AppError(422, 'Appointment date and time must be valid and in the future.');
    }
  }
  if (module === 'billing' && (!Number.isFinite(Number(value.amount)) || Number(value.amount) <= 0)) {
    throw new AppError(422, 'Invoice amount must be greater than zero.');
  }
  if (module === 'payments') {
    if (!value.invoice || !Number.isFinite(Number(value.amount)) || Number(value.amount) <= 0) {
      throw new AppError(422, 'Payment requires an invoice and a positive amount.');
    }
    if (value.status && value.status !== 'Completed') throw new AppError(422, 'Only completed payments can be recorded.');
  }
}

function toRecord(row) {
  return { ...(row.data || {}), id: row.external_id, createdAt: row.created_at, updatedAt: row.updated_at };
}

async function findRecord(connection, module, id, lock = false) {
  const [rows] = await connection.execute(
    `SELECT * FROM module_records WHERE module_key = ? AND external_id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [module, id],
  );
  return rows[0] || null;
}

async function checkAppointmentConflict(connection, data, excludedId) {
  if (['Cancelled', 'Completed', 'No Show'].includes(data.status)) return;
  const [conflicts] = await connection.execute(
    `SELECT external_id FROM module_records
     WHERE module_key = 'appointments' AND deleted_at IS NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.doctor')) = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.date')) = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.time')) = ?
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')), '') NOT IN ('Cancelled', 'Completed', 'No Show')
       AND (? IS NULL OR external_id <> ?)
     LIMIT 1 FOR UPDATE`,
    [data.doctor, data.date, data.time, excludedId || null, excludedId || null],
  );
  if (conflicts.length) throw new AppError(409, 'This doctor already has an appointment at that time.');
}

async function validateRoomAdmission(connection, data, currentId, currentRoom) {
  if (data.status === 'Discharged') return;
  const [rows] = await connection.execute(
    `SELECT id, data FROM module_records WHERE module_key = 'rooms' AND deleted_at IS NULL
     AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.room')) = ? LIMIT 1 FOR UPDATE`,
    [String(data.room || '')],
  );
  if (!rows[0]) throw new AppError(422, 'The selected room does not exist.');
  const room = rows[0].data;
  if (room.status !== 'Available' && !(currentId && currentRoom === String(data.room) && room.status === 'Occupied')) {
    throw new AppError(409, 'The selected room is not available.');
  }
  return rows[0];
}

async function writeRecord(connection, { module, id, data, user, ip, action }) {
  let oldRow = id ? await findRecord(connection, module, id, true) : null;
  if (id && !oldRow) throw new AppError(404, 'Record not found.');
  let oldData = oldRow?.data || null;
  if (module === 'appointments') await checkAppointmentConflict(connection, data, id);
  if (module === 'rooms' && oldRow && data.status === 'Available' && oldData.status !== 'Available') {
    const [activeAdmissions] = await connection.execute(
      `SELECT external_id FROM module_records WHERE module_key = 'admissions' AND deleted_at IS NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.room')) = ?
       AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')), '') <> 'Discharged' LIMIT 1 FOR UPDATE`,
      [String(oldData.room)],
    );
    if (activeAdmissions.length) throw new AppError(409, 'A room assigned to an active admission cannot be marked available.');
  }
  if (module === 'billing' && oldRow && Number(oldData.paidAmount || 0) > 0) {
    const paidAmount = Number(oldData.paidAmount);
    if (Number(data.amount) < paidAmount) throw new AppError(409, 'Invoice total cannot be lower than payments already received.');
    data = {
      ...data,
      paidAmount,
      balanceAmount: Number((Number(data.amount) - paidAmount).toFixed(2)),
      status: Number(data.amount) - paidAmount <= 0 ? 'Paid' : 'Pending',
    };
  }

  if (module === 'admissions' && data.status !== 'Discharged') {
    const roomRow = await validateRoomAdmission(connection, data, id, oldData?.room);
    if (roomRow) {
      const roomData = { ...roomRow.data, status: 'Occupied' };
      await connection.execute(
        'UPDATE module_records SET data = ?, status = ?, updated_by = ? WHERE id = ?',
        [JSON.stringify(roomData), roomData.status, user.id, roomRow.id],
      );
    }
  }
  if (module === 'admissions' && oldData?.room && String(oldData.room) !== String(data.room)) {
    const [oldRooms] = await connection.execute(
      `SELECT id, data FROM module_records WHERE module_key = 'rooms' AND deleted_at IS NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.room')) = ? LIMIT 1 FOR UPDATE`,
      [String(oldData.room)],
    );
    if (oldRooms[0]) {
      const roomData = { ...oldRooms[0].data, status: 'Available' };
      await connection.execute('UPDATE module_records SET data = ?, status = ?, updated_by = ? WHERE id = ?',
        [JSON.stringify(roomData), roomData.status, user.id, oldRooms[0].id]);
    }
  }
  if (module === 'admissions' && data.status === 'Discharged' && oldData?.room) {
    const [rooms] = await connection.execute(
      `SELECT id, data FROM module_records WHERE module_key = 'rooms' AND deleted_at IS NULL
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.room')) = ? LIMIT 1 FOR UPDATE`,
      [String(oldData.room)],
    );
    if (rooms[0]) {
      const roomData = { ...rooms[0].data, status: 'Available' };
      await connection.execute('UPDATE module_records SET data = ?, status = ?, updated_by = ? WHERE id = ?',
        [JSON.stringify(roomData), roomData.status, user.id, rooms[0].id]);
    }
  }

  if (module === 'payments') {
    if (data.transactionReference) {
      const [duplicates] = await connection.execute(
        `SELECT external_id FROM module_records WHERE module_key = 'payments' AND deleted_at IS NULL
         AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.transactionReference')) = ? LIMIT 1`,
        [data.transactionReference],
      );
      if (duplicates.length) throw new AppError(409, 'Payment transaction reference already exists.');
    }
    const bill = await findRecord(connection, 'billing', data.invoice, true);
    if (!bill) throw new AppError(404, 'Invoice not found.');
    const billData = bill.data;
    const total = Number(billData.amount);
    const paid = Number(billData.paidAmount || 0);
    const amount = Number(data.amount);
    if (amount > total - paid + 0.000001) throw new AppError(409, 'Payment exceeds the invoice balance.');
    data = { ...data, status: 'Completed' };
    const updatedBill = { ...billData, paidAmount: Number((paid + amount).toFixed(2)), balanceAmount: Number((total - paid - amount).toFixed(2)) };
    updatedBill.status = updatedBill.balanceAmount <= 0 ? 'Paid' : 'Pending';
    await connection.execute(
      'UPDATE module_records SET data = ?, status = ?, updated_by = ? WHERE id = ?',
      [JSON.stringify(updatedBill), updatedBill.status, user.id, bill.id],
    );
    await writeAudit(connection, { userId: user.id, module: 'billing', action: 'payment_applied', recordId: bill.external_id, oldValues: billData, newValues: updatedBill, ip });
  }

  if (oldRow) {
    await connection.execute(
      'UPDATE module_records SET data = ?, status = ?, updated_by = ? WHERE id = ?',
      [JSON.stringify(data), data.status || null, user.id, oldRow.id],
    );
  } else {
    const [inserted] = await connection.execute(
      'INSERT INTO module_records (module_key, external_id, data, status, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
      [module, `TMP-${randomUUID()}`, JSON.stringify(data), data.status || null, user.id, user.id],
    );
    const externalId = `${prefixes[module]}-${String(inserted.insertId).padStart(4, '0')}`;
    await connection.execute('UPDATE module_records SET external_id = ? WHERE id = ?', [externalId, inserted.insertId]);
    id = externalId;
  }
  const currentRow = await findRecord(connection, module, id);
  await writeAudit(connection, {
    userId: user.id, module, action, recordId: id, oldValues: oldData, newValues: data, ip,
  });
  return toRecord(currentRow);
}

router.use((req, res, next) => {
  const module = req.path.split('/')[1];
  if (!prefixes[module] && module !== 'auditLogs') return next();
  return authenticate(req, res, next);
});

router.get('/auditLogs', authorize('auditLogs', 'read'), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const [rows] = await pool.query(
    `SELECT a.id, a.module_name, a.action, a.record_id, a.old_values, a.new_values, a.ip_address, a.created_at, u.full_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT ${limit}`,
  );
  const records = rows.map((row) => ({
    id: `LOG-${String(row.id).padStart(4, '0')}`, user: row.full_name || 'System',
    action: row.action, target: `${row.module_name}${row.record_id ? ` · ${row.record_id}` : ''}`,
    date: row.created_at, ip: row.ip_address || '', status: 'Success',
    module: row.module_name, oldValues: row.old_values, newValues: row.new_values,
  }));
  return sendSuccess(res, { records, total: records.length });
}));

router.get('/:module/search', requireModuleAction('read'), asyncHandler(async (req, res) => {
  if (req.params.module !== 'patients') throw new AppError(404, 'Search endpoint not found.');
  const query = String(req.query.q || '').trim().slice(0, 160);
  if (query.length < 1) throw new AppError(422, 'Search query is required.');
  const like = `%${query}%`;
  const [rows] = await pool.execute(
    `SELECT * FROM module_records WHERE module_key = 'patients' AND deleted_at IS NULL
     AND (external_id LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.name')) LIKE ?
       OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.phone')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.email')) LIKE ?
       OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.city')) LIKE ?)
     ORDER BY created_at DESC LIMIT 100`,
    [like, like, like, like, like],
  );
  await pool.execute('INSERT INTO patient_search_logs (user_id, search_keyword, search_type) VALUES (?, ?, ?)',
    [req.user.id, query, 'all']);
  return sendSuccess(res, { records: rows.map(toRecord), total: rows.length });
}));

router.get('/:module', requireModuleAction('read'), asyncHandler(async (req, res, next) => {
  const module = req.params.module;
  if (module === 'auditLogs') {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const [rows] = await pool.query(
      `SELECT a.id, a.module_name, a.action, a.record_id, a.old_values, a.new_values, a.ip_address, a.created_at, u.full_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT ${limit}`,
    );
    const records = rows.map((row) => ({
      id: `LOG-${String(row.id).padStart(4, '0')}`, user: row.full_name || 'System',
      action: row.action, target: `${row.module_name}${row.record_id ? ` · ${row.record_id}` : ''}`,
      date: row.created_at, ip: row.ip_address || '', status: 'Success',
      module: row.module_name, oldValues: row.old_values, newValues: row.new_values,
    }));
    return sendSuccess(res, { records, total: records.length });
  }
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const [rows] = await pool.execute(
    'SELECT * FROM module_records WHERE module_key = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [module, limit, offset],
  );
  const [count] = await pool.execute(
    'SELECT COUNT(*) AS total FROM module_records WHERE module_key = ? AND deleted_at IS NULL',
    [module],
  );
  return sendSuccess(res, { records: rows.map(toRecord), total: count[0].total, limit, offset });
}));

router.get('/:module/:id', requireModuleAction('read'), asyncHandler(async (req, res, next) => {
  const { module, id } = req.params;
  if (module === 'auditLogs') throw new AppError(403, 'Audit entries cannot be retrieved by record ID.');
  const row = await findRecord(pool, module, id);
  if (!row) throw new AppError(404, 'Record not found.');
  return sendSuccess(res, toRecord(row));
}));

router.post('/:module', requireModuleAction('create'), param('module').isIn(Object.keys(prefixes)), body().isObject(), validateRequest,
  asyncHandler(async (req, res) => {
  const module = req.params.module;
  assertRecord(module, req.body);
  const record = await withTransaction((connection) => writeRecord(connection, {
    module, data: req.body, user: req.user, ip: req.ip, action: 'created',
  }));
  return sendSuccess(res, record, 'Record created successfully.', 201);
}));

router.put('/:module/:id', requireModuleAction('update'), param('module').isIn(Object.keys(prefixes)), param('id').isLength({ min: 1, max: 40 }),
  body().isObject(), validateRequest, asyncHandler(async (req, res) => {
    const { module, id } = req.params;
    if (noDeleteModules.has(module) || readOnlyModules.has(module)) throw new AppError(403, 'This record type cannot be changed.');
    assertRecord(module, req.body);
    const record = await withTransaction((connection) => writeRecord(connection, {
      module, id, data: req.body, user: req.user, ip: req.ip, action: 'updated',
    }));
    return sendSuccess(res, record, 'Record updated successfully.');
  }));

router.delete('/:module/:id', requireModuleAction('delete'), param('module').isIn(Object.keys(prefixes)), param('id').isLength({ min: 1, max: 40 }),
  validateRequest, asyncHandler(async (req, res) => {
    const { module, id } = req.params;
    if (noDeleteModules.has(module) || readOnlyModules.has(module)) throw new AppError(403, 'This record is retained for audit or clinical history.');
    await withTransaction(async (connection) => {
      const row = await findRecord(connection, module, id, true);
      if (!row) throw new AppError(404, 'Record not found.');
      if (module === 'rooms' && row.data.status === 'Occupied') throw new AppError(409, 'An occupied room cannot be deleted.');
      if (module === 'admissions' && row.data.status !== 'Discharged') throw new AppError(409, 'Discharge the patient before archiving this admission.');
      if (module === 'billing') {
        const [payments] = await connection.execute(
          `SELECT external_id FROM module_records WHERE module_key = 'payments' AND deleted_at IS NULL
           AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.invoice')) = ? LIMIT 1 FOR UPDATE`,
          [id],
        );
        if (payments.length) throw new AppError(409, 'Invoices with payment history cannot be archived.');
      }
      await connection.execute('UPDATE module_records SET deleted_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?', [req.user.id, row.id]);
      await writeAudit(connection, { userId: req.user.id, module, action: 'archived', recordId: id, oldValues: row.data, ip: req.ip });
    });
    return sendSuccess(res, { id }, 'Record archived successfully.');
  }));

export default router;
