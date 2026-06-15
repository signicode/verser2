const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024;

function createBoundedTextCollector(maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const chunks = [];
  let storedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  return {
    write(chunk) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;

      const remaining = maxOutputBytes - storedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }

      if (buffer.length > remaining) {
        chunks.push(buffer.subarray(0, remaining));
        storedBytes += remaining;
        truncated = true;
        return;
      }

      chunks.push(buffer);
      storedBytes += buffer.length;
    },
    result() {
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        truncated,
        totalBytes,
      };
    },
  };
}

function collectChildProcessResult(
  childProcess,
  { timeoutMs = 20_000, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, killSignal = 'SIGKILL' } = {},
) {
  return new Promise((resolve, reject) => {
    const stdout = createBoundedTextCollector(maxOutputBytes);
    const stderr = createBoundedTextCollector(maxOutputBytes);
    let settled = false;

    const timeout = setTimeout(() => {
      if (childProcess.exitCode === null) {
        childProcess.kill(killSignal);
      }
    }, timeoutMs);

    const settle = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    childProcess.stdout?.on('data', (chunk) => stdout.write(chunk));
    childProcess.stderr?.on('data', (chunk) => stderr.write(chunk));
    childProcess.once('error', (error) => {
      settle(() => reject(error));
    });
    childProcess.once('close', (code, signal) => {
      settle(() => {
        const stdoutResult = stdout.result();
        const stderrResult = stderr.result();
        resolve({
          code,
          signal,
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
          stdoutBytes: stdoutResult.totalBytes,
          stderrBytes: stderrResult.totalBytes,
        });
      });
    });
  });
}

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

module.exports = {
  collectChildProcessResult,
  createBoundedTextCollector,
  terminateChildProcess,
};
