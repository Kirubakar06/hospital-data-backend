export async function writeAudit(connection, { userId, module, action, recordId, oldValues, newValues, ip }) {
  await connection.execute(
    `INSERT INTO audit_logs (user_id, module_name, action, record_id, old_values, new_values, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId || null, module, action, recordId || null, oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null, ip || null],
  );
}
