import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPermission } from '../shared/permissions.js';
import { authorize } from '../src/middleware/roleMiddleware.js';

test('role permissions allow only explicitly granted module actions', () => {
  assert.equal(hasPermission('Receptionist', 'patients', 'create'), true);
  assert.equal(hasPermission('Receptionist', 'billing', 'read'), false);
  assert.equal(hasPermission('Accountant', 'billing', 'create'), true);
  assert.equal(hasPermission('Accountant', 'patients', 'read'), false);
  assert.equal(hasPermission('Unknown role', 'patients', 'read'), false);
});

test('administration data stays restricted to Admin and Super Admin roles', () => {
  for (const module of ['billing', 'payments', 'staff', 'reports', 'users', 'settings', 'auditLogs']) {
    assert.equal(hasPermission('Admin', module, 'read'), true);
    assert.equal(hasPermission('Super Admin', module, 'read'), true);
    assert.equal(hasPermission('Receptionist', module, 'read'), false);
  }
});

test('API authorization middleware enforces the shared role permissions', () => {
  let allowed = false;
  authorize('patients', 'read')({ user: { role: 'Receptionist' } }, {}, (error) => {
    assert.equal(error, undefined);
    allowed = true;
  });
  assert.equal(allowed, true);

  let denied;
  authorize('billing', 'read')({ user: { role: 'Receptionist' } }, {}, (error) => { denied = error; });
  assert.equal(denied?.status, 403);
});
