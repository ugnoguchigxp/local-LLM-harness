import { expect, test } from "bun:test";
import { LinuxCpuComputeExecutor } from "./executor";
import { parseComputeRequest } from "@larm/core";
import { readFileSync } from "node:fs";

const runtimeRoot = process.env.LARM_COMPUTE_TEST_RUNTIME;
const live = test.skipIf(!runtimeRoot);
const executor = () => new LinuxCpuComputeExecutor({ runtimeRoot: runtimeRoot!,
  runner: new URL("../../../../apps/compute-cpu/runner.py", import.meta.url).pathname,
  requirements: new URL("../../../../apps/compute-cpu/requirements.txt", import.meta.url).pathname });
const run = (code: string, timeoutSec = 10) => executor().execute(parseComputeRequest({ code, timeoutSec }), {
  signal: new AbortController().signal, progress: () => undefined,
});

live("CPU sandbox executes scientific calculations and returns a real PNG", async () => {
  const env = await executor().environment();
  expect(env.packages).toHaveLength(7);
  expect(env.accelerators.map(item => item.kind)).toEqual(["cpu"]);
  const output = await run(`
import numpy as np
import sympy as sp
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LinearRegression
import pandas as pd
import statsmodels.api as sm
import matplotlib.pyplot as plt
x = sp.Symbol('x')
fit = LinearRegression().fit(np.array([[1.], [2.], [3.]]), np.array([3., 5., 7.]))
opt = minimize_scalar(lambda a: (a - 3)**2)
plt.plot([1, 2, 3], [3, 5, 7])
report('finished', 1.0)
result = {'integral': str(sp.integrate(x**2, x)), 'optimum': opt.x,
          'slope': fit.coef_, 'table': pd.DataFrame({'x': [1, 2]})}
`, 30);
  const value = output.value as { integral: string; optimum: number; slope: number[]; table: unknown };
  expect(value.integral).toBe("x**3/3");
  expect(value.optimum).toBeCloseTo(3);
  expect(value.slope[0]).toBeCloseTo(2);
  expect(value.table).toEqual([{ x: 1 }, { x: 2 }]);
  expect(output.artifacts).toHaveLength(1);
  expect(output.artifacts[0]!.mime).toBe("image/png");
  expect(output.artifacts[0]!.data.length).toBeGreaterThan(1000);
}, 40_000);

live("CPU sandbox hides host data and devices and denies network, forks, and user threads", async () => {
  const output = await run(`
import os, socket, threading
result = {'host_hidden': not os.path.exists('/srv/ai/apps/local-LLM-harness/AGENTS.md'),
          'home_hidden': not os.path.exists('/home/ugnoguchi'),
          'gpu_hidden': not os.path.exists('/dev/kfd') and not os.path.exists('/dev/dri'),
          'proc_hidden': not os.path.exists('/proc/1/mem')}
for name, operation in [('root_readonly', lambda: open('/forbidden', 'w')),
                        ('devices_readonly', lambda: open('/dev/forbidden', 'w')),
                        ('network_denied', lambda: socket.socket()),
                        ('fork_denied', lambda: os.fork()),
                        ('thread_denied', lambda: threading.Thread(target=lambda: None).start())]:
    try:
        operation()
        result[name] = False
    except (OSError, RuntimeError):
        result[name] = True
`);
  expect(Object.values(output.value as Record<string, unknown>).every(value => value === true)).toBe(true);
});

live("CPU affinity applies to every bootstrap thread", async () => {
  const output = await run("import os, threading\nresult = [len(os.sched_getaffinity(t.native_id)) for t in threading.enumerate()]");
  expect(output.value).toEqual([1, 1, 1]);
});

