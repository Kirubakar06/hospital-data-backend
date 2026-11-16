export class AppError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function sendSuccess(res, data, message = 'Request completed successfully', status = 200) {
  return res.status(status).json({ success: true, message, data });
}
