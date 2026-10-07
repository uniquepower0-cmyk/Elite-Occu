import { Request, Response, NextFunction } from 'express';

/**
 * Async handler wrapper to catch unhandled Promise rejections
 * and route them to Express error handling middleware.
 */
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
