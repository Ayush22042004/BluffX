const retryable = (e) =>
  [
    "SERVER_ALREADY_RUNNING",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "57P01",
    "57P02",
    "57P03",
    "53300",
    "EAI_AGAIN",
    "08006",
    "STORAGE_UNAVAILABLE",
  ].includes(e?.code);
// A new ownership epoch always reconstructs committed rooms from storage.
async function supervise(
  start,
  {
    signal,
    sleep = (ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
      }),
    onReady = () => {},
    onRetry = () => {},
  } = {},
) {
  let attempt = 0;
  while (!signal?.aborted) {
    let instance;
    try {
      instance = await start();
      attempt = 0;
      onReady(instance);
      if (signal?.aborted) return;
      await new Promise((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resolve();
        };
        signal?.addEventListener("abort", done, { once: true });
        instance.recovery.then(done);
      });
    } catch (e) {
      if (!retryable(e)) throw e;
      onRetry(e.code);
    } finally {
      if (instance) await instance.close();
    }
    if (!signal?.aborted)
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)), signal);
  }
}
module.exports = { supervise, retryable };
