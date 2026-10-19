// graceful-stop Lambda (WP-09, ARCHITECTURE 3.2 steps 10-15 and section 4). DATA-LOSS CRITICAL.
//
// THE INVARIANT: ec2:StopInstances is unreachable unless save verification has passed AND the S3
// sync has succeeded. On ANY failure: set maintenance mode, emit the alarm metric, do NOT stop the
// instance. A box left running costs cents; a lost world is unrecoverable.
//
// INVOCATION PAYLOAD (all optional; unknown fields ignored; a missing/garbled payload is fine):
//   { "reason": "idle" | "manual" | <anything>, "requestedBy": "<free text, e.g. a Discord user id>" }
//
// RETURN VALUE (always returned, never thrown, so async-invoke retries cannot re-run a drain):
//   { outcome, stopped, ... } where outcome is one of
//     "stopped"                 saved, verified, synced, instance stopped
//     "aborted-players-present" a player is on the server; nothing was stopped. NOT a failure.
//     "aborted-indeterminate"   the player re-check could not tell; nothing was stopped. NOT a failure.
//     "noop-not-running"        the instance was not running; nothing to do
//     "failed"                  something went wrong; maintenance mode set, alarm raised, NOT stopped
//
// WALL-CLOCK RULE: the only time sources are file mtimes (reported by the box), the last-player-seen SSM
// parameter and the instance LaunchTime. Game-log timestamps are uptime-relative and are never read.

const NAMESPACE = 'Enshrouded';
const PARAM_MAINTENANCE = '/enshroudedproj/state/maintenance-mode';
const PARAM_RUN_STATE = '/enshroudedproj/state/run-state';
// FACT (ARCHITECTURE 6.6.0): wall-clock epoch ms at which an EXACT signal last reported >= 1 player.
// Written only by idle-shutdown, never cleared. This is the ONLY activity evidence this Lambda may read;
// the idle-clock parameter is a CONTROL variable owned by idle-shutdown and is deliberately not read or
// written here (a test enforces that).
const PARAM_LAST_PLAYER_SEEN = '/enshroudedproj/state/last-player-seen';
// Row 2 tolerance: save mtimes are on the INSTANCE clock, last-player-seen is stamped by the LAMBDA
// (AWS clock). Both are chrony-synced so skew should be sub-millisecond, but the signature being caught
// is "played for ages, nothing ever saved" - a gap of many minutes - so a two-minute margin costs no
// detection power and removes a whole class of cross-clock false positives.
const CLOCK_SKEW_TOLERANCE_MS = 120_000;
// SSM rejects an empty Value, so "cleared" is the literal below; only "stopping" is meaningful to idle-shutdown.
const RUN_STATE_CLEARED = 'none';
const DRAIN_SCRIPT = '/usr/local/lib/enshrouded/drain-and-save.sh';
const PROBE_SCRIPT = '/usr/local/lib/enshrouded/probe-players.py';

// ---------------------------------------------------------------------------------------------
// Pure verdict logic (ARCHITECTURE 3.2 step 12). Exported for tests.
// ---------------------------------------------------------------------------------------------

/**
 * Parse the KEY=value lines printed by `drain-and-save.sh stop`. Returns null if the script did not
 * reach its DRAIN_DONE marker (so a half-run is never mistaken for facts).
 */
function parseDrainFacts(stdout) {
  const kv = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^DRAIN_([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2].trim();
  }
  if (kv.DONE !== '1') return null;
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
  return {
    t0: num(kv.T0), // box wall clock, fractional epoch SECONDS
    preCount: num(kv.PRE_COUNT),
    postCount: num(kv.POST_COUNT),
    postNewest: num(kv.POST_NEWEST), // newest savegame/ mtime, fractional epoch SECONDS
    activeState: kv.ACTIVE_STATE,
    result: kv.RESULT,
    execMainCode: kv.EXEC_MAIN_CODE,
    execMainStatus: kv.EXEC_MAIN_STATUS,
    gamePids: num(kv.GAME_PIDS),
  };
}

