// Express 4 does not catch a rejected promise from a route handler, and Node
// 22 treats an unhandled rejection as an uncaught exception: the process
// exits. One throw inside any `async` route — a failed DB insert, an SMTP
// hiccup before its try — took the whole client site down until the host
// restarted it. This was seen in practice: a malformed stored B2B discount
// made POST /api/reservations throw, and checkout killed the server.
//
// Every route handler that returns a promise goes through asyncHandler, which
// hands the rejection to next(err) like Express already does for a sync
// throw. src/build/async-routes.test.js fails if an unwrapped one appears.
export function asyncHandler(fn) {
  return function asyncHandlerWrapper(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Final error handler (mounted last in src/server.js). JSON, because every
// route that can reach it is an /api one, and the panel and cart read
// `error` from the body. A 4xx keeps its status — body-parser reports a
// malformed or oversized body this way — but no internal message is ever
// sent: it can name tables, paths or a third party's response.
// eslint-disable-next-line no-unused-vars
export function apiErrorHandler(err, req, res, next) {
  const status = Number(err?.status || err?.statusCode) || 500;
  const clientError = status >= 400 && status < 500;
  if (!clientError) console.error(`${req.method} ${req.originalUrl}:`, err);
  // Too late for a status line: Express's own handler closes the connection.
  if (res.headersSent) return next(err);
  res
    .status(clientError ? status : 500)
    .json({ error: clientError ? "Petición no válida" : "Error interno del servidor" });
}
