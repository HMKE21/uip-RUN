import { createHmac } from 'node:crypto';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// same construction as Full-API's SandboxApiController::signHs256 (base64url without padding)
export const tok = (claims, secret = 'x'.repeat(40)) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64(claims);
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
};
