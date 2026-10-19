// idle-shutdown (WP-10, ARCHITECTURE 3.2 / 5.5 / 5.6). Runs every minute.
//
// This Lambda DECIDES; it never stops anything itself. It has no ec2:StopInstances
// permission. Every stop goes through graceful-stop so save verification cannot be bypassed.
//
// last-active is a CONTROL variable (ARCHITECTURE 6.6.0): written on five triggers, only one of which is
// activity, and read ONLY by this Lambda's own idle test. last-player-seen is the FACT.
//
// Race fixes ported from the UOPrivateServer reference (all hard-won, do not simplify):
//   1. maintenance-mode gate runs FIRST - a deploy must never be killed mid-flight
//   2. not `running` -> reset the idle clock (a fresh boot must not inherit a stale one)
//   3. LaunchTime grace (> idle threshold) - EC2 writes LaunchTime atomically, so it cannot
//      be raced by a fast stop/start cycle the way our own parameter can

// AWS SDK v3 ships in the Node 22 Lambda runtime. Clients are created lazily so unit tests
// can mock them.
let clients = null;
function sdk() {
  if (!clients) {
    const ec2 = require('@aws-sdk/client-ec2');
    const ssm = require('@aws-sdk/client-ssm');
    const lambda = require('@aws-sdk/client-lambda');
    clients = {
      ec2: new ec2.EC2Client({}),
      ssm: new ssm.SSMClient({}),
      lambda: new lambda.LambdaClient({}),
      DescribeInstancesCommand: ec2.DescribeInstancesCommand,
      SendCommandCommand: ssm.SendCommandCommand,
      GetCommandInvocationCommand: ssm.GetCommandInvocationCommand,
      GetParameterCommand: ssm.GetParameterCommand,
      PutParameterCommand: ssm.PutParameterCommand,
      InvokeCommand: lambda.InvokeCommand,
    };
  }
  return clients;
}

// 5.6 thresholds. BOTH ARE n=1 CALIBRATIONS (one player, one sample per state). Raw values
// are emitted as metrics on every check so they can be retuned from real data.
const UDP_RATE_THRESHOLD = 10; // datagrams/sec; measured idle 0.55, one player ~211
const CPU_RATE_THRESHOLD = 0.6; // cores; measured idle 0.283, one player 1.36 (only ~2.1x - tight)

const ACTIVE = 'ACTIVE';
const IDLE = 'IDLE';
const INDETERMINATE = 'INDETERMINATE';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Normalise one probe line. A missing / mistyped field means that signal is UNAVAILABLE.
 * It is never coerced to zero (zero is the dangerous direction: it means "nobody here").
 */
function normalizeProbe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const players = num(raw.players);
  const mCount = num(raw.mCount);
  return {
    a2sOk: raw.a2sOk === true && players !== null && players >= 0,
    players,
    logOk: raw.logOk === true && mCount !== null && mCount >= 0,
    mCount,
    udpRate: num(raw.udpRate),
    cpuRate: num(raw.cpuRate),
  };
}

/**
 * ARCHITECTURE 5.6, verbatim. `probe` is the output of normalizeProbe, or null (probe failed).
 *
 *   ACTIVE  if (a2sOk and players > 0) or (logOk and mCount > 0)
 *           or udpRate >= UDP_RATE_THRESHOLD or cpuRate >= CPU_RATE_THRESHOLD
 *   IDLE    if an EXACT signal affirmatively reports zero and udpRate < T and cpuRate < T
 *   INDETERMINATE otherwise
 *
 * An unavailable heuristic cannot "agree" it is quiet, so it blocks IDLE. CPU can only ever
 * push toward ACTIVE: an AFK player generates little simulation load but keeps sending UDP.
 */
