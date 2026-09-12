#!/usr/bin/env python3
"""Closed Darwin process observer for the Monterey process-owner backend.

This helper intentionally exposes no shell, ps, generic sysctl, environment,
or argv operation.  It is invoked by its JavaScript wrapper as an isolated
Python program and writes exactly one JSON object to stdout.
"""

import ctypes
import errno
import json
import os
import struct
import sys

SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 8192
MAX_PID_SCAN = 131072
MAX_PROCARGS_BYTES = 4 * 1024 * 1024
MAX_ARGC = 4096
MAX_PATH_BYTES = 4096
RESERVATION_NAME = b"AUTOPROMPT_OWNERSHIP_RESERVATION="

# xnu-8019.80.24 bsd/sys/proc_info.h
PROC_PIDTBSDINFO = 3
PROC_PIDPATHINFO_MAXSIZE = 4 * 1024
PROC_UID_ONLY = 4

# xnu-8019.80.24 bsd/sys/sysctl.h
CTL_KERN = 1
KERN_PROCARGS2 = 49


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32),
        ("status", ctypes.c_uint32),
        ("xstatus", ctypes.c_uint32),
        ("pid", ctypes.c_uint32),
        ("ppid", ctypes.c_uint32),
        ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32),
        ("ruid", ctypes.c_uint32),
        ("rgid", ctypes.c_uint32),
        ("svuid", ctypes.c_uint32),
        ("svgid", ctypes.c_uint32),
        ("reserved", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16),
        ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32),
        ("pgid", ctypes.c_uint32),
        ("pjobc", ctypes.c_uint32),
        ("tdev", ctypes.c_uint32),
        ("tpgid", ctypes.c_uint32),
        ("nice", ctypes.c_int32),
        ("start_sec", ctypes.c_uint64),
        ("start_usec", ctypes.c_uint64),
    ]


if ctypes.sizeof(ProcBsdInfo) != 136:
    raise RuntimeError("unexpected proc_bsdinfo layout")