live("CPU sandbox blocks memory files and persistent System V shared memory", async () => {
  const output = await run(`
import os, ctypes
result = {}
try:
    fd = os.memfd_create('bounded-probe')
    os.close(fd)
    result['memfd_denied'] = False
except OSError:
    result['memfd_denied'] = True
libc = ctypes.CDLL(None, use_errno=True)
shared = libc.shmget(0, 4096, 0o600)
if shared >= 0:
    libc.shmctl(shared, 0, None)
result['sysv_shared_memory_denied'] = shared < 0
`);
  expect(output.value).toEqual({ memfd_denied: true, sysv_shared_memory_denied: true });
});

live("explicit artifact filenames do not conflict with automatic figure export", async () => {
  const output = await run("import matplotlib.pyplot as plt\nplt.plot([1,2])\nplt.savefig('/work/artifacts/figure-1.png')", 15);
  expect(output.artifacts.length).toBe(2);
  expect(new Set(output.artifacts.map(item => item.name)).size).toBe(2);
});

live("CPU sandbox truncates output, enforces time/memory, and stays usable", async () => {
  const output = await run("print('x' * 1000000)\nresult = 2");
  expect(output.stdoutTruncated).toBe(true);
  expect(Buffer.byteLength(output.stdout)).toBe(256 * 1024);
  await expect(run("while True: pass", 1)).rejects.toMatchObject({ code: "timeout" });
  await expect(run("result = bytearray(3 * 1024**3)")).rejects.toMatchObject({ code: "memory_exceeded" });
  expect((await run("result = 1 + 1")).value).toBe(2);
}, 15_000);

live("CPU sandbox cancellation kills active work and a later job still runs", async () => {
  const abort = new AbortController();
  const task = executor().execute(parseComputeRequest({ code: "while True: pass" }), {
    signal: abort.signal, progress: () => undefined, stage: stage => { if (stage === "running") abort.abort(); },
  });
  await expect(task).rejects.toMatchObject({ code: "cancelled" });
  expect((await run("result = 42")).value).toBe(42);
});

live("CPU sandbox bounds artifacts/results and classifies syntax errors", async () => {
  await expect(run("result = 'x' * 2000000")).rejects.toMatchObject({ code: "output_exceeded" });
  await expect(run("def broken(")).rejects.toMatchObject({ code: "syntax_error" });
  await expect(run("for i in range(11): open('/work/artifacts/%s.json' % i, 'w').write('{}')")).rejects.toMatchObject({ code: "limit_exceeded" });
  await expect(run("import os; os._exit(1)")).rejects.toMatchObject({ code: "runtime_error" });
  expect((await run("result=2")).value).toBe(2);
});

live("CPU sandbox exits after its host executor is killed", async () => {
  const options = { runtimeRoot: runtimeRoot!, runner: new URL("../../../../apps/compute-cpu/runner.py", import.meta.url).pathname,
    requirements: new URL("../../../../apps/compute-cpu/requirements.txt", import.meta.url).pathname };
  const modulePath = new URL("./executor.ts", import.meta.url).pathname;
  const source = `import {LinuxCpuComputeExecutor} from ${JSON.stringify(modulePath)};
    const executor = new LinuxCpuComputeExecutor(${JSON.stringify(options)});
    await executor.execute({code:"while True: pass",inputs:{},timeoutSec:20,accelerator:"cpu"},
      {signal:new AbortController().signal,progress:()=>{},stage:s=>{if(s==="running")console.log("ready")}});`;
  const helper = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
  const reader = helper.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    const descendants: number[] = [];
    function collect(pid: number) {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      for (const child of children ? children.split(/\s+/).map(Number) : []) { descendants.push(child); collect(child); }
    }
    collect(helper.pid); expect(descendants.length).toBeGreaterThan(0);
    helper.kill("SIGKILL"); await helper.exited;
    const active = (pid: number) => {
      try { return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
    };
    for (let i = 0; i < 100 && descendants.some(active); i++) await Bun.sleep(10);
    expect(descendants.some(active)).toBe(false);
  } finally { helper.kill("SIGKILL"); await helper.exited; await reader.cancel(); }
}, 5000);
