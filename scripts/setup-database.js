import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = await fs.readFile(path.join(root, 'database', 'schema.sql'), 'utf8');
const appUser = process.env.DB_USER || 'carepoint_app';
const appHost = process.env.DB_APP_HOST || 'localhost';
const databaseName = process.env.DB_NAME || 'hospital_management';
const appPassword = process.env.DB_PASSWORD || '';
if (!/^[A-Za-z0-9_]+$/.test(appUser) || !/^[A-Za-z0-9_.-]+$/.test(appHost)
  || !/^[A-Za-z0-9_]+$/.test(databaseName) || appPassword.length < 16) {
  throw new Error('Set a valid DB_USER, DB_APP_HOST, DB_NAME, and a DB_PASSWORD of at least 16 characters.');
}
const connection = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_SETUP_USER || process.env.DB_USER || 'root',
  password: process.env.DB_SETUP_PASSWORD ?? process.env.DB_PASSWORD ?? '',
  multipleStatements: true,
});

try {
  await connection.query(schema);
  const escapedPassword = connection.escape(appPassword);
  await connection.query(`CREATE USER IF NOT EXISTS '${appUser}'@'${appHost}' IDENTIFIED BY ${escapedPassword}`);
  await connection.query(`ALTER USER '${appUser}'@'${appHost}' IDENTIFIED BY ${escapedPassword}`);
  await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${databaseName}\`.* TO '${appUser}'@'${appHost}'`);
  console.log('Database schema installed successfully.');
} finally {
  await connection.end();
}
