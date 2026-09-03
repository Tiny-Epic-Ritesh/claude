/**
 * Make a rejected promise reach Express.
 *
 * Express 4 hands a synchronous throw to the error middleware but knows nothing
 * about promises: an async handler that rejects returns to nobody, and Node's
 * answer to an unhandled rejection is to end the process. That is not a
 * hypothetical. A sign-in with no email in the body threw inside `login()`,
 * which had recently become async, and one unauthenticated request stopped the
 * server for everybody.
 *
 * So every async handler is registered through this. It is a plain function
 * rather than an async one, which is also how the guard test tells a wrapped
 * handler from an unwrapped one: anything still registered as an AsyncFunction
 * has been missed.
 *
 * Express 5 does this itself. Whenever this codebase moves to it, `wrap` can be
 * deleted and the calls unwound.
 */
export const wrap = (fn) => function wrapped(req, res, next) {
  Promise.resolve(fn(req, res, next)).catch(next);
};
