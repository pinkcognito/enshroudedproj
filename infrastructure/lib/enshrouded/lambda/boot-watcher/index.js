const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, DescribeInstanceInformationCommand, SendCommandCommand, GetCommandInvocationCommand } = require('@aws-sdk/client-ssm');
const { editOriginalResponse, getBotToken } = require('../shared/discord');
const { queryInfo } = require('../shared/a2s');
const { ACCESS_PREFIX, authorizePasswordAccess, sendPasswordDm } = require('../discord-bot/password-access');
const { readParameter, readPasswords, desyncActive } = require('../discord-bot/rotation');

const MAX_MS = 8 * 60 * 1000;
const POLL_MS = 10000;
// Fixed query port 15637 = 3D15. No config, logs, PIDs, or secrets leave the host.
const READY_COMMAND = "systemctl is-active --quiet enshrouded.service && awk '$2 ~ /:3D15$/ { found=1 } END { if (found) print \"ready\"; else exit 1 }' /proc/net/udp";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One invocation, no self-invoke. Integration MUST use ~510s timeout, Lambda async
// retryAttempts=0 and caller Invoke maxAttempts=1. At-most-once is best effort:
// duplicate service deliveries cannot be deduplicated without durable state.
exports.handler = async (event, context) => {
  const enteredAt = Date.now();
  const lambdaUntil = enteredAt + (context?.getRemainingTimeInMillis?.() ?? 510000) - 1000;
  const operationalDeadline = Math.min(enteredAt + MAX_MS,
    Number.isFinite(event?.startedAt) ? event.startedAt + MAX_MS : enteredAt,
    lambdaUntil - 5000);
  const remaining = () => operationalDeadline - Date.now();
  // Bounds even shared helpers whose SDK clients do not accept a caller signal.
  // Late read completions have no continuation into the DM path.
  const bounded = async (work, limit = 3000, until = operationalDeadline) => {
    const ms = Math.min(limit, until - Date.now());
    if (ms <= 0) throw new Error('deadline');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), ms);
      })]);
    } finally { clearTimeout(timer); }
  };
  const patch = async (content, terminal = false) => {
    const until = terminal ? Math.min(lambdaUntil, Date.now() + 2000) : operationalDeadline;
    try {
      const ok = await bounded(() => editOriginalResponse(process.env.DISCORD_APPLICATION_ID,
        event.interactionToken, content, Math.max(1, Math.min(2000, until - Date.now()))), 2000, until);
      if (!ok) console.log(JSON.stringify({ event: 'boot-watcher-patch', outcome: 'rejected' }));
    } catch {
      console.log(JSON.stringify({ event: 'boot-watcher-patch', outcome: 'unconfirmed' }));
      // Token-bearing errors must never escape or cause a delivery retry.
    }
  };
  let gate = 1;
  const fail = async (reason) => {
    console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{
      Namespace: 'Enshrouded', Dimensions: [[]], Metrics: [{ Name: 'BootReadinessFailed', Unit: 'Count' }],
    }] }, BootReadinessFailed: 1 }));
    await patch(`Readiness failed at gate ${gate}: ${reason}. The server has been left up for inspection.`, true);
  };
  try {
    if (!Number.isFinite(event?.startedAt) || event.startedAt <= 0 || event.startedAt > enteredAt ||
        !process.env.INSTANCE_ID || remaining() <= 0) return await fail('time budget expired or invalid start');
    const ec2 = new EC2Client({ maxAttempts: 1 });
    const ssm = new SSMClient({ maxAttempts: 1 });
    const send = (client, command) => bounded(() => client.send(command, {
      abortSignal: AbortSignal.timeout(Math.max(1, Math.min(3000, remaining()))),
    }));
    const describe = async () => {
      const result = await send(ec2, new DescribeInstancesCommand({ InstanceIds: [process.env.INSTANCE_ID] }));
      return result.Reservations?.flatMap((r) => r.Instances || [])
        .find((i) => i.InstanceId === process.env.INSTANCE_ID);
    };
    const timestamp = (value) => value instanceof Date ? value.getTime()
      : typeof value === 'string' ? Date.parse(value) : NaN;
    const prior = event.priorLaunchTime === undefined ? null : timestamp(event.priorLaunchTime);
    if (prior !== null && !Number.isFinite(prior)) return await fail('unknown prior boot');
    // The dispatcher captures the exact post-start EC2 LaunchTime as toISOString().
    // Never infer a session from whichever boot happens to be visible on delivery.
    const expected = timestamp(event.expectedLaunchTime);
    if (typeof event.expectedLaunchTime !== 'string' || !Number.isFinite(expected) ||
        new Date(expected).toISOString() !== event.expectedLaunchTime ||
        expected < event.startedAt - 5000 || expected > event.startedAt + 5000 ||
        (prior !== null && expected <= prior)) return await fail('unknown or invalid expected boot');
    const session = (instance) => {
      const state = instance?.State?.Name;
      if (['stopped', 'stopping', 'terminated', 'shutting-down'].includes(state)) throw new Error('session-ended');
      const current = timestamp(instance?.LaunchTime);
      if (!Number.isFinite(current) || current === prior) return false;
      if (current !== expected) throw new Error('session-changed');
      if (current > Date.now()) return false;
      return state === 'running';
    };
    let commandId;
    let boxReady = false;
    let progress = 0;
    while (remaining() > 0) {
      try {
        const instance = await describe();
        if (session(instance)) {
          gate = 1;
          const online = await send(ssm, new DescribeInstanceInformationCommand({
            Filters: [{ Key: 'InstanceIds', Values: [process.env.INSTANCE_ID] }],
          }));
          if (online.InstanceInformationList?.some((i) => i.InstanceId === process.env.INSTANCE_ID && i.PingStatus === 'Online')) {
            gate = 2;
            if (progress < 2) { progress = 2; await patch('World loading… checking the game service and query socket.'); }
            if (!boxReady) {
              if (!commandId) {
                const result = await send(ssm, new SendCommandCommand({ InstanceIds: [process.env.INSTANCE_ID],
                  DocumentName: 'AWS-RunShellScript', TimeoutSeconds: 30,
                  Parameters: { commands: [READY_COMMAND], executionTimeout: ['20'] },
                }));
                commandId = result.Command?.CommandId;
              } else {
                const invocation = await send(ssm, new GetCommandInvocationCommand({
                  InstanceId: process.env.INSTANCE_ID, CommandId: commandId,
                }));
                boxReady = invocation.Status === 'Success' && invocation.ResponseCode === 0 &&
                  invocation.StandardOutputContent?.trim() === 'ready';
                if (!['Pending', 'InProgress', 'Delayed'].includes(invocation.Status)) commandId = undefined;
              }
            }
            if (boxReady) {
              gate = 3;
              if (progress < 3) { progress = 3; await patch('World loaded… checking the public query path.'); }
              const host = instance.PublicIpAddress;
              const result = host ? await bounded(() => queryInfo({ host, port: 15637,
                timeoutMs: Math.max(1, Math.min(3000, remaining())) })) : null;
              if (result?.ok) {
                const fresh = await describe();
                if (!session(fresh) || fresh.PublicIpAddress !== host) throw new Error('session-unconfirmed');
                const ready = 'Server ready. Open Enshrouded → Play → dedicated server list and select your server.';
                await patch(ready);
                try {
                  const request = { guildId: event.guildId, userId: event.userId, roleIds: event.roleIds };
                  const mapping = JSON.parse(await bounded(() => readParameter(`${ACCESS_PREFIX}/${request.guildId}`)));
                  const botToken = await bounded(() => getBotToken());
                  const fetchWithinBudget = (url, options) => {
                    if (remaining() <= 0) throw new Error('deadline');
                    return fetch(url, { ...options, signal: AbortSignal.any([options.signal,
                      AbortSignal.timeout(Math.max(1, Math.min(2000, remaining())))] ) });
                  };
                  const access = await bounded(() => authorizePasswordAccess(request, mapping, { botToken, fetch: fetchWithinBudget }));
                  if (!access) return;
                  if (await bounded(() => desyncActive())) return;
                  const passwords = await bounded(() => readPasswords(access.groups));
                  if (await bounded(() => desyncActive())) return;
                  if (!session(await describe())) return;
                  const dm = await bounded(() => sendPasswordDm(request, access, passwords,
                    { botToken, fetch: fetchWithinBudget }), 4500);
                  if (!dm.ok) await patch(`${ready} Unable to send a DM; check your privacy settings and use /enshrouded pw.`, true);
                } catch { await patch(`${ready} Password delivery could not be confirmed; use /enshrouded pw.`, true); }
                return; // Never throw after DM success, including when the reply edit failed.
              }
            }
          }
        } else { gate = 1; }
      } catch (error) {
        if (['session-ended', 'session-changed', 'session-unconfirmed'].includes(error.message)) {
          return await fail('the original boot is no longer confirmed running');
        }
        // Transient EC2, SSM, invocation-not-visible and A2S failures retry on cadence.
      }
      await sleep(Math.min(POLL_MS, Math.max(0, remaining())));
    }
    await fail(gate === 3 ? 'public query did not respond; check firewall or bind' : 'timed out waiting for readiness');
  } catch { await fail('readiness could not be confirmed'); }
};
