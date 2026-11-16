import { AppError } from '../utils/errors.js';
import { hasPermission } from '../../shared/permissions.js';

export function authorize(module, action) {
  return (req, res, next) => {
    if (hasPermission(req.user?.role, module, action)) return next();
    return next(new AppError(403, 'You do not have permission to perform this action.'));
  };
}
