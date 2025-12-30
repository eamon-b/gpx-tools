/**
 * Shared CORS utility for API handlers.
 *
 * Configure allowed origins via environment variables:
 *   - ALLOWED_ORIGINS: Comma-separated list of allowed origins
 *   - VERCEL_URL: Automatically set by Vercel, used as fallback
 *
 * In development (NODE_ENV !== 'production'), localhost origins are always allowed.
 */

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';

  // Build list of allowed origins
  const allowedOrigins: string[] = [];

  // Add configured origins from environment variable
  const configuredOrigins = process.env.ALLOWED_ORIGINS;
  if (configuredOrigins) {
    allowedOrigins.push(
      ...configuredOrigins.split(',').map(o => o.trim()).filter(Boolean)
    );
  }

  // Add Vercel URL if available (automatic preview/production URL)
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    allowedOrigins.push(`https://${vercelUrl}`);
  }

  // Add production URL if set
  const productionUrl = process.env.PRODUCTION_URL;
  if (productionUrl) {
    allowedOrigins.push(productionUrl);
  }

  // Allow localhost in development
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push(
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173'
    );
  }

  // Check if origin is allowed (must be explicitly in the list)
  const isAllowed = allowedOrigins.length > 0 && allowedOrigins.includes(origin);

  // If origin not allowed, deny access (empty string = no CORS header sent)
  // This prevents unauthorized cross-origin requests in production
  const allowOrigin = isAllowed ? origin : '';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * Handle CORS preflight request.
 */
export function handleCorsPreflightRequest(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(req),
    });
  }
  return null;
}
