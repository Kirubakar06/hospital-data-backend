import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../src/config/db.js';
import { writeAudit } from '../src/services/auditService.js';

const demoEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
const pad = (value) => String(value).padStart(4, '0');
const dateIn = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const tomorrow = dateIn(1);
const nextWeek = dateIn(7);
const modules = [
  ['departments', 'DEP', [
    { name: 'Cardiology', head: 'Dr. Avery Stone', location: 'North Wing · Floor 2', staff: 8, status: 'Active' },
    { name: 'Neurology', head: 'Dr. Jordan Lee', location: 'South Wing · Floor 3', staff: 6, status: 'Active' },
    { name: 'Laboratory', head: 'Morgan Reed', location: 'East Wing · Floor 1', staff: 5, status: 'Active' },
  ]],
  ['doctors', 'DR', [
    { name: 'Dr. Avery Stone', specialization: 'Cardiologist', department: 'Cardiology', phone: '+1-555-0101', email: 'avery.stone@example.test', experience: '12 years', qualification: 'MD', fee: 180, availability: 'Available' },
    { name: 'Dr. Jordan Lee', specialization: 'Neurologist', department: 'Neurology', phone: '+1-555-0102', email: 'jordan.lee@example.test', experience: '9 years', qualification: 'MD', fee: 160, availability: 'Available' },
  ]],
  ['patients', 'PT', [
    { name: 'Demo Patient One', age: 34, gender: 'Female', phone: '+1-555-0191', email: 'patient.one@example.test', city: 'Sample City', department: 'Cardiology', doctor: 'Dr. Avery Stone', status: 'Active', bloodGroup: 'O+', admissionType: 'OP', appointmentDate: tomorrow },
    { name: 'Demo Patient Two', age: 52, gender: 'Male', phone: '+1-555-0192', email: 'patient.two@example.test', city: 'Sample City', department: 'Neurology', doctor: 'Dr. Jordan Lee', status: 'Admitted', bloodGroup: 'A+', admissionType: 'IP', appointmentDate: nextWeek },
  ]],
  ['rooms', 'RM', [
    { room: '101', type: 'Private', department: 'Cardiology', floor: '2', rate: 450, status: 'Available' },
    { room: '102', type: 'General', department: 'Neurology', floor: '3', rate: 180, status: 'Occupied' },
  ]],
  ['appointments', 'AP', [
    { patient: 'Demo Patient One', doctor: 'Dr. Avery Stone', department: 'Cardiology', date: tomorrow, time: '10:30', type: 'Consultation', reason: 'Routine check-up', status: 'Confirmed' },
    { patient: 'Demo Patient Two', doctor: 'Dr. Jordan Lee', department: 'Neurology', date: nextWeek, time: '11:00', type: 'Follow-up', reason: 'Review visit', status: 'Scheduled' },
  ]],
  ['admissions', 'AD', [
    { patient: 'Demo Patient Two', room: '102', doctor: 'Dr. Jordan Lee', admitDate: dateIn(-1), expectedDischarge: nextWeek, diagnosis: 'Observation', status: 'Admitted' },
  ]],
  ['medicalRecords', 'MR', [
    { patient: 'Demo Patient One', doctor: 'Dr. Avery Stone', date: tomorrow, type: 'Consultation', diagnosis: 'Routine evaluation', notes: 'Synthetic demonstration record only.', status: 'Open' },
  ]],
  ['prescriptions', 'RX', [
    { patient: 'Demo Patient One', doctor: 'Dr. Avery Stone', medication: 'Demo medicine', dosage: '10 mg', frequency: 'Once daily', date: tomorrow, status: 'Active' },
  ]],
  ['laboratory', 'LB', [
    { patient: 'Demo Patient One', test: 'Sample blood panel', requestedBy: 'Dr. Avery Stone', date: tomorrow, priority: 'Routine', result: '', status: 'Pending' },
  ]],
  ['billing', 'BL', [
    { patient: 'Demo Patient One', date: dateIn(0), service: 'Sample consultation', amount: 180, paidAmount: 0, balanceAmount: 180, dueDate: nextWeek, status: 'Pending' },
    { patient: 'Demo Patient Two', date: dateIn(-1), service: 'Sample lab service', amount: 80, paidAmount: 80, balanceAmount: 0, dueDate: dateIn(-1), status: 'Paid' },
  ]],
  ['staff', 'ST', [
    { name: 'Taylor Morgan', role: 'Nurse', department: 'Cardiology', phone: '+1-555-0181', email: 'taylor.morgan@example.test', shift: 'Day', status: 'Active' },
    { name: 'Casey Rivers', role: 'Lab Technician', department: 'Laboratory', phone: '+1-555-0182', email: 'casey.rivers@example.test', shift: 'Evening', status: 'Active' },
  ]],
  ['settings', 'SET', [
    { setting: 'Hospital name', value: 'CarePoint Demo Hospital', category: 'General', updated: dateIn(0) },
    { setting: 'Timezone', value: 'UTC', category: 'Regional', updated: dateIn(0) },
  ]],
];

try {
  const [admins] = await pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [demoEmail || '']);
  if (!admins.length) throw new Error('Admin account not found. Run npm run seed:admin first.');
  await withTransaction(async (connection) => {
    const userId = admins[0].id;
    const created = [];
    for (const [module, prefix, records] of modules) {
      const [existing] = await connection.execute(
        'SELECT id FROM module_records WHERE module_key = ? LIMIT 1',
        [module],
      );
      if (existing.length) continue;
      for (const data of records) {
        const [result] = await connection.execute(
          `INSERT INTO module_records (module_key, external_id, data, status, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [module, `TMP-${randomUUID()}`, JSON.stringify(data), data.status || null, userId, userId],
        );
        const id = `${prefix}-${pad(result.insertId)}`;
        await connection.execute('UPDATE module_records SET external_id = ? WHERE id = ?', [id, result.insertId]);
        created.push({ module, id, data });
      }
    }

    const bill = created.find((record) => record.module === 'billing' && record.data.status === 'Paid');
    const [existingPayments] = await connection.execute(
      `SELECT id FROM module_records WHERE module_key = 'payments' LIMIT 1`,
    );
    if (bill && !existingPayments.length) {
      const [payment] = await connection.execute(
        `INSERT INTO module_records (module_key, external_id, data, status, created_by, updated_by)
         VALUES ('payments', ?, ?, 'Completed', ?, ?)`,
        [`TMP-${randomUUID()}`, JSON.stringify({
          invoice: bill.id, patient: bill.data.patient, date: bill.data.date,
          method: 'Cash', amount: bill.data.amount, status: 'Completed',
          transactionReference: 'DEMO-PAYMENT-001',
        }), userId, userId],
      );
      const paymentId = `PY-${pad(payment.insertId)}`;
      await connection.execute('UPDATE module_records SET external_id = ? WHERE id = ?', [paymentId, payment.insertId]);
      created.push({ module: 'payments', id: paymentId });
    }
    if (created.length) {
      await writeAudit(connection, {
        userId, module: 'demo', action: 'synthetic_data_seeded',
        recordId: String(created.length), newValues: { recordsCreated: created.length }, ip: '127.0.0.1',
      });
    }
    console.log(`Seeded ${created.length} synthetic demo records. Existing module records were left unchanged.`);
  });
} finally {
  await pool.end();
}
