import { createClient } from '@openauthjs/openauth/client';
import { subjects, type UserSubject } from './subjects.js';

/**
 * Thin wrapper around OpenAuth's client.verify() that returns the user
 * subject (or null) and swallows the discriminated-union ceremony.
 *
 * The API service calls this per request in its auth middleware. The client
 * caches JWKS internally, so repeated calls are cheap.
 */

let cachedClient: ReturnType<typeof createClient> | null = null;

function client() {
  if (cachedClient) return cachedClient;
  const issuer = process.env.PUBLIC_AUTH_URL;
  if (!issuer) throw new Error('PUBLIC_AUTH_URL is not set');
  cachedClient = createClient({
    clientID: 'api',
    issuer,
  });
  return cachedClient;
}

export async function verifyAccessToken(
  token: string,
): Promise<UserSubject | null> {
  const result = await client().verify(subjects, token);
  if (result.err) return null;
  if (result.subject.type !== 'user') return null;
  return result.subject.properties;
}
