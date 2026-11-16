import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

process.env.DB_HOST = '127.0.0.1';
process.env.DB_USER = 'test';
process.env.DB_NAME = 'hospital_management';
process.env.JWT_SECRET = 'test-access-secret-must-be-at-least-32-characters';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-must-be-at-least-32-characters';

const { app } = await import('../src/app.js');

test('health endpoint responds without exposing database configuration', async () => {
  const response = await request(app).get('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { success: true, data: { status: 'ok' } });
});

test('unknown routes use the standard JSON error shape', async () => {
  const response = await request(app).get('/api/v1/no-such-route');
  assert.equal(response.status, 404);
  assert.equal(response.body.success, false);
  assert.match(response.body.message, /Route not found/);
});

test('patient records require authentication', async () => {
  const response = await request(app).get('/api/v1/patients');
  assert.equal(response.status, 401);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Authentication is required.');
});

test('public registration validates email and password before database access', async () => {
  const response = await request(app).post('/api/v1/auth/register').send({
    name: 'Demo Signup',
    email: 'not-an-email',
    password: 'short',
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.success, false);
  assert.equal(response.body.message, 'Validation failed.');
});

test('production server serves the frontend application entry point', {
  skip: !existsSync(fileURLToPath(new URL('../../hospital%20management%20sample/dist/index.html', import.meta.url))),
}, async () => {
  const response = await request(app).get('/patients');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /CarePoint/);
});