/**
 * Does the unit exit signature unambiguously mean the save was cut short? Fails ONLY on
 *   Result=timeout, or ExecMainCode=killed with ExecMainStatus=9 (SIGKILL).
 * `systemctl show` prints ExecMainCode numerically (CLD_KILLED = 2); `systemctl status` prints
 * "killed". Both spellings are the SAME signature, not a widening.
 * Result=exit-code and Result=signal are NORMAL for a clean SIGINT shutdown and MUST be accepted:
 * gating on Result=success would set maintenance mode on every ordinary shutdown (section 3.2).
 * Do not add other results or statuses here to make logs look tidy (section 4.3.1).
 */
function isTruncatedStop(result, execMainCode, execMainStatus) {
  if (result === 'timeout') return true;
  const killed = execMainCode === 'killed' || execMainCode === '2';
  return killed && String(execMainStatus) === '9';
}

/**
 * The save-verification verdict. Inputs:
 *   facts   from parseDrainFacts
 *   ctx     { lastPlayerSeenMs, launchTimeMs }  (SSM FACT parameter + instance LaunchTime, epoch ms)
 * Returns { pass, reasons: string[], skippedEmptyWorld: boolean, saveCheck: string }.
 * Any missing or unparseable input is a FAIL: when in doubt, do not stop.
 */
function evaluateSave(facts, ctx) {
  const reasons = [];
  let skippedEmptyWorld = false;
  let saveCheck = 'unevaluated';
  if (!facts) {
    return { pass: false, reasons: ['no-drain-facts: drain script did not complete'], skippedEmptyWorld, saveCheck };
  }
  // null/undefined = parameter ABSENT (no player has ever been seen); NaN = present but unparseable.
  const seenAbsent = !ctx || ctx.lastPlayerSeenMs === null || ctx.lastPlayerSeenMs === undefined;
  const lastPlayerSeenMs = !seenAbsent && Number.isFinite(ctx.lastPlayerSeenMs) ? ctx.lastPlayerSeenMs : NaN;
  const launchTimeMs = ctx && Number.isFinite(ctx.launchTimeMs) ? ctx.launchTimeMs : NaN;

  // (a) the unit is no longer running. `failed` is what systemd reports after a clean SIGINT exit
  // with Result=exit-code/signal, so it is accepted; only still-running states are refused.
  if (facts.activeState !== 'inactive' && facts.activeState !== 'failed') {
    reasons.push(`unit-not-stopped: ActiveState=${facts.activeState}`);
  }
  // (c) truncation signatures only.
  if (isTruncatedStop(facts.result, facts.execMainCode, facts.execMainStatus)) {
    reasons.push(
      `truncated-stop: Result=${facts.result} ExecMainCode=${facts.execMainCode} ExecMainStatus=${facts.execMainStatus}`,
    );
  }
  // The process must be confirmed dead before any copy (no open file handles).
  if (facts.gamePids !== 0) {
    reasons.push(`game-process-alive: ${facts.gamePids} process(es)`);
  }

  // (b) the save check: ARCHITECTURE 3.2 step 12b table, in order.
  const count = facts.postCount;
  const newestMs = facts.postNewest * 1000;
  if (!Number.isFinite(count) || !Number.isFinite(facts.t0)) {
    saveCheck = 'unreadable';
    reasons.push('save-unreadable: savegame listing or t0 missing');
  } else if (count > 0 && Number.isFinite(facts.postNewest) && facts.postNewest > facts.t0) {
    saveCheck = 'shutdown-save-written'; // a file has mtime > t0
  } else if (
    count > 0 &&
    Number.isFinite(newestMs) &&
    // Absent last-player-seen: no player was ever seen, so no save can be stale relative to it. An
    // unparseable value is NOT absent: it falls through to FAIL (when in doubt, do not stop).
    (seenAbsent || newestMs >= lastPlayerSeenMs - CLOCK_SKEW_TOLERANCE_MS)
  ) {
    saveCheck = 'covered-by-disconnect-save'; // newest mtime >= last-player-seen (within tolerance)
  } else if (count > 0) {
    saveCheck = 'unflushed';
    reasons.push(
      'save-not-flushed: savegame/ is non-empty but its newest mtime is older than last-player-seen ' +
        'and nothing was written during the stop (a player was present after the last save)',
    );
  } else if (count === 0) {
    // Empty savegame/. Did a player connect this boot? ONLY last-player-seen answers that
    // (lastPlayerSeen >= LaunchTime). Absent / older than LaunchTime / unparseable all mean "no".
    if (!Number.isFinite(launchTimeMs)) {
      saveCheck = 'empty-unknown';
      reasons.push('empty-world-unknown: cannot tell whether a player connected this boot (no LaunchTime)');
    } else if (lastPlayerSeenMs >= launchTimeMs) {
      saveCheck = 'empty-but-player-connected';
      reasons.push('empty-world-after-player: savegame/ is empty but a player connected this boot');
    } else {
      saveCheck = 'empty-no-player';
      skippedEmptyWorld = true; // PASS, emit SaveSkippedEmptyWorld
    }
  } else {
    saveCheck = 'unreadable';
    reasons.push('save-unreadable: negative count');
  }
  return { pass: reasons.length === 0, reasons, skippedEmptyWorld, saveCheck };
}

