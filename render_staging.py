"""Private render scratch with process leases and restart recovery."""
import os
from pathlib import Path
import re
import shutil
import stat
import uuid


_MARKER = ".otamatik-render-v1"
_MAGIC = b"Otamatik Edit render staging v1\n"
_STAGE_NAME = re.compile(r"\.render-[0-9a-f]{32}\Z")


def _lock(file, *, wait=False):
    if os.name == "nt":
        import msvcrt
        file.seek(0)
        mode = msvcrt.LK_LOCK if wait else msvcrt.LK_NBLCK
        # Windows locks may extend past EOF. The first byte serves as the
        # lease while the rest of the file identifies Otamatik Edit's scratch.
        msvcrt.locking(file.fileno(), mode, 1)
    else:
        import fcntl
        fcntl.flock(file, fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB)


def _is_plain(path, kind):
    info = path.lstat()
    return kind(info.st_mode) and not (
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def _windows_process_running(pid):
    # os.kill(pid, 0) is TerminateProcess on Windows. Use a read-only handle.
    import ctypes
    from ctypes.wintypes import BOOL, DWORD, HANDLE
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (DWORD, BOOL, DWORD)
    kernel.OpenProcess.restype = HANDLE
    kernel.WaitForSingleObject.argtypes = (HANDLE, DWORD)
    kernel.WaitForSingleObject.restype = DWORD
    kernel.CloseHandle.argtypes = (HANDLE,)
    kernel.CloseHandle.restype = BOOL
    handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: no PID
    try:
        return kernel.WaitForSingleObject(handle, 0) != 0  # WAIT_OBJECT_0: exited
    finally:
        kernel.CloseHandle(handle)


class RenderStaging:
    def __init__(self, output_dir):
        self.path = Path(output_dir) / f".render-{uuid.uuid4().hex}"
        self.path.mkdir(mode=0o700)
        self.lease = None
        try:
            self.lease = (self.path / _MARKER).open("x+b", buffering=0)
            _lock(self.lease, wait=True)
            self.lease.write(_MAGIC)
        except BaseException:
            self.cleanup()
            raise

    def child_options(self):
        # Share the same flock with FFmpeg. If the source server is killed
        # without its subprocess, the child still owns the Unix lease.
        return {} if os.name == "nt" else {"pass_fds": (self.lease.fileno(),)}

    def _record(self, value):
        self.lease.seek(len(_MAGIC))
        self.lease.write(value)
        self.lease.truncate()

    def note_spawn(self):
        if os.name == "nt":
            # If the OS kills our parent in CreateProcess, the child's PID
            # is not yet known. Keep that ambiguous stage rather than erase it.
            self._record(b"starting\n")

    def note_child(self, process):
        if os.name == "nt" and (pid := getattr(process, "pid", None)):
            self._record(f"{pid:010d}\n".encode("ascii"))

    def cleanup(self):
        try:
            if self.lease is not None:
                self.lease.close()
        finally:
            shutil.rmtree(self.path, ignore_errors=True)


def cleanup_abandoned_stages(output_dir):
    for stage in Path(output_dir).glob(".render-*"):
        if not _STAGE_NAME.fullmatch(stage.name):
            continue
        marker = stage / _MARKER
        try:
            if not _is_plain(stage, stat.S_ISDIR) or not _is_plain(marker, stat.S_ISREG):
                continue
            with marker.open("r+b", buffering=0) as lease:
                _lock(lease)
                if lease.read(len(_MAGIC)) != _MAGIC:
                    continue
                child = lease.read(16)
                if child:
                    if not re.fullmatch(rb"[0-9]{10}\n", child) or not 0 < int(child) <= 0xFFFFFFFF or os.name != "nt":
                        continue
                    if _windows_process_running(int(child)):
                        continue
            # Reopening processes never adopt an existing stage. Once its
            # initialized lease is available there is no producer left.
            shutil.rmtree(stage, ignore_errors=True)
        except OSError:
            # Active lease, another cleaner won the race, or an unreadable
            # directory. None of these authorizes removing anything else.
            continue