class UnknownProcess(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class InvalidRequest(Exception):
    pass


def output(value):
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def unknown(reason):
    return {"schemaVersion": SCHEMA_VERSION, "status": "UNKNOWN", "reason": reason}


def dead(pid):
    return {"schemaVersion": SCHEMA_VERSION, "status": "DEAD", "pid": pid}


def checked_text(value, field, limit=2048):
    if not isinstance(value, str) or not value or len(value) > limit:
        raise InvalidRequest("invalid " + field)
    if "\x00" in value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise InvalidRequest("invalid " + field)
    return value


def checked_pid(value):
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 0x7fffffff:
        raise InvalidRequest("invalid pid")
    return value


def read_request():
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not raw or len(raw) > MAX_REQUEST_BYTES or raw.count(b"\n") > 1:
        raise InvalidRequest("request must be one bounded JSON object")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InvalidRequest("request is not JSON") from error
    if not isinstance(value, dict):
        raise InvalidRequest("request is not an object")
    return value


def parse_procargs2(payload, reservation):
    """Return whether one exact reservation entry occurs in a complete image.

    KERN_PROCARGS2 begins with native-endian argc, then executable bytes,
    NUL padding, argc argv strings, further NUL padding, and environment
    entries.  Any truncation or malformed segment is not absence evidence.
    """
    if not isinstance(payload, (bytes, bytearray)) or len(payload) < 5:
        raise UnknownProcess("PROCARGS_MALFORMED")
    argc = struct.unpack_from("@i", payload, 0)[0]
    if argc < 0 or argc > MAX_ARGC:
        raise UnknownProcess("PROCARGS_MALFORMED")
    offset = 4
    try:
        executable_end = payload.index(0, offset)
    except ValueError as error:
        raise UnknownProcess("PROCARGS_TRUNCATED") from error
    if executable_end == offset or executable_end - offset > MAX_PATH_BYTES:
        raise UnknownProcess("PROCARGS_MALFORMED")
    try:
        payload[offset:executable_end].decode("utf-8")
    except UnicodeDecodeError as error:
        raise UnknownProcess("PROCARGS_MALFORMED") from error
    offset = executable_end + 1
    while offset < len(payload) and payload[offset] == 0:
        offset += 1
    for _ in range(argc):
        try:
            argument_end = payload.index(0, offset)
        except ValueError as error:
            raise UnknownProcess("PROCARGS_TRUNCATED") from error
        # Empty argv elements are valid.  In particular, a launched program
        # can intentionally carry an empty non-first argument; the NUL still
        # advances the bounded parser and does not create absence evidence.
        offset = argument_end + 1
    while offset < len(payload) and payload[offset] == 0:
        offset += 1
    # A KERN_PROCARGS2 image ending at argv is not proof that the environment
    # is empty: restricted processes can expose argv while redacting envp.
    # Refuse to turn that visibility failure into absence evidence.
    if offset == len(payload):
        raise UnknownProcess("PROCARGS_ENV_UNAVAILABLE")
    exact = RESERVATION_NAME + reservation.encode("utf-8")
    found = False
    while offset < len(payload):
        while offset < len(payload) and payload[offset] == 0:
            offset += 1
        if offset == len(payload):
            break
        try:
            entry_end = payload.index(0, offset)
        except ValueError as error:
            raise UnknownProcess("PROCARGS_TRUNCATED") from error
        entry = payload[offset:entry_end]
        if not entry or b"=" not in entry:
            raise UnknownProcess("PROCARGS_MALFORMED")
        try:
            entry.decode("utf-8")
        except UnicodeDecodeError as error:
            raise UnknownProcess("PROCARGS_MALFORMED") from error
        found = found or entry == exact
        offset = entry_end + 1
    return found


class DarwinProc:
    def __init__(self):
        if sys.platform != "darwin":
            raise UnknownProcess("DARWIN_UNAVAILABLE")
        try:
            self.proc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            self.system = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        except OSError as error:
            raise UnknownProcess("DARWIN_LIBPROC_UNAVAILABLE") from error
        self.proc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.proc.proc_pidinfo.restype = ctypes.c_int
        self.proc.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.proc.proc_pidpath.restype = ctypes.c_int
        self.proc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self.proc.proc_listpids.restype = ctypes.c_int
        self.system.sysctlbyname.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        self.system.sysctlbyname.restype = ctypes.c_int
        self.system.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        self.system.sysctl.restype = ctypes.c_int

    @staticmethod
    def errno_reason(prefix):
        return prefix + "_" + (errno.errorcode.get(ctypes.get_errno(), "FAILED"))

    def boot_session_uuid(self):
        size = ctypes.c_size_t(0)
        ctypes.set_errno(0)
        if self.system.sysctlbyname(b"kern.bootsessionuuid", None, ctypes.byref(size), None, 0) != 0 or size.value < 2 or size.value > 128:
            raise UnknownProcess(self.errno_reason("BOOT_SESSION"))
        value = ctypes.create_string_buffer(size.value)
        ctypes.set_errno(0)
        if self.system.sysctlbyname(b"kern.bootsessionuuid", value, ctypes.byref(size), None, 0) != 0:
            raise UnknownProcess(self.errno_reason("BOOT_SESSION"))
        try:
            text = value.raw[:size.value].split(b"\0", 1)[0].decode("ascii").lower()
        except UnicodeDecodeError as error:
            raise UnknownProcess("BOOT_SESSION_MALFORMED") from error
        if len(text) != 36 or any(character not in "0123456789abcdef-" for character in text):
            raise UnknownProcess("BOOT_SESSION_MALFORMED")
        return text

    def bsd_info(self, pid):
        info = ProcBsdInfo()
        ctypes.set_errno(0)
        received = self.proc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
        if received == 0:
            if ctypes.get_errno() in (errno.ESRCH, errno.ENOENT):
                return None
            raise UnknownProcess(self.errno_reason("PIDINFO"))
        if received != ctypes.sizeof(info) or info.pid != pid:
            raise UnknownProcess("PIDINFO_MALFORMED")
        return info

    def process_path(self, pid):
        value = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
        ctypes.set_errno(0)
        length = self.proc.proc_pidpath(pid, value, len(value))
        if length <= 0 or length >= len(value):
            raise UnknownProcess(self.errno_reason("PIDPATH"))
        raw = value.raw[:length]
        if b"\0" in raw:
            raw = raw.split(b"\0", 1)[0]
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise UnknownProcess("PIDPATH_MALFORMED") from error
        if not text.startswith("/") or "\x00" in text or "\n" in text or "\r" in text:
            raise UnknownProcess("PIDPATH_MALFORMED")
        return text

    def procargs(self, pid):
        argmax = ctypes.c_int(0)
        size = ctypes.c_size_t(ctypes.sizeof(argmax))
        ctypes.set_errno(0)
        if self.system.sysctlbyname(b"kern.argmax", ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
            raise UnknownProcess(self.errno_reason("PROCARGS"))
        if argmax.value < 4096 or argmax.value > MAX_PROCARGS_BYTES:
            raise UnknownProcess("PROCARGS_SIZE_UNSUPPORTED")
        payload = ctypes.create_string_buffer(argmax.value)
        actual = ctypes.c_size_t(argmax.value)
        mib = (ctypes.c_int * 3)(CTL_KERN, KERN_PROCARGS2, pid)
        ctypes.set_errno(0)
        if self.system.sysctl(mib, 3, payload, ctypes.byref(actual), None, 0) != 0:
            raise UnknownProcess(self.errno_reason("PROCARGS"))
        if actual.value < 5 or actual.value > argmax.value:
            raise UnknownProcess("PROCARGS_TRUNCATED")
        return payload.raw[:actual.value]

    def observe_from_bsd(self, pid, info):
        boot = self.boot_session_uuid()
        executable = self.process_path(pid)
        after = self.bsd_info(pid)
        if after is None:
            return dead(pid)
        if (info.pid, info.ppid, info.uid, info.pgid, info.start_sec, info.start_usec) != (after.pid, after.ppid, after.uid, after.pgid, after.start_sec, after.start_usec):
            raise UnknownProcess("PID_CHANGED_DURING_OBSERVATION")
        return {
            "schemaVersion": SCHEMA_VERSION,
            "status": "LIVE",
            "pid": pid,
            "ppid": int(info.ppid),
            "uid": int(info.uid),
            "pgid": int(info.pgid),
            "startSec": int(info.start_sec),
            "startUsec": int(info.start_usec),
            "bootSessionUuid": boot,
            "executablePath": executable,
        }

    def observe(self, pid):
        info = self.bsd_info(pid)
        if info is None:
            return dead(pid)
        return self.observe_from_bsd(pid, info)

    def pids(self):
        # proc_listpids returns a byte count (unlike proc_listallpids, which
        # returns a PID count). Select target effective UIDs equal to the
        # caller's real UID before any pidinfo/procargs query. This remains
        # OBSERVED-only and does not establish a domain across UID changes.
        # An opaque foreign process must not make an
        # otherwise-owned reservation observation UNKNOWN.
        uid = os.getuid()
        for capacity in (1024, 4096, 16384, 65536, MAX_PID_SCAN):
            values = (ctypes.c_int * capacity)()
            ctypes.set_errno(0)
            received = self.proc.proc_listpids(PROC_UID_ONLY, uid, values, ctypes.sizeof(values))
            if received < 0:
                raise UnknownProcess(self.errno_reason("PIDLIST"))
            if received == 0:
                raise UnknownProcess("PIDLIST_EMPTY")
            if received % ctypes.sizeof(ctypes.c_int) != 0:
                raise UnknownProcess("PIDLIST_MALFORMED")
            count = received // ctypes.sizeof(ctypes.c_int)
            if count > capacity:
                raise UnknownProcess("PIDLIST_MALFORMED")
            if count < capacity:
                return sorted({int(values[index]) for index in range(count) if values[index] > 0})
        raise UnknownProcess("PIDLIST_GREW")

    def find_reservation(self, reservation):
        current_uid = os.getuid()
        matches = []
        for pid in self.pids():
            # Filter by the cheap, non-path BSD structure before touching the
            # more privileged proc_pidpath or procargs visibility interfaces.
            initial = self.bsd_info(pid)
            if initial is None:
                continue
            if initial.uid != current_uid:
                continue
            before = self.observe_from_bsd(pid, initial)
            try:
                present = parse_procargs2(self.procargs(pid), reservation)
            except UnknownProcess:
                raise
            after = self.observe(pid)
            if after["status"] == "DEAD":
                continue
            fields = ("pid", "ppid", "uid", "pgid", "startSec", "startUsec", "bootSessionUuid", "executablePath")
            if any(before[field] != after[field] for field in fields):
                raise UnknownProcess("PID_CHANGED_DURING_RESERVATION_CAPTURE")
            if present:
                matches.append(after)
        # A scan is an observation only.  A fork/exit between listallpids and
        # capture can otherwise make an empty result look like a durable proof
        # that the reservation is absent.
        return {"schemaVersion": SCHEMA_VERSION, "status": "OBSERVED", "matches": matches}


def handle(request):
    expected = {"schemaVersion", "operation", "pid"}
    if request.get("schemaVersion") != SCHEMA_VERSION or request.get("operation") not in ("observe", "find-reservation"):
        raise InvalidRequest("unknown operation")
    operation = request["operation"]
    if operation == "observe":
        if set(request) != expected:
            raise InvalidRequest("observe request fields")
        pid = checked_pid(request["pid"])
        observer = DarwinProc()
        return observer.observe(pid)
    if set(request) != {"schemaVersion", "operation", "reservation"}:
        raise InvalidRequest("reservation request fields")
    reservation = checked_text(request["reservation"], "reservation")
    observer = DarwinProc()
    return observer.find_reservation(reservation)


def main():
    if len(sys.argv) != 2 or sys.argv[1] != "--request":
        raise InvalidRequest("only --request is supported")
    return handle(read_request())


if __name__ == "__main__":
    try:
        output(main())
    except UnknownProcess as error:
        output(unknown(error.reason))
    except InvalidRequest:
        output(unknown("REQUEST_INVALID"))
    except Exception:
        output(unknown("OBSERVER_FAILURE"))
