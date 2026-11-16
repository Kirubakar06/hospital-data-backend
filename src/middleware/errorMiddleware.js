import { AppError } from '../utils/errors.js';

export function notFound(req, res) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const status = error instanceof AppError ? error.status
    : error.code === 'ER_DUP_ENTRY' ? 409
      : error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  const message = error instanceof AppError
    ? error.message
    : error.code === 'ER_DUP_ENTRY'
      ? 'A record with the same unique value already exists.'
      : error.code === 'LIMIT_FILE_SIZE'
        ? 'Uploaded file exceeds the configured size limit.'
        : 'An unexpected server error occurred.';

  if (status >= 500) console.error(error);
  return res.status(status).json({
    success: false,
    message,
    ...(error instanceof AppError && error.errors ? { errors: error.errors } : {}),
  });
}
