"""CPU calculation bootstrap. Only run inside the filesystem/network sandbox."""
import base64
import ctypes
import errno
import importlib.metadata
import itertools
import json
import math
import os
from pathlib import Path
import resource
import stat
import sys
import threading
import traceback

PACKAGES = ("numpy", "scipy", "sympy", "pandas", "matplotlib", "scikit-learn", "statsmodels")
STREAM_LIMIT = 256 * 1024
VALUE_LIMIT = 1024 * 1024
ARTIFACT_LIMIT = 5 * 1024 * 1024
MIMES = {".png": "image/png", ".svg": "image/svg+xml", ".csv": "text/csv", ".json": "application/json"}
WIRE = os.dup(1)
WIRE_LOCK = threading.Lock()


class ArtifactLimitError(Exception):
    pass


def emit(value):
    data = (json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n").encode()
    with WIRE_LOCK:
        while data:
            data = data[os.write(WIRE, data):]


class Capture:
    def __init__(self, fd):
        self.data = bytearray()
        self.truncated = False
        read_fd, write_fd = os.pipe()
        os.dup2(write_fd, fd)
        os.close(write_fd)

        def drain():
            try:
                while True:
                    part = os.read(read_fd, 65536)
                    if not part:
                        return
                    remaining = max(0, STREAM_LIMIT - len(self.data))
                    self.data.extend(part[:remaining])
                    self.truncated |= len(part) > remaining
            finally:
                os.close(read_fd)

        self.thread = threading.Thread(target=drain, daemon=True)
        self.thread.start()

    def finish(self):
        self.thread.join(0.5)
        text = bytes(self.data).decode("utf-8", errors="replace").encode()
        self.truncated |= len(text) > STREAM_LIMIT
        return text[:STREAM_LIMIT].decode("utf-8", errors="ignore")


def restrict(timeout):
    # Hard limits cannot be raised again by submitted Python. No child processes or
    # new threads are allowed after bootstrap, so AS/CPU limits cover user work.
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (timeout + 1, timeout + 1))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024**2, 128 * 1024**2))
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise RuntimeError("sandbox setup failed")
    lib = ctypes.CDLL("libseccomp.so.2")
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_attr_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not ctx:
        raise RuntimeError("sandbox setup failed")
    try:
        # TSYNC also applies the restrictions to the already-created capture threads.
        if lib.seccomp_attr_set(ctx, 4, 1) != 0:
            raise RuntimeError("sandbox setup failed")
        for name in (
            "fork", "vfork", "clone", "clone3", "execve", "execveat", "unshare", "setns",
            "ptrace", "process_vm_readv", "process_vm_writev", "pidfd_open", "pidfd_getfd",
            "pidfd_send_signal", "kill", "tkill", "tgkill", "kcmp", "process_madvise",
            "socket", "socketpair", "mount", "umount2", "pivot_root", "chroot",
            "bpf", "perf_event_open", "userfaultfd", "io_uring_setup", "open_by_handle_at",
            "sched_setaffinity", "setpgid", "setsid", "seccomp",
            # Persistent kernel memory is not covered by RLIMIT_AS or /work's quota.
            "memfd_create", "memfd_secret", "shmget", "shmat", "shmdt", "shmctl",
            "semget", "semop", "semtimedop", "semctl", "msgget", "msgsnd", "msgrcv", "msgctl",
            "mq_open", "mq_unlink", "mq_timedsend", "mq_timedreceive", "mq_notify", "mq_getsetattr",
            "inotify_init", "inotify_init1", "inotify_add_watch", "inotify_rm_watch",
            # Do not inherit the host user's keyring or queue signals to other tasks.
            "add_key", "request_key", "keyctl", "rt_sigqueueinfo", "rt_tgsigqueueinfo",
        ):
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError("sandbox setup failed")
        if lib.seccomp_load(ctx) != 0:
            raise RuntimeError("sandbox setup failed")
    finally:
        lib.seccomp_release(ctx)


def json_value(value, depth=0, budget=None):
    if budget is None:
        budget = [20000]
    budget[0] -= 1
    if depth > 24 or budget[0] < 0:
        raise OverflowError("result structure exceeds limit")
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= 9007199254740991 else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [json_value(item, depth + 1, budget) for item in value]
    if isinstance(value, dict):
        return {str(key): json_value(item, depth + 1, budget) for key, item in value.items()}
    module = type(value).__module__.split(".")[0]
    if module == "numpy":
        if getattr(value, "size", 1) > 20000:
            raise OverflowError("array exceeds result limit")
        return json_value(value.tolist(), depth + 1, budget)
    if module == "pandas":
        if getattr(value, "size", 1) > 20000:
            raise OverflowError("table exceeds result limit")
        return json_value(value.to_dict(orient="records") if value.ndim == 2 else value.to_list(), depth + 1, budget)
    return repr(value)[:8192]


