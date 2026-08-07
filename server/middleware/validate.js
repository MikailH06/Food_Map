/**
 * Request validation.
 *
 * Wraps zod schemas so a route can declare the shape it expects and receive
 * parsed, typed data — or a 400 listing exactly which fields were wrong.
 * Validating at the edge means route handlers never defend against malformed
 * input themselves.
 */

import { badRequest } from './errors.js';

/**
 * Build middleware that validates part of the request and REPLACES it with the
 * parsed result, so downstream code sees coerced types (numbers as numbers)
 * and no unexpected extra keys.
 *
 * @param {'body'|'query'|'params'} source
 * @param {import('zod').ZodTypeAny} schema
 */
export function validate(source, schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const fields = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || source;
        // Keep the first problem per field — a list of five complaints about
        // one field is noise, not help.
        if (!fields[path]) fields[path] = issue.message;
      }
      return next(badRequest('Some values were not valid', { fields }));
    }

    // Express 5 makes req.query a getter, so it cannot be assigned. Stash the
    // parsed values where handlers can reach them instead.
    if (source === 'query') {
      req.validatedQuery = result.data;
    } else {
      req[source] = result.data;
    }
    next();
  };
}

export const validateBody = (schema) => validate('body', schema);
export const validateQuery = (schema) => validate('query', schema);
export const validateParams = (schema) => validate('params', schema);
