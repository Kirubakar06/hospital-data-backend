import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

const accepted = new Map([
  ['application/pdf', '.pdf'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
]);

const destination = path.resolve(env.uploadDir);
fs.mkdirSync(destination, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination,
    filename: (req, file, done) => done(null, `${randomUUID()}${accepted.get(file.mimetype) || '.bin'}`),
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, done) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!accepted.has(file.mimetype) || accepted.get(file.mimetype) !== ext) {
      return done(new AppError(422, 'Only matching PDF, JPEG, or PNG files are accepted.'));
    }
    return done(null, true);
  },
});
