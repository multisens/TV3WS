import { randomBytes } from 'crypto';

const TOKEN_BYTES = 32;

// Returns a random token of 256 bits, encoded in base64url (safe in a URL
// path without encoding)
export function generateToken(): string {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}