/** Classify a probe-players.py JSON line: only "players present" / "unreadable" / "clear". */
function classifyRecheck(probe) {
  if (!probe || typeof probe !== 'object') return 'indeterminate';
  const a2sActive = probe.a2sOk === true && Number(probe.players) > 0;
  const logActive = probe.logOk === true && Number(probe.mCount) > 0;
  if (a2sActive || logActive) return 'active';
  if (probe.a2sOk !== true && probe.logOk !== true) return 'indeterminate';
  return 'clear';
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    try {
      return JSON.parse(l);
    } catch (_e) {
      /* keep looking */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Real AWS dependencies (lazy, so tests never load the SDK).
// ---------------------------------------------------------------------------------------------
function defaultDeps() {
  const env = process.env;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let clients = null;
  const c = () => {
    if (!clients) {
      const { SSMClient } = require('@aws-sdk/client-ssm');
      const { EC2Client } = require('@aws-sdk/client-ec2');
      const { CloudWatchClient } = require('@aws-sdk/client-cloudwatch');
      clients = { ssm: new SSMClient({}), ec2: new EC2Client({}), cw: new CloudWatchClient({}) };
    }
    return clients;
  };
  return {
    now: () => Date.now(),
    async getParam(name) {
      const { GetParameterCommand } = require('@aws-sdk/client-ssm');
      try {
        const r = await c().ssm.send(new GetParameterCommand({ Name: name }));
        return r.Parameter.Value;
      } catch (e) {
        if (e && e.name === 'ParameterNotFound') return null;
        throw e;
      }
    },
    async putParam(name, value) {
      const { PutParameterCommand } = require('@aws-sdk/client-ssm');
      await c().ssm.send(new PutParameterCommand({ Name: name, Value: String(value), Type: 'String', Overwrite: true }));
    },
    async describeInstance() {
      const { DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
      const r = await c().ec2.send(new DescribeInstancesCommand({ InstanceIds: [env.INSTANCE_ID] }));
      const i = r.Reservations[0].Instances[0];
      return { state: i.State.Name, launchTimeMs: new Date(i.LaunchTime).getTime() };
    },
    /** Run one shell command on the box. Returns { ok, status, stdout, stderr }. Never throws on command failure. */
    async runOnBox(command, timeoutSec) {
      const { SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
      const sent = await c().ssm.send(
        new SendCommandCommand({
          InstanceIds: [env.INSTANCE_ID],
          DocumentName: 'AWS-RunShellScript',
          Parameters: { commands: [command], executionTimeout: [String(timeoutSec)] },
          TimeoutSeconds: 60, // delivery timeout
        }),
      );
      const id = sent.Command.CommandId;
      const deadline = Date.now() + (timeoutSec + 30) * 1000;
      await sleep(2000);
      while (Date.now() < deadline) {
        try {
          const r = await c().ssm.send(new GetCommandInvocationCommand({ CommandId: id, InstanceId: env.INSTANCE_ID }));
          if (!['Pending', 'InProgress', 'Delayed'].includes(r.Status)) {
            return {
              ok: r.Status === 'Success',
              status: r.Status,
              stdout: r.StandardOutputContent || '',
              stderr: r.StandardErrorContent || '',
            };
          }
        } catch (e) {
          if (!e || e.name !== 'InvocationDoesNotExist') throw e;
        }
        await sleep(3000);
      }
      return { ok: false, status: 'LambdaPollTimeout', stdout: '', stderr: '' };
    },
    async stopInstance() {
      const { StopInstancesCommand } = require('@aws-sdk/client-ec2');
      await c().ec2.send(new StopInstancesCommand({ InstanceIds: [env.INSTANCE_ID] }));
    },
    async putMetric(name, value) {
      const { PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
      await c().cw.send(
        new PutMetricDataCommand({
          Namespace: NAMESPACE,
          MetricData: [{ MetricName: name, Value: value, Unit: 'Count', Timestamp: new Date() }],
        }),
      );
    },
    /** Best-effort Discord channel post. `which` is "status" or "ops". Never logs the token. */
    async postDiscord(which, content) {
      const channel = which === 'ops' ? env.DISCORD_OPS_CHANNEL_ID : env.DISCORD_STATUS_CHANNEL_ID;
      if (!channel) return false;
      const { getBotToken, DISCORD_API, DISCORD_USER_AGENT } = require('../shared/discord');
      const token = await getBotToken();
      const res = await fetch(`${DISCORD_API}/channels/${channel}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': DISCORD_USER_AGENT, Authorization: `Bot ${token}` },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) console.error(`Discord post failed: ${res.status}`);
      return res.ok;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The handler.
// ---------------------------------------------------------------------------------------------
function createHandler(deps) {
  // Every side effect other than the stop itself is best-effort: it must never block the safety path.
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`graceful-stop: ${label} failed: ${e && e.message ? e.message : e}`);
      return undefined;
    }
  };

  /** The failure path. Does NOT stop the instance. Maintenance mode first: it is the safety state. */
  async function fail(check, detail, extra) {
    console.error(`graceful-stop: FAILED check=${check} detail=${detail}`);
    const maintenanceSet = (await attempt('set maintenance-mode', async () => {
      await deps.putParam(PARAM_MAINTENANCE, 'true');
      return true;
    })) === true;
    await attempt('metric GracefulStopFailed', () => deps.putMetric('GracefulStopFailed', 1));
    if (extra && extra.verification) {
      await attempt('metric SaveVerificationFailed', () => deps.putMetric('SaveVerificationFailed', 1));
    }
    await attempt('clear run-state', () => deps.putParam(PARAM_RUN_STATE, RUN_STATE_CLEARED));
    await attempt('discord ops', () =>
      deps.postDiscord(
        'ops',
        `ALERT: graceful stop FAILED (${check}). The server was NOT stopped and maintenance mode is ${maintenanceSet ? 'ON' : 'NOT CONFIRMED - set it by hand'}. ` +
          `Check the world before clearing it. Detail: ${detail}`,
      ),
    );
    return { outcome: 'failed', stopped: false, check, detail, maintenanceSet };
  }

  return async function handler(event) {
    const ev = event && typeof event === 'object' ? event : {};
    const reason = typeof ev.reason === 'string' ? ev.reason : 'unspecified';
    const requestedBy = typeof ev.requestedBy === 'string' ? ev.requestedBy : undefined;
    console.log(`graceful-stop: start reason=${reason}${requestedBy ? ` requestedBy=${requestedBy}` : ''}`);

    try {
      await attempt('discord status notice', () =>
        deps.postDiscord('status', 'Nobody is around - saving and shutting down.'),
      );

      // 1. Re-check players. A stop decision may be stale by now.
      const probeRun = await deps.runOnBox(`python3 ${PROBE_SCRIPT}`, 60);
      const verdict = probeRun.ok ? classifyRecheck(parseLastJsonLine(probeRun.stdout)) : 'indeterminate';
      if (verdict === 'active') {
        // Deliberately does NOT touch the idle clock: that is idle-shutdown's CONTROL variable (6.6.0).
        // Its next tick sees the same player and resets it itself.
        await attempt('clear run-state', () => deps.putParam(PARAM_RUN_STATE, RUN_STATE_CLEARED));
        await attempt('discord status', () => deps.postDiscord('status', 'Someone just joined - stop cancelled.'));
        return { outcome: 'aborted-players-present', stopped: false, reason };
      }
      if (verdict === 'indeterminate') {
        // Not a save failure and not a reason to alarm: simply do not stop on an unreadable probe.
        await attempt('clear run-state', () => deps.putParam(PARAM_RUN_STATE, RUN_STATE_CLEARED));
        return { outcome: 'aborted-indeterminate', stopped: false, reason };
      }

      const inst = await deps.describeInstance();
      if (inst.state !== 'running') {
        await attempt('clear run-state', () => deps.putParam(PARAM_RUN_STATE, RUN_STATE_CLEARED));
        return { outcome: 'noop-not-running', stopped: false, reason, instanceState: inst.state };
      }

      // Read the FACT parameter BEFORE the stop (once the game is down every probe fails). Absent -> null.
      const seenRaw = await deps.getParam(PARAM_LAST_PLAYER_SEEN);
      const lastPlayerSeenMs = seenRaw === null || seenRaw === undefined ? null : Number(seenRaw);

      // 2. Stop (the unit ExecStop does SIGINT + wait). 3. Collect facts.
      const drain = await deps.runOnBox(`${DRAIN_SCRIPT} stop`, 240);
      if (!drain.ok) {
        return await fail('drain-command-failed', `SSM status=${drain.status}`, { verification: true });
      }
      const facts = parseDrainFacts(drain.stdout);

      // SAVE VERIFICATION. Nothing below this line may run unless it passes.
      const verification = evaluateSave(facts, { lastPlayerSeenMs, launchTimeMs: inst.launchTimeMs });
      if (!verification.pass) {
        return await fail('save-verification', verification.reasons.join('; '), { verification: true });
      }
      if (verification.skippedEmptyWorld) {
        await attempt('metric SaveSkippedEmptyWorld', () => deps.putMetric('SaveSkippedEmptyWorld', 1));
      }

      // 4. Sync savegame/ to S3. Failure here also refuses the stop.
      const sync = await deps.runOnBox(`${DRAIN_SCRIPT} sync`, 300);
      if (!sync.ok || !/DRAIN_SYNC=(ok|empty-nothing-to-copy)/.test(sync.stdout)) {
        return await fail('s3-sync', `SSM status=${sync.status}`, { verification: false });
      }

      // 5. Only now.
      try {
        await deps.stopInstance();
      } catch (e) {
        return await fail('stop-instances', e && e.message ? e.message : String(e), { verification: false });
      }
      await attempt('clear run-state', () => deps.putParam(PARAM_RUN_STATE, RUN_STATE_CLEARED));
      await attempt('metric GracefulStopCompleted', () => deps.putMetric('GracefulStopCompleted', 1));
      await attempt('discord status', () => deps.postDiscord('status', 'Saved and stopped.'));
      return { outcome: 'stopped', stopped: true, reason, saveCheck: verification.saveCheck };
    } catch (e) {
      // Anything unexpected before the stop: never stop, set maintenance mode.
      return await fail('unexpected-error', e && e.message ? e.message : String(e), { verification: false });
    }
  };
}

exports.handler = createHandler(defaultDeps());
exports.createHandler = createHandler;
exports.evaluateSave = evaluateSave;
exports.parseDrainFacts = parseDrainFacts;
exports.isTruncatedStop = isTruncatedStop;
exports.classifyRecheck = classifyRecheck;
