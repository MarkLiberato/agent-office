'use strict';

/** Fake clock, fake timers, fake sink. Nothing here touches audio or real time:
 *  clips "end" when the clock reaches their duration, which is exactly the
 *  contract the real mixer handle provides.
 *
 *  opts.random    — fixed value for the reply-gap jitter (default 0.5)
 *  opts.durations — { utteranceId: ms }, default 1000 ms per clip
 */
function harness(opts) {
  const options = opts || {};
  let t = 1000;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: t + Math.max(0, ms) });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    random: () => (options.random === undefined ? 0.5 : options.random)
  };

  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

  async function advance(ms) {
    const target = t + ms;
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of timers) if (timer.at < dueAt) { dueAt = timer.at; dueId = id; }
      if (dueId === null || dueAt > target) break;
      const timer = timers.get(dueId);
      timers.delete(dueId);
      t = dueAt;
      timer.fn();
      await flush();
    }
    t = target;
    await flush();
  }

  const log = { prepared: [], started: [], ended: [] };
  const durations = options.durations || {};
  const sink = {
    async prepare(intent) { log.prepared.push(intent.utteranceId); },
    async play(intent, playOpts) {
      const durationMs = durations[intent.utteranceId] === undefined
        ? 1000
        : durations[intent.utteranceId];
      log.started.push({ id: intent.utteranceId, at: t, gain: playOpts.gain, pan: playOpts.pan });
      let settle;
      const ended = new Promise((r) => { settle = r; });
      const finish = () => { log.ended.push({ id: intent.utteranceId, at: clock.now() }); settle(); };
      const timerId = clock.setTimer(finish, durationMs);
      return {
        durationMs,
        ended,
        stop() { clock.clearTimer(timerId); finish(); }
      };
    }
  };

  let n = 0;
  const intent = (over) => Object.assign({
    utteranceId: 'u' + (++n),
    agentId: 'a',
    voiceId: 'am_adam',
    text: 'morning',
    priority: 'ambient',
    eligibleAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    pan: 0
  }, over || {});

  return { clock, sink, log, advance, flush, intent, at: () => t };
}

module.exports = { harness };
