"""Run the integration driver in a real controlling PTY, forwarding keyboard bytes."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


pid, terminal = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))


def stop(_signal, _frame):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        readable, _, _ = select.select([terminal, sys.stdin.fileno()], [], [], 0.2)
        if terminal in readable:
            try:
                output = os.read(terminal, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not output:
                break
            # A PTY has no terminal emulator to answer the cursor-position query.
            if b"\x1b[6n" in output:
                os.write(terminal, b"\x1b[1;1R")
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
        if sys.stdin.fileno() in readable:
            keys = os.read(sys.stdin.fileno(), 65536)
            if not keys:
                break
            os.write(terminal, keys)
finally:
    # Driver and native Pi share this process group. Clean both up even on timeout.
    try:
        os.killpg(pid, signal.SIGTERM)
        time.sleep(0.1)
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(terminal)
    os.waitpid(pid, 0)
