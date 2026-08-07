/**
 * Error handling.
 *
 * Routes throw AppError (or let an unexpected error escape) and this module
 * turns it into a consistent JSON response. Express 5 forwards rejected
 * promises to the error handler automatically, so route handlers can be plain
 * `async` functions with no try/catch wrapper.
 */

/**
 * An error with an intended HTTP status. Anything thrown that is NOT an
 * AppError is treated as a bug: logged in full, reported to the client as a
 * generic 500 so internals never leak.
 */
export class AppError extends Error {
  /**
   * @param {number} status  HTTP status code
   * @param {string} message Safe to show the user
   * @param {object} [details] Extra machine-readable context (e.g. field errors)
   */
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
    this.expected = true;
  }
}

export const badRequest = (msg, details) => new AppError(400, msg, details);
export const unauthorized = (msg = 'Sign in to continue') => new AppError(401, msg);
export const forbidden = (msg = 'You do not have access to that') => new AppError(403, msg);
export const notFound = (msg = 'Not found') => new AppError(404, msg);
export const conflict = (msg, details) => new AppError(409, msg, details);
export const tooLarge = (msg) => new AppError(413, msg);
export const upstreamFailed = (msg = 'An upstream service failed') => new AppError(502, msg);

/** Catch-all for unmatched routes. Mounted after every real route. */
export function notFoundHandler(req, res, next) {
  next(new AppError(404, `No route matches ${req.method} ${req.path}`));
}

/**
 * Final error handler. Must keep all four parameters — Express identifies
 * error handlers by arity, and dropping `next` silently disables it.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.expected ? err.status : 500;

  if (!err.expected) {
    // A genuine bug. Log everything we have.
    console.error(`[error] ${req.method} ${req.path}`, err);
  } else if (status >= 500) {
    console.error(`[error] ${req.method} ${req.path} -> ${status}: ${err.message}`);
  }

  const body = {
    error: {
      message: err.expected ? err.message : 'Something went wrong on our end',
      status,
    },
  };

  if (err.expected && err.details !== undefined) {
    body.error.details = err.details;
  }

  // Stack traces are useful locally and a liability in production.
  if (!err.expected && process.env.NODE_ENV !== 'production') {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
}
