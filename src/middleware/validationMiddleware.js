import { validationResult } from 'express-validator';
import { AppError } from '../utils/errors.js';

export function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (!result.isEmpty()) {
    return next(new AppError(422, 'Validation failed.', result.array().map(({ path, msg }) => ({ field: path, message: msg }))));
  }
  return next();
}
