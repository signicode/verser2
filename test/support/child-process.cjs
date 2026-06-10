function terminateChildProcess(
  childProcess,
  { timeoutMs = 10_000, terminationSignal = 'SIGTERM', killSignal = 'SIGKILL' } = {},
) {
  if (!childProcess || childProcess.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let terminated = false;

    const finalize = () => {
      if (terminated) {
        return;
      }

      terminated = true;
      clearTimeout(terminationTimeoutId);
      clearTimeout(forceKillTimeoutId);
      childProcess.off('exit', onExit);
      resolve();
    };

    const onExit = () => {
      finalize();
    };

    const forceKillTimeoutId = setTimeout(() => {
      if (!terminated && childProcess.exitCode === null) {
        try {
          childProcess.kill(killSignal);
        } catch {
          // Ignore and allow final timeout to resolve cleanup.
        }
      }
    }, timeoutMs / 2);

    const terminationTimeoutId = setTimeout(() => {
      finalize();
    }, timeoutMs);

    childProcess.once('exit', onExit);
    if (childProcess.exitCode !== null) {
      finalize();
      return;
    }

    try {
      childProcess.kill(terminationSignal);
    } catch {
      finalize();
    }
  });
}

module.exports = { terminateChildProcess };
