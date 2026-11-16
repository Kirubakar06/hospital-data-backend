import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPermission } from '../../shared/permissions.js';
import { navigationForRole, sidebarNavigationForRole } from '../../src/data/modules.js';
import { authorize } from '../src/middleware/roleMiddleware.js';

test('role permissions allow only explicitly granted module actions', () => {
  assert.equal(hasPermission('Receptionist', 'patients', 'create'), true);
  assert.equal(hasPermission('Receptionist', 'billing', 'read'), false);
  assert.equal(hasPermission('Accountant', 'billing', 'create'), true);
  assert.equal(hasPermission('Accountant', 'patients', 'read'), false);
  assert.equal(hasPermission('Unknown role', 'patients', 'read'), false);
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

test('navigation hides modules unavailable to the signed-in role', () => {
  const receptionistLinks = navigationForRole('Receptionist').flatMap((group) => group.items.map((item) => item.label));
  assert.deepEqual(receptionistLinks, ['Dashboard', 'Patients', 'Doctors', 'Departments', 'Appointments', 'Rooms']);
  assert.equal(navigationForRole('Accountant').flatMap((group) => group.items).some((item) => item.label === 'Patients'), false);
});

test('sidebar shows all modules while locking items unavailable to the signed-in role', () => {
  const receptionistItems = sidebarNavigationForRole('Receptionist').flatMap((group) => group.items);
  const itemByLabel = Object.fromEntries(receptionistItems.map((item) => [item.label, item]));

  assert.equal(itemByLabel.Patients.allowed, true);
  assert.equal(itemByLabel.Admissions.allowed, false);
  assert.equal(itemByLabel['Medical Records'].allowed, false);
  assert.equal(itemByLabel.Prescriptions.allowed, false);
  assert.equal(itemByLabel.Laboratory.allowed, false);
  assert.equal(itemByLabel.Billing.allowed, false);
  assert.ok(receptionistItems.some((item) => item.label === 'Audit Logs'));
});
