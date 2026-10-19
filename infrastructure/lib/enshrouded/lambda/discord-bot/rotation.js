// Password rotation in the start path (ARCHITECTURE §7.4.3) and the SecureString reads
// behind /enshrouded pw (§7.4.4).
//
// Deliberately NOT here: any distributed lock, any rollback, any transaction. A partial
// rotation and a rotation-without-start are both safe states (§7.4.3). Also never here:
// labels or policies on the four parameters (§7.4.5, the 100-version trap), and any digest of
// a password (invariant §1.14).

const PARAM_ROOT = '/enshroudedproj';
// Hardcoded constant map: parameter names are never built from request data (§7.4.3 step 4).
const PASSWORD_PARAMS = Object.freeze({
  admin: `${PARAM_ROOT}/server/user-groups/admin-password`,
  friend: `${PARAM_ROOT}/server/user-groups/friend-password`,
  guest: `${PARAM_ROOT}/server/user-groups/guest-password`,
  visitor: `${PARAM_ROOT}/server/user-groups/visitor-password`,
});
const ROTATE_ON_START_PARAM = `${PARAM_ROOT}/state/rotate-on-start`;
const DESYNC_PARAM = `${PARAM_ROOT}/state/password-desync`;
// Interlock (b): max age of the DescribeInstances observation at the first PutParameter.
const FRESHNESS_BOUND_MS = 5000;

let ssmClient = null;
function ssm() {
  if (!ssmClient) {
    const { SSMClient } = require('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

const monotonicMs = () => performance.now();

/** Value of a parameter, or undefined when it does not exist. Other errors propagate. */
async function readParameter(Name, WithDecryption = false) {
  const { GetParameterCommand } = require('@aws-sdk/client-ssm');
  try {
    return (await ssm().send(new GetParameterCommand({ Name, WithDecryption }))).Parameter?.Value;
  } catch (error) {
    if (error?.name === 'ParameterNotFound') return undefined;
    throw error;
  }
}

/** Kill switch. Anything other than the exact string "true" - absent, malformed, unreadable -
 * means do not rotate (§7.4.6: rotation before WP-25 can brick every boot). */
async function rotationEnabled() {
  try {
    return (await readParameter(ROTATE_ON_START_PARAM)) === 'true';
  } catch {
    return false;
  }
}

async function putDesync(value) {
  const { PutParameterCommand } = require('@aws-sdk/client-ssm');
  await ssm().send(new PutParameterCommand({ Name: DESYNC_PARAM, Type: 'String', Overwrite: true, Value: value }));
}

/** CloudWatch EMF: one log line, no PutMetricData permission. Carries no password data. */
function emitMetric(name) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: 'Enshrouded', Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] }],
    },
    [name]: 1,
  }));
}

/**
 * Interlocks (a) and (b). The caller has already established, from a DescribeInstances
 * response observed at `observedAt` (monotonic ms), that the instance state is `stopped`.
 * Generates and writes the four values. Returns 'rotated' or 'stale' (nothing written).
 * Throws on a write failure: the caller must then NOT call StartInstances. No rollback.
 */
async function rotatePasswords(observedAt, { now = monotonicMs } = {}) {
  const { generatePasswords } = require('./password-generator');
  // Freshness first: the stale path must never generate secrets it will discard.
  if (now() - observedAt > FRESHNESS_BOUND_MS) return 'stale';
  const generated = generatePasswords();
  const { PutParameterCommand } = require('@aws-sdk/client-ssm');
  for (const group of Object.keys(PASSWORD_PARAMS)) {
    // No KeyId (default key, §6.6.5), no Tier (standard), no labels, no policies.
    await ssm().send(new PutParameterCommand({
      Name: PASSWORD_PARAMS[group], Type: 'SecureString', Overwrite: true, Value: generated[group],
    }));
  }
  return 'rotated';
}

/** Interlock (c): record that we rotated into a boot we did not start. */
async function recordDesync(previousState) {
  emitMetric('PasswordDesync');
  console.error('Password desync detected: start response PreviousState was not stopped');
  await putDesync(JSON.stringify({ detectedAt: new Date().toISOString(), previousState: previousState ?? 'unknown' }));
}

/** A start that began from `stopped` renders from SSM afresh, so any earlier desync is over. */
async function clearDesyncIfSet() {
  const current = await readParameter(DESYNC_PARAM);
  if (current !== undefined && current !== 'none') await putDesync('none');
}

/** True when pw must refuse on a running server. Absent or 'none' is clear; unreadable is not. */
async function desyncActive() {
  try {
    const value = await readParameter(DESYNC_PARAM);
    return value !== undefined && value !== 'none';
  } catch {
    return true;
  }
}

/** The live SSM values for exactly the requested groups (never from an event payload). */
async function readPasswords(groups) {
  const values = await Promise.all(groups.map((group) => {
    if (!Object.hasOwn(PASSWORD_PARAMS, group)) throw new Error('unknown-group');
    return readParameter(PASSWORD_PARAMS[group], true);
  }));
  return Object.fromEntries(groups.map((group, i) => [group, values[i]]));
}

module.exports = {
  PASSWORD_PARAMS, ROTATE_ON_START_PARAM, DESYNC_PARAM, FRESHNESS_BOUND_MS,
  rotationEnabled, rotatePasswords, emitMetric, recordDesync, clearDesyncIfSet, desyncActive, readPasswords, readParameter,
};