function classify(probe) {
  if (!probe) return INDETERMINATE;
  const { a2sOk, players, logOk, mCount, udpRate, cpuRate } = probe;

  if (
    (a2sOk && players > 0) ||
    (logOk && mCount > 0) ||
    (udpRate !== null && udpRate >= UDP_RATE_THRESHOLD) ||
    (cpuRate !== null && cpuRate >= CPU_RATE_THRESHOLD)
  ) {
    return ACTIVE;
  }

  const exactZero = (a2sOk && players === 0) || (logOk && mCount === 0);
  const udpQuiet = udpRate !== null && udpRate < UDP_RATE_THRESHOLD;
  const cpuQuiet = cpuRate !== null && cpuRate < CPU_RATE_THRESHOLD;
  if (exactZero && udpQuiet && cpuQuiet) return IDLE;

  return INDETERMINATE;
}

/** Signals disagree: ACTIVE although an exact signal says zero, or the two exact signals differ. */
function hasDisagreement(probe, classification) {
  if (!probe) return false;
  const a2sZero = probe.a2sOk && probe.players === 0;
  const logZero = probe.logOk && probe.mCount === 0;
  if (classification === ACTIVE && (a2sZero || logZero)) return true;
  return probe.a2sOk && probe.logOk && probe.players > 0 !== probe.mCount > 0;
}

// CloudWatch Embedded Metric Format: one log line, no PutMetricData permission needed.
function emitMetrics(metrics) {
  const entries = Object.entries(metrics).filter(([, v]) => typeof v === 'number' && Number.isFinite(v));
  if (entries.length === 0) return;
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        { Namespace: 'Enshrouded', Dimensions: [[]], Metrics: entries.map(([Name]) => ({ Name })) },
      ],
    },
  };
  for (const [name, value] of entries) line[name] = value;
  console.log(JSON.stringify(line));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cfg() {
  return {
    instanceId: process.env.INSTANCE_ID,
    stopFunction: process.env.STOP_FUNCTION_ARN,
    idleMinutes: Number(process.env.IDLE_MINUTES ?? '10'),
    graceMinutes: Number(process.env.LAUNCH_GRACE_MINUTES ?? '15'),
    maxUptimeHours: Number(process.env.MAX_UPTIME_HOURS ?? '12'),
    lastActiveParam: process.env.LAST_ACTIVE_PARAM,
    maintenanceParam: process.env.MAINTENANCE_MODE_PARAM,
    runStateParam: process.env.RUN_STATE_PARAM,
    lastPlayerSeenParam: process.env.LAST_PLAYER_SEEN_PARAM ?? '/enshroudedproj/state/last-player-seen',
    probeCommand: process.env.PROBE_COMMAND ?? 'python3 /usr/local/lib/enshrouded/probe-players.py',
    pollMs: Number(process.env.POLL_INTERVAL_MS ?? '2000'),
    pollAttempts: Number(process.env.POLL_ATTEMPTS ?? '25'),
  };
}

