/**
 * Small HTTP helpers shared by the panel API and the webhook route.
 *
 * The routes own their full response lifecycle (that is the `dsh-host-webserver`
 * contract), so these are plain `node:http` utilities rather than a framework.
 *
 * @module @ds-hu/dsh-auto-task-center/lib/http
 */

/** Largest JSON body the panel API accepts. */
export const MAX_JSON_BYTES = 64 * 1024;
/** Largest webhook payload accepted. */
export const MAX_HOOK_BYTES = 64 * 1024;

/** A request that cannot be answered as asked, with a status code. */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status to send.
   * @param {string} code - Stable machine code.
   * @param {string} message - Human-readable explanation.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Send a JSON response and end it.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {number} status - Status code.
 * @param {unknown} value - Body to serialize.
 * @returns {void}
 */
export function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Send an error envelope and end the response.
 * @param {import('node:http').ServerResponse} res - Response.
 * @param {number} status - Status code.
 * @param {string} code - Stable machine code.
 * @param {string} message - Human-readable explanation.
 * @returns {void}
 */
export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, error: message });
}

/**
 * Read a request body as UTF-8 text, refusing anything over the limit.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {number} limit - Largest accepted size in bytes.
 * @returns {Promise<string>} the body.
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new HttpError(413, 'payload-too-large', `request body must stay under ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/**
 * Read a request body and parse it as JSON.
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {number} [limit] - Largest accepted size in bytes.
 * @returns {Promise<unknown>} the parsed value.
 */
export async function readJson(req, limit = MAX_JSON_BYTES) {
  const text = await readBody(req, limit);
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON');
  }
}

/**
 * Enforce that a mutating request came from the Host's own origin.
 *
 * The routes are already reachable only on the Host's listen address, so this
 * is not a security boundary — it stops a page on another origin from driving
 * the API through a plain cross-origin form post, which would otherwise be
 * possible without CORS.
 *
 * @param {import('node:http').IncomingMessage} req - Request.
 * @param {string} origin - The Host origin, e.g. `http://127.0.0.1:3080`.
 * @returns {void}
 * @throws {HttpError} when the request announces a different origin or does not claim JSON.
 */
export function assertSameOriginJson(req, origin) {
  const announced = req.headers.origin;
  if (typeof announced === 'string' && announced !== '' && announced !== origin) {
    throw new HttpError(403, 'cross-origin', 'this API only accepts requests from the Host page');
  }
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'unsupported-media-type', 'send application/json');
  }
}
