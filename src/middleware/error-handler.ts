import type { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!err) return next();

  switch (err.message) {
    case 'no_capacity':
      return res.status(409).json({ error: 'no_capacity' });

    case 'not_found':
      return res.status(404).json({ error: 'not_found' });

    case 'invalid_input':
      return res.status(400).json({ error: 'invalid_input' });

    case 'outside_service_window':
      return res.status(422).json({ error: 'outside_service_window' });

    default:
      console.error('UNEXPECTED ERROR:', err);
      return res.status(500).json({ error: 'internal_error' });
  }
}