async function getParam(name) {
  const s = sdk();
  try {
    const res = await s.ssm.send(new s.GetParameterCommand({ Name: name }));
    return res.Parameter?.Value;
  } catch (err) {
    if (err && err.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

async function putParam(name, value) {
  const s = sdk();
  await s.ssm.send(new s.PutParameterCommand({ Name: name, Value: String(value), Type: 'String', Overwrite: true }));
}

/** Runs the on-box probe over SSM. Returns the normalised probe, or null on ANY failure. */
async function runProbe(c) {
  const s = sdk();
  try {
    const send = await s.ssm.send(
      new s.SendCommandCommand({
        InstanceIds: [c.instanceId],
        DocumentName: 'AWS-RunShellScript',
        Parameters: { commands: [c.probeCommand] },
        TimeoutSeconds: 30,
      }),
    );
    const commandId = send.Command.CommandId;
    for (let attempt = 0; attempt < c.pollAttempts; attempt++) {
      await sleep(c.pollMs);
      let inv;
      try {
        inv = await s.ssm.send(new s.GetCommandInvocationCommand({ CommandId: commandId, InstanceId: c.instanceId }));
      } catch (err) {
        if (err && err.name === 'InvocationDoesNotExist') continue;
        throw err;
      }
      if (inv.Status === 'Success') {
        const lines = String(inv.StandardOutputContent ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) return null;
        return normalizeProbe(JSON.parse(lines[lines.length - 1]));
      }
      if (['Failed', 'Cancelled', 'TimedOut'].includes(inv.Status)) {
        console.log(`Probe SSM command ${inv.Status}.`);
        return null;
      }
    }
    console.log('Timed out waiting for probe SSM command.');
    return null;
  } catch (err) {
    console.log(`Probe failed: ${err && err.name}: ${err && err.message}`);
    return null;
  }
}

/**
 * True only on an EXACT, affirmative detection: the A2S player count or the log's m# count.
 * udpRate / cpuRate are heuristics (a port scan or background load trips them) and must NEVER
 * count here: a false "seen" makes graceful-stop FAIL an empty-world stop and wedge the server.
 */
function exactPlayerDetected(probe) {
  if (!probe) return false;
  return (probe.a2sOk && probe.players > 0) || (probe.logOk && probe.mCount > 0);
}

/**
 * Record the FACT "an exact signal saw a player at wall-clock time `nowMs`" (ARCHITECTURE 6.6.0).
 * graceful-stop reads it: "a player connected this boot" is lastPlayerSeen >= LaunchTime, and the
 * disconnect-save check compares save mtimes against it. Called ONLY when exactPlayerDetected() is true,
 * so it is never written from a heuristic, a reset, a grace period or an INDETERMINATE tick.
 * NEVER cleared anywhere: wall-clock time is monotonic across boots and LaunchTime advances, so a stale
 * value is necessarily older than the new LaunchTime and fails the comparison (no race, nothing to clear).
 * Best-effort: a failure is logged and retried on the next 1-minute tick while the player is present.
 */
async function recordPlayerSeen(c, nowMs) {
  try {
    await putParam(c.lastPlayerSeenParam, nowMs);
    console.log(`Player affirmatively seen; ${c.lastPlayerSeenParam}=${nowMs}.`);
  } catch (err) {
    console.log(`Could not record last-player-seen: ${err && err.name}: ${err && err.message}`);
  }
}

/** Hands off to graceful-stop (async). The ONLY way this Lambda ever stops the instance. */
async function requestStop(c, why) {
  const s = sdk();
  const current = await getParam(c.runStateParam);
  if (current === 'stopping') {
    console.log('run-state is already "stopping"; a drain is in flight.');
    return 'stop-in-flight';
  }
  await putParam(c.runStateParam, 'stopping');
  try {
    await s.lambda.send(
      new s.InvokeCommand({
        FunctionName: c.stopFunction,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({ reason: 'idle' })),
      }),
    );
  } catch (err) {
    // Do not leave run-state wedged on "stopping" with no drain running.
    await putParam(c.runStateParam, current || 'running');
    throw err;
  }
  console.log(`Invoked graceful-stop (${why}).`);
  return 'stop-requested';
}

exports.handler = async () => {
  const c = cfg();
  const s = sdk();

  // Gate 1: maintenance mode. Nothing else runs.
  if ((await getParam(c.maintenanceParam)) === 'true') {
    console.log('Maintenance mode active, skipping idle check entirely.');
    return { action: 'maintenance' };
  }

  const describe = await s.ec2.send(new s.DescribeInstancesCommand({ InstanceIds: [c.instanceId] }));
  const instance = describe.Reservations?.[0]?.Instances?.[0];
  const state = instance?.State?.Name;
  const now = Date.now();

  // Gate 2: not running -> reset the clock.
  if (state !== 'running') {
    await putParam(c.lastActiveParam, now);
    console.log(`Instance state is "${state}", reset idle clock.`);
    return { action: 'not-running' };
  }

  // Gate 3: LaunchTime grace (must exceed the idle threshold). Grace means "cannot STOP yet"; it must
  // never mean "cannot OBSERVE yet". Players join right after /enshrouded start, so the grace window
  // overlaps almost exactly with when sessions begin: returning before the probe left last-player-seen
  // unwritten for a real session that happened entirely inside grace (observed live), disabling the
  // save-verification gate's input. So grace probes and records the FACT, and differs from the
  // post-grace path ONLY in that it returns before the idle decision (ARCHITECTURE 3.2 step 4).
  const launchMs = new Date(instance.LaunchTime).getTime();
  const minutesSinceLaunch = (now - launchMs) / 60000;
  // `!(x >= y)` also catches a missing/invalid LaunchTime (NaN): fail toward staying up.
  const inGrace = !(minutesSinceLaunch >= c.graceMinutes);

  // Measure + classify (5.6).
  const probe = await runProbe(c);
  const classification = classify(probe);
  console.log(`Probe ${JSON.stringify(probe)} -> ${classification}`);

  if (exactPlayerDetected(probe)) await recordPlayerSeen(c, now);

  emitMetrics({
    Players: probe?.a2sOk ? probe.players : null,
    MCount: probe?.logOk ? probe.mCount : null,
    UdpRate: probe?.udpRate,
    CpuRate: probe?.cpuRate,
    DetectionIndeterminate: classification === INDETERMINATE ? 1 : 0,
    SignalDisagreement: hasDisagreement(probe, classification) ? 1 : 0,
  });

  if (inGrace) {
    // last-active is a CONTROL variable (6.6.0): this write is UNCONDITIONAL, not "only when ACTIVE".
    // It is the race fix that stops a fresh boot inheriting a stale clock. Do not narrow it. And do
    // NOT evaluate the idle clock or call graceful-stop from here: "cannot stop yet" is unchanged.
    await putParam(c.lastActiveParam, now);
    console.log(`Instance booted ${minutesSinceLaunch.toFixed(1)} min ago, within grace - probed, not stopping.`);
    return { action: 'launch-grace', classification };
  }

  // Max-uptime cap (5.5): a cost backstop on NON-ACTIVE uptime. It is the one deliberate
  // exception to "INDETERMINATE keeps the box up", bounded to boxes up > MAX_UPTIME_HOURS.
  const uptimeHours = minutesSinceLaunch / 60;
  if (classification !== ACTIVE && uptimeHours > c.maxUptimeHours) {
    console.log(`Max uptime cap hit (${uptimeHours.toFixed(1)} h, ${classification}).`);
    emitMetrics({ MaxUptimeCapHit: 1 });
    return { action: await requestStop(c, 'max-uptime-cap'), classification };
  }

  if (classification === ACTIVE) {
    await putParam(c.lastActiveParam, now);
    return { action: 'active', classification };
  }
  if (classification === INDETERMINATE) {
    // Stay up. Never stop on a measurement we could not make.
    await putParam(c.lastActiveParam, now);
    return { action: 'indeterminate', classification };
  }

  // IDLE: has it been idle long enough?
  const lastActiveRaw = await getParam(c.lastActiveParam);
  if (lastActiveRaw === undefined || !Number.isFinite(Number(lastActiveRaw))) {
    await putParam(c.lastActiveParam, now); // first observation
    return { action: 'first-observation', classification };
  }
  const idleMinutes = (now - Number(lastActiveRaw)) / 60000;
  console.log(`Idle for ${idleMinutes.toFixed(1)} minutes (threshold ${c.idleMinutes}).`);
  if (idleMinutes < c.idleMinutes) return { action: 'idle-waiting', classification };

  return { action: await requestStop(c, 'idle'), classification };
};

exports.classify = classify;
exports.exactPlayerDetected = exactPlayerDetected;
exports.normalizeProbe = normalizeProbe;
exports.UDP_RATE_THRESHOLD = UDP_RATE_THRESHOLD;
exports.CPU_RATE_THRESHOLD = CPU_RATE_THRESHOLD;
