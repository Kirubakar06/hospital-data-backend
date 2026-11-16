import express from 'express';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import authRoutes from './routes/authRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import recordRoutes from './routes/recordRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import userRoutes from './routes/userRoutes.js';
import { upload } from './middleware/uploadMiddleware.js';
import { authenticate } from './middleware/authMiddleware.js';
import { authorize } from './middleware/roleMiddleware.js';
import { asyncHandler, sendSuccess } from './utils/errors.js';
import { AppError } from './utils/errors.js';
import { notFound, errorHandler } from './middleware/errorMiddleware.js';
import { withTransaction } from './config/db.js';
import { writeAudit } from './services/auditService.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.clientUrl.split(',').map((url) => url.trim()), credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

const apiLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
app.get('/health', (req, res) => res.status(200).json({ success: true, data: { status: 'ok' } }));
app.use('/api/v1', apiLimit);
app.use('/api/v1/auth', authLimit, authRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1', userRoutes);
app.post('/api/v1/uploads', authenticate, authorize('medicalRecords', 'update'), upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(422).json({ success: false, message: 'A valid file is required.' });
    const bytes = await fs.readFile(req.file.path);
    const validSignature = req.file.mimetype === 'application/pdf'
      ? bytes.subarray(0, 5).toString() === '%PDF-'
      : req.file.mimetype === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!validSignature) {
      await fs.unlink(req.file.path);
      throw new AppError(422, 'File contents do not match the permitted file type.');
    }
    await withTransaction((connection) => writeAudit(connection, {
      userId: req.user.id, module: 'uploads', action: 'uploaded', recordId: req.file.filename, ip: req.ip,
    }));
    return sendSuccess(res, { filename: req.file.filename, size: req.file.size, mimeType: req.file.mimetype },
      'File uploaded successfully.', 201);
  }));
app.get('/api/v1/uploads/:filename', authenticate, authorize('medicalRecords', 'read'), asyncHandler(async (req, res) => {
  if (!/^[0-9a-f-]{36}\.(pdf|jpg|png)$/.test(req.params.filename)) throw new AppError(404, 'File not found.');
  const filePath = path.resolve(env.uploadDir, req.params.filename);
  try {
    await fs.access(filePath);
  } catch {
    throw new AppError(404, 'File not found.');
  }
  return res.sendFile(filePath, { headers: { 'Content-Disposition': 'inline' } });
}));
app.use('/api/v1', recordRoutes);
const frontendDist = path.resolve(process.env.FRONTEND_DIST_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hospital management sample', 'dist'));
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(frontendDist, 'index.html'), (error) => error && next(error));
  });
}
app.use(notFound);
app.use(errorHandler);