def collect_artifacts():
    root = Path("/work/artifacts")
    paths = list(itertools.islice(root.iterdir(), 11))
    pyplot = sys.modules.get("matplotlib.pyplot")
    figures = pyplot.get_fignums() if pyplot else []
    if len(paths) + len(figures) > 10:
        raise ArtifactLimitError("too many artifacts")
    if pyplot:
        for number in figures:
            target = root / ("figure-%s.png" % number)
            suffix = 1
            while target.exists():
                target = root / ("figure-%s-%s.png" % (number, suffix))
                suffix += 1
            pyplot.figure(number).savefig(target, format="png")
    paths = list(itertools.islice(root.iterdir(), 11))
    if len(paths) > 10:
        raise ArtifactLimitError("too many artifacts")
    for path in sorted(paths):
        mime = MIMES.get(path.suffix.lower())
        if not mime or len(path.name) > 128 or path.is_symlink() or path.resolve().parent != root:
            raise ValueError("unsupported artifact")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > ARTIFACT_LIMIT:
                raise ArtifactLimitError("artifact exceeds limit")
            data = os.read(fd, ARTIFACT_LIMIT + 1)
            if len(data) > ARTIFACT_LIMIT:
                raise ArtifactLimitError("artifact exceeds limit")
        finally:
            os.close(fd)
        emit({"kind": "artifact", "name": path.name, "mime": mime, "data": base64.b64encode(data).decode("ascii")})


def main():
    # Threads inherit affinity at creation; constrain before the capture threads.
    allowed = os.sched_getaffinity(0)
    os.sched_setaffinity(0, {max(allowed)})
    if sys.argv[1:] == ["--environment"]:
        restrict(10)
        emit({"kind": "environment", "python": sys.version.split()[0],
              "packages": [{"name": name, "version": importlib.metadata.version(name)} for name in PACKAGES]})
        return
    request = json.loads(sys.stdin.buffer.read(2 * 1024 * 1024 + 1))
    Path("/work/artifacts").mkdir()
    Path("/work/tmp").mkdir()
    stdout, stderr = Capture(1), Capture(2)
    sys.stdout.reconfigure(line_buffering=True, write_through=True)
    sys.stderr.reconfigure(line_buffering=True, write_through=True)
    try:
        restrict(request["timeoutSec"])
    except BaseException:
        emit({"kind": "error", "code": "unavailable", "message": "CPU sandbox setup failed"})
        return
    emit({"kind": "ready"})

    def report(message, ratio=None):
        message = str(message).encode()[:1024].decode("utf-8", errors="ignore")
        progress = {"message": message}
        if ratio is not None:
            if not isinstance(ratio, (int, float)) or not math.isfinite(ratio) or not 0 <= ratio <= 1:
                raise ValueError("progress ratio must be between zero and one")
            progress["ratio"] = ratio
        emit({"kind": "progress", **progress})

    try:
        scope = {"__name__": "__main__", "inputs": request["inputs"], "report": report}
        exec(compile(request["code"], "<compute>", "exec"), scope)
        emit({"kind": "collecting"})
        value = json_value(scope.get("result"))
        if len(json.dumps(value, ensure_ascii=True).encode()) > VALUE_LIMIT:
            raise OverflowError("result exceeds byte limit")
        collect_artifacts()
        sys.stdout.flush()
        sys.stderr.flush()
        null_fd = os.open("/dev/null", os.O_WRONLY)
        os.dup2(null_fd, 1)
        os.dup2(null_fd, 2)
        os.close(null_fd)
        emit({"kind": "result", "value": value, "stdout": stdout.finish(), "stderr": stderr.finish(),
              "stdoutTruncated": stdout.truncated, "stderrTruncated": stderr.truncated})
    except BaseException as error:
        code = "syntax_error" if isinstance(error, SyntaxError) else "memory_exceeded" if isinstance(error, MemoryError) else "limit_exceeded" if isinstance(error, ArtifactLimitError) else "output_exceeded" if isinstance(error, OverflowError) else "runtime_error"
        message = traceback.format_exc().encode()[-8192:].decode("utf-8", errors="ignore")
        emit({"kind": "error", "code": code, "message": message})


if __name__ == "__main__":
    main()
