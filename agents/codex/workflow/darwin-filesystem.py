#!/usr/bin/env python3
"""Descriptor-relative capture and mutation primitive for Darwin validation.

One closed request, one bounded metadata response. File bytes go only to the
controller's inherited regular-file descriptor 3. No descriptor pathname is
returned to JavaScript. The caller applies the existing Node sort/hash format.
The same POSIX primitive is testable on Linux; this is not platform admission.
"""
import json
import os
import stat
import sys
import base64
import ctypes
import errno

MAX_REQUEST = 16384
MAX_ENTRIES = 16384
MAX_BYTES = 1024 * 1024 * 1024
MAX_DEPTH = 128
MAX_METADATA = 8 * 1024 * 1024
CHUNK = 1024 * 1024
MAX_RECORD_BYTES = 8192
MAX_PUBLICATION_BYTES = 8 * 1024 * 1024 + 1
MAX_PUBLICATION_REQUEST = 12 * 1024 * 1024
RENAME_EXCL = 0x00000004


class CaptureError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="PREIMAGE_UNSAFE"):
    if not condition:
        raise CaptureError(code)


def identity(item):
    return (item.st_dev, item.st_ino, item.st_mode, item.st_nlink,
            item.st_size, item.st_mtime_ns, item.st_ctime_ns)


def physical_identity(item):
    return (item.st_dev, item.st_ino, stat.S_IFMT(item.st_mode))


def directory_flags():
    require(hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW"),
            "FILESYSTEM_BACKEND_UNAVAILABLE")
    require(os.open in os.supports_dir_fd and os.stat in os.supports_dir_fd
            and os.stat in os.supports_follow_symlinks
            and os.listdir in os.supports_fd, "FILESYSTEM_BACKEND_UNAVAILABLE")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def canonical_path(value):
    require(isinstance(value, str) and value.startswith("/")
            and "\0" not in value and os.path.normpath(value) == value
            and not value.startswith("//"), "FILESYSTEM_REQUEST_INVALID")
    # Surrogate filenames cannot be represented by the existing UTF-8 Node
    # manifest without changing its digest. Refuse them, never replace bytes.
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        raise CaptureError("FILESYSTEM_REQUEST_INVALID") from None
    return value


def components(value):
    require(isinstance(value, list) and 1 <= len(value) <= MAX_DEPTH,
            "FILESYSTEM_REQUEST_INVALID")
    result = []
    for component in value:
        require(isinstance(component, str) and component not in ("", ".", "..")
                and "/" not in component and "\0" not in component,
                "FILESYSTEM_REQUEST_INVALID")
        try:
            component.encode("utf-8", "strict")
        except UnicodeError:
            raise CaptureError("FILESYSTEM_REQUEST_INVALID") from None
        result.append(component)
    return result


def record_bytes(value, maximum=MAX_RECORD_BYTES):
    require(isinstance(value, str) and len(value) <= ((maximum + 2) // 3) * 4,
            "FILESYSTEM_REQUEST_INVALID")
    try:
        decoded = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeError, ValueError):
        raise CaptureError("FILESYSTEM_REQUEST_INVALID") from None
    require(len(decoded) <= maximum and
            base64.b64encode(decoded).decode("ascii") == value,
            "FILESYSTEM_REQUEST_INVALID")
    return decoded


class Lineage:
    """Keep every ancestor open until the capture has been verified."""
    def __init__(self, absolute):
        self.absolute = absolute
        self.items = []
        flags = directory_flags()
        try:
            before = os.stat("/", follow_symlinks=False)
            descriptor = os.open("/", flags)
            self.items.append(("/", descriptor, os.fstat(descriptor)))
            require(physical_identity(before) == physical_identity(self.items[-1][2]))
            for name in absolute.split("/")[1:]:
                if not name:
                    continue
                parent = self.items[-1][1]
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                require(stat.S_ISDIR(before.st_mode))
                descriptor = os.open(name, flags, dir_fd=parent)
                opened = os.fstat(descriptor)
                self.items.append((name, descriptor, opened))
                require(physical_identity(before) == physical_identity(opened))
        except BaseException:
            self.close()
            raise

    @property
    def descriptor(self):
        return self.items[-1][1]

    def verify(self):
        for index, (name, descriptor, opened) in enumerate(self.items):
            require(physical_identity(opened) == physical_identity(os.fstat(descriptor)))
            live = os.stat("/", follow_symlinks=False) if index == 0 else os.stat(
                name, dir_fd=self.items[index - 1][1], follow_symlinks=False)
            require(physical_identity(opened) == physical_identity(live))

    def close(self):
        for _, descriptor, _ in reversed(self.items):
            os.close(descriptor)
        self.items = []


def open_parent(root, parts):
    lineage = Lineage(root)
    try:
        flags = directory_flags()
        for name in parts[:-1]:
            parent = lineage.descriptor
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(stat.S_ISDIR(before.st_mode))
            descriptor = os.open(name, flags, dir_fd=parent)
            opened = os.fstat(descriptor)
            lineage.items.append((name, descriptor, opened))
            require(physical_identity(before) == physical_identity(opened))
        return lineage, parts[-1]
    except BaseException:
        lineage.close()
        raise


def fsync_directory(descriptor):
    try:
        os.fsync(descriptor)
    except OSError:
        raise CaptureError("FILESYSTEM_BACKEND_UNAVAILABLE") from None


def read_exact(descriptor, size, maximum=MAX_RECORD_BYTES):
    require(0 <= size <= maximum, "FILESYSTEM_CAPTURE_LIMIT")
    chunks = []
    position = 0
    while position < size:
        data = os.pread(descriptor, min(CHUNK, size - position), position)
        require(bool(data), "PREIMAGE_UNSAFE")
        chunks.append(data)
        position += len(data)
    require(not os.pread(descriptor, 1, position), "PREIMAGE_UNSAFE")
    return b"".join(chunks)


def rename_exclusive(source_fd, source_name, target_fd, target_name):
    require(sys.platform == "darwin", "FILESYSTEM_BACKEND_UNAVAILABLE")
    try:
        function = ctypes.CDLL(None, use_errno=True).renameatx_np
    except AttributeError:
        raise CaptureError("FILESYSTEM_BACKEND_UNAVAILABLE") from None
    function.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int,
                         ctypes.c_char_p, ctypes.c_uint)
    function.restype = ctypes.c_int
    if function(source_fd, source_name.encode("utf-8"), target_fd,
                target_name.encode("utf-8"), RENAME_EXCL) != 0:
        # EEXIST and EXDEV are both closed refusals; unsupported flags and all
        # other native failures never permit a replacing fallback.
        raise OSError(ctypes.get_errno(), "renameatx_np failed")


def metadata(item):
    return {"dev": str(item.st_dev), "ino": str(item.st_ino),
            "mode": item.st_mode, "nlink": item.st_nlink, "size": item.st_size,
            "mtimeNs": str(item.st_mtime_ns), "ctimeNs": str(item.st_ctime_ns)}


class Capture:
    def __init__(self, spool):
        self.spool = spool
        self.entries = []
        self.captured_stats = {}
        self.captured_entries = {}
        self.offset = 0
        self.metadata_bytes = 0
        self.spool_before = os.fstat(spool)
        require(stat.S_ISREG(self.spool_before.st_mode)
                and self.spool_before.st_nlink == 1 and self.spool_before.st_size == 0
                and self.spool_before.st_uid == os.getuid()
                and self.spool_before.st_mode & 0o077 == 0,
                "FILESYSTEM_SPOOL_INVALID")
        require(os.lseek(spool, 0, os.SEEK_CUR) == 0, "FILESYSTEM_SPOOL_INVALID")

    def entry(self, value):
        require(len(self.entries) < MAX_ENTRIES, "FILESYSTEM_CAPTURE_LIMIT")
        self.metadata_bytes += len(json.dumps(value, ensure_ascii=True, separators=(",", ":"))) + 1
        require(self.metadata_bytes <= MAX_METADATA, "FILESYSTEM_CAPTURE_LIMIT")
        self.entries.append(value)
        self.captured_stats[value["path"]] = value["stat"]
        self.captured_entries[value["path"]] = value

    def file(self, parent, name, relative, before):
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1)
        require(0 <= before.st_size <= MAX_BYTES - self.offset,
                "FILESYSTEM_CAPTURE_LIMIT")
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=parent)
        try:
            opened = os.fstat(descriptor)
            require(identity(before) == identity(opened))
            require(physical_identity(opened) != physical_identity(self.spool_before),
                    "FILESYSTEM_SPOOL_INVALID")
            start = self.offset
            while self.offset - start < opened.st_size:
                data = os.read(descriptor, min(CHUNK, opened.st_size - self.offset + start))
                require(bool(data))
                view = memoryview(data)
                while view:
                    written = os.write(self.spool, view)
                    require(written > 0, "FILESYSTEM_SPOOL_INVALID")
                    view = view[written:]
                self.offset += len(data)
            require(not os.read(descriptor, 1))
            after = os.fstat(descriptor)
            live = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require(identity(opened) == identity(after) == identity(live))
            self.entry({"type": "file", "path": relative, "stat": metadata(after),
                        "offset": start, "length": self.offset - start})
        finally:
            os.close(descriptor)

    def directory(self, parent, name, relative, before, depth):
        require(depth <= MAX_DEPTH, "FILESYSTEM_CAPTURE_LIMIT")
        require(stat.S_ISDIR(before.st_mode))
        descriptor = os.open(name, directory_flags(), dir_fd=parent)
        try:
            opened = os.fstat(descriptor)
            require(identity(before) == identity(opened))
            self.entry({"type": "directory", "path": relative, "stat": metadata(opened)})
            names = os.listdir(descriptor)
            require(len(names) <= MAX_ENTRIES - len(self.entries), "FILESYSTEM_CAPTURE_LIMIT")
            for child in names:
                require(child not in ("", ".", "..") and "/" not in child and "\0" not in child)
                try:
                    child.encode("utf-8", "strict")
                except UnicodeError:
                    raise CaptureError("PREIMAGE_UNSAFE") from None
                child_stat = os.stat(child, dir_fd=descriptor, follow_symlinks=False)
                child_path = relative + "/" + child if relative else child
                if stat.S_ISDIR(child_stat.st_mode):
                    self.directory(descriptor, child, child_path, child_stat, depth + 1)
                else:
                    self.file(descriptor, child, child_path, child_stat)
            require(identity(opened) == identity(os.fstat(descriptor))
                    == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
        finally:
            os.close(descriptor)

    def finish(self):
        after = os.fstat(self.spool)
        require(physical_identity(after) == physical_identity(self.spool_before)
                and after.st_nlink == 1 and after.st_size == self.offset
                and after.st_mode == self.spool_before.st_mode,
                "FILESYSTEM_SPOOL_INVALID")
        os.fsync(self.spool)

    def verify_captured(self, parent, name, relative="", depth=0):
        # This entire second pass starts after every byte was captured. Local
        # before/after checks alone would accept old A + new B when A changed
        # while B was being read: editing A does not update its parent's mtime.
        require(depth <= MAX_DEPTH, "FILESYSTEM_CAPTURE_LIMIT")
        live = os.stat(name, dir_fd=parent, follow_symlinks=False)
        expected = self.captured_stats.get(relative)
        require(expected is not None and metadata(live) == expected)
        if stat.S_ISDIR(live.st_mode):
            descriptor = os.open(name, directory_flags(), dir_fd=parent)
            try:
                require(metadata(os.fstat(descriptor)) == expected)
                for child in os.listdir(descriptor):
                    child_path = relative + "/" + child if relative else child
                    self.verify_captured(descriptor, child, child_path, depth + 1)
                require(metadata(os.fstat(descriptor)) == expected
                        == metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)))
            finally:
                os.close(descriptor)
        else:
            # An already-dirty writable mmap can change bytes without another
            # metadata update. Compare actual bytes too. This detects that
            # race, but is not an atomic filesystem snapshot: production must
            # establish writer quiescence before authorizing a capture.
            require(stat.S_ISREG(live.st_mode) and live.st_nlink == 1)
            entry = self.captured_entries[relative]
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=parent)
            try:
                require(metadata(os.fstat(descriptor)) == expected)
                position = 0
                while position < entry["length"]:
                    data = os.read(descriptor, min(CHUNK, entry["length"] - position))
                    require(bool(data) and data == os.pread(self.spool, len(data), entry["offset"] + position))
                    position += len(data)
                require(not os.read(descriptor, 1))
                require(metadata(os.fstat(descriptor)) == expected
                        == metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)))
            finally:
                os.close(descriptor)


def run(request):
    require(isinstance(request, dict) and set(request) == {"schemaVersion", "operation", "path"}
            and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] in ("capture-file", "capture-tree"),
            "FILESYSTEM_REQUEST_INVALID")
    require(sys.platform in ("darwin", "linux"), "FILESYSTEM_BACKEND_UNAVAILABLE")
    absolute = canonical_path(request["path"])
    require(absolute != "/", "FILESYSTEM_REQUEST_INVALID")
    capture = Capture(3)
    lineage = Lineage(os.path.dirname(absolute))
    try:
        leaf = os.path.basename(absolute)
        try:
            before = os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            # Only absence of this final component under the verified held
            # parent is ENOENT. Missing/raced ancestors remain PREIMAGE_UNSAFE.
            lineage.verify()
            try:
                os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
            except FileNotFoundError:
                lineage.verify()
                raise CaptureError("FILESYSTEM_NOT_FOUND") from None
            raise CaptureError("PREIMAGE_UNSAFE") from None
        if request["operation"] == "capture-file":
            capture.file(lineage.descriptor, leaf, "", before)
        else:
            capture.directory(lineage.descriptor, leaf, "", before, 0)
        capture.verify_captured(lineage.descriptor, leaf)
        lineage.verify()
        capture.finish()
        return {"schemaVersion": 1, "status": "CAPTURED", "bytes": capture.offset,
                "entries": capture.entries}
    finally:
        lineage.close()


def write_record_exclusive(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "root", "components", "bytesBase64"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "write-record-exclusive",
            "FILESYSTEM_REQUEST_INVALID")
    root = canonical_path(request["root"])
    parts = components(request["components"])
    data = record_bytes(request["bytesBase64"])
    lineage, leaf = open_parent(root, parts)
    descriptor = None
    try:
        descriptor = os.open(leaf, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                             os.O_NOFOLLOW, 0o600, dir_fd=lineage.descriptor)
        opened = os.fstat(descriptor)
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and
                (opened.st_mode & 0o777) == 0o600 and opened.st_size == 0)
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            require(written > 0, "FILESYSTEM_BACKEND_UNAVAILABLE")
            view = view[written:]
        os.fsync(descriptor)
        after = os.fstat(descriptor)
        live = os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        require(identity(opened)[:4] == identity(after)[:4] == identity(live)[:4]
                and after.st_size == len(data) and live.st_size == len(data))
        require(read_exact(descriptor, len(data)) == data)
        final = os.fstat(descriptor)
        final_live = os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        require(metadata(after) == metadata(final) == metadata(final_live))
        fsync_directory(lineage.descriptor)
        lineage.verify()
        return {"schemaVersion": 1, "status": "CREATED", "stat": metadata(final)}
    finally:
        if descriptor is not None:
            os.close(descriptor)
        lineage.close()


def cleanup_target_identity(item):
    require((stat.S_ISDIR(item.st_mode) or stat.S_ISREG(item.st_mode)) and
            (not stat.S_ISREG(item.st_mode) or item.st_nlink == 1))
    return {"type": "directory" if stat.S_ISDIR(item.st_mode) else "file",
            "dev": str(item.st_dev), "ino": str(item.st_ino)}


def inspect_owned_target(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "root", "components"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "inspect-owned-target", "FILESYSTEM_REQUEST_INVALID")
    lineage, leaf = open_parent(canonical_path(request["root"]), components(request["components"]))
    try:
        parent = os.fstat(lineage.descriptor)
        try:
            target = os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            lineage.verify()
            raise CaptureError("FILESYSTEM_NOT_FOUND") from None
        identity_value = cleanup_target_identity(target)
        descriptor = os.open(leaf, directory_flags() if identity_value["type"] == "directory" else
                             os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=lineage.descriptor)
        try:
            require(metadata(target) == metadata(os.fstat(descriptor)) ==
                    metadata(os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)))
            lineage.verify()
            return {"schemaVersion": 1, "status": "INSPECTED",
                    "parentIdentity": {"dev": str(parent.st_dev), "ino": str(parent.st_ino)},
                    "targetIdentity": identity_value}
        finally:
            os.close(descriptor)
    finally:
        lineage.close()


def remove_owned_target(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "root", "components", "expectedParent", "expectedTarget"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "remove-owned-target", "FILESYSTEM_REQUEST_INVALID")
    expected_parent = request["expectedParent"]
    expected_target = request["expectedTarget"]
    require(isinstance(expected_parent, dict) and set(expected_parent) == {"dev", "ino"} and
            isinstance(expected_target, dict) and set(expected_target) == {"type", "dev", "ino"},
            "FILESYSTEM_REQUEST_INVALID")
    lineage, leaf = open_parent(canonical_path(request["root"]), components(request["components"]))
    inventory = {}
    def visit(parent, name, relative, depth, removing=False):
        require(depth <= MAX_DEPTH and len(inventory) <= MAX_ENTRIES, "FILESYSTEM_CAPTURE_LIMIT")
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        target = cleanup_target_identity(before)
        if removing:
            require(inventory.get(relative) == metadata(before))
        else:
            require(len(inventory) < MAX_ENTRIES, "FILESYSTEM_CAPTURE_LIMIT")
            inventory[relative] = metadata(before)
        descriptor = os.open(name, directory_flags() if target["type"] == "directory" else
                             os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            require(metadata(before) == metadata(os.fstat(descriptor)))
            if target["type"] == "directory":
                names = os.listdir(descriptor)
                require(len(names) <= MAX_ENTRIES, "FILESYSTEM_CAPTURE_LIMIT")
                for child in names:
                    require(child not in ("", ".", "..") and "/" not in child and "\0" not in child)
                    visit(descriptor, child, relative + "/" + child, depth + 1, removing)
                require(physical_identity(before) == physical_identity(os.fstat(descriptor)) ==
                        physical_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)))
                if removing:
                    require(os.listdir(descriptor) == [])
                    lineage.verify()
                    os.rmdir(name, dir_fd=parent)
                else:
                    require(metadata(before) == metadata(os.fstat(descriptor)))
            else:
                require(metadata(before) == metadata(os.fstat(descriptor)) ==
                        metadata(os.stat(name, dir_fd=parent, follow_symlinks=False)))
                if removing:
                    lineage.verify()
                    os.unlink(name, dir_fd=parent)
                    require(os.fstat(descriptor).st_nlink == 0)
            if removing:
                fsync_directory(parent)
        finally:
            os.close(descriptor)
    try:
        parent = os.fstat(lineage.descriptor)
        require(expected_parent == {"dev": str(parent.st_dev), "ino": str(parent.st_ino)})
        try:
            before = os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            lineage.verify()
            return {"schemaVersion": 1, "status": "ABSENT"}
        require(expected_target == cleanup_target_identity(before))
        # Preflight the complete bounded tree before the first deletion. Actual
        # deletion requires the process-owner's established writer quiescence.
        visit(lineage.descriptor, leaf, "", 0)
        lineage.verify()
        visit(lineage.descriptor, leaf, "", 0, True)
        lineage.verify()
        return {"schemaVersion": 1, "status": "REMOVED"}
    finally:
        lineage.close()


def recover_record_publication(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "root", "components"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "recover-record-publication", "FILESYSTEM_REQUEST_INVALID")
    lineage, leaf = open_parent(canonical_path(request["root"]), components(request["components"]))
    removed = []
    try:
        parent = os.fstat(lineage.descriptor)
        require(parent.st_uid == os.getuid() and parent.st_mode & 0o077 == 0)
        suffix = ".create" if leaf == "terminal.json" else ".tmp"
        prefix = "." + leaf + "."
        names = os.listdir(lineage.descriptor)
        require(len(names) <= MAX_ENTRIES, "FILESYSTEM_CAPTURE_LIMIT")
        for name in names:
            if not name.startswith(prefix) or not name.endswith(suffix):
                continue
            fields = name[len(prefix):-len(suffix)].split(".")
            if len(fields) != 2 or not fields[0].isascii() or not fields[0].isdigit() or fields[0].startswith("0"):
                continue
            if len(fields[1]) != 16 or any(character not in "0123456789abcdef" for character in fields[1]):
                continue
            pid = int(fields[0])
            require(0 < pid <= 2147483647)
            try:
                os.kill(pid, 0)
            except OSError as error:
                require(error.errno == errno.ESRCH)
            else:
                raise CaptureError("PREIMAGE_UNSAFE")
            before = os.stat(name, dir_fd=lineage.descriptor, follow_symlinks=False)
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                    before.st_uid == os.getuid() and before.st_mode & 0o777 == 0o600 and
                    before.st_size <= MAX_PUBLICATION_BYTES)
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=lineage.descriptor)
            try:
                require(metadata(before) == metadata(os.fstat(descriptor)) ==
                        metadata(os.stat(name, dir_fd=lineage.descriptor, follow_symlinks=False)))
                lineage.verify()
                # As with the POSIX controller, recovery requires this private
                # parent to be quiescent; the originating writer is conclusively dead.
                os.unlink(name, dir_fd=lineage.descriptor)
                require(os.fstat(descriptor).st_nlink == 0)
                fsync_directory(lineage.descriptor)
                lineage.verify()
                removed.append(name)
            finally:
                os.close(descriptor)
        return {"schemaVersion": 1, "status": "RECOVERED", "removed": removed}
    finally:
        lineage.close()


def assert_record_parent(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "root", "components"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "assert-record-parent", "FILESYSTEM_REQUEST_INVALID")
    lineage, _ = open_parent(canonical_path(request["root"]), components(request["components"]))
    try:
        lineage.verify()
        return {"schemaVersion": 1, "status": "VALIDATED", "stat": metadata(os.fstat(lineage.descriptor))}
    finally:
        lineage.close()


def publish_record_exclusive(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "root", "components", "bytesBase64"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "publish-record-exclusive",
            "FILESYSTEM_REQUEST_INVALID")
    data = record_bytes(request["bytesBase64"], MAX_PUBLICATION_BYTES)
    lineage, leaf = open_parent(canonical_path(request["root"]), components(request["components"]))
    descriptor = None
    # The final name is absent until complete bytes are durable. A crash before
    # rename may leave a private single-link temporary; never delete a named
    # residue using a check-then-unlink race against another writer.
    suffix = ".create" if leaf == "terminal.json" else ".tmp"
    temporary = "." + leaf + "." + str(os.getpid()) + "." + os.urandom(8).hex() + suffix
    try:
        try:
            os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            lineage.verify()
            raise CaptureError("FILESYSTEM_ALREADY_EXISTS")
        descriptor = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                             os.O_NOFOLLOW, 0o600, dir_fd=lineage.descriptor)
        opened = os.fstat(descriptor)
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and
                (opened.st_mode & 0o777) == 0o600 and opened.st_size == 0)
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            require(written > 0, "FILESYSTEM_BACKEND_UNAVAILABLE")
            view = view[written:]
        os.fsync(descriptor)
        before = os.fstat(descriptor)
        require(identity(opened)[:4] == identity(before)[:4] and before.st_size == len(data))
        require(read_exact(descriptor, len(data), MAX_PUBLICATION_BYTES) == data)
        require(metadata(before) == metadata(os.fstat(descriptor)) ==
                metadata(os.stat(temporary, dir_fd=lineage.descriptor, follow_symlinks=False)))
        lineage.verify()
        try:
            rename_exclusive(lineage.descriptor, temporary, lineage.descriptor, leaf)
        except OSError as error:
            if error.errno == errno.EEXIST:
                lineage.verify()
                raise CaptureError("FILESYSTEM_ALREADY_EXISTS") from None
            raise
        moved = os.fstat(descriptor)
        live = os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)
        require(physical_identity(before) == physical_identity(moved) == physical_identity(live)
                and moved.st_nlink == 1 and moved.st_size == len(data))
        require(read_exact(descriptor, len(data), MAX_PUBLICATION_BYTES) == data)
        require(metadata(moved) == metadata(os.fstat(descriptor)) ==
                metadata(os.stat(leaf, dir_fd=lineage.descriptor, follow_symlinks=False)))
        fsync_directory(lineage.descriptor)
        lineage.verify()
        return {"schemaVersion": 1, "status": "CREATED", "stat": metadata(moved)}
    finally:
        if descriptor is not None:
            os.close(descriptor)
        lineage.close()


def rename_no_replace(request):
    require(isinstance(request, dict) and set(request) == {
        "schemaVersion", "operation", "sourceRoot", "sourceComponents",
        "targetRoot", "targetComponents"
    } and type(request["schemaVersion"]) is int and request["schemaVersion"] == 1
            and request["operation"] == "rename-no-replace",
            "FILESYSTEM_REQUEST_INVALID")
    # The descriptor checks detect a changed source while this operation runs,
    # but rename does not make content atomic against an active writer. Callers
    # must establish writer and ancestor quiescence before publication.
    source, source_leaf = open_parent(canonical_path(request["sourceRoot"]),
                                      components(request["sourceComponents"]))
    target = None
    source_descriptor = None
    try:
        target, target_leaf = open_parent(canonical_path(request["targetRoot"]),
                                          components(request["targetComponents"]))
        before = os.stat(source_leaf, dir_fd=source.descriptor, follow_symlinks=False)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1)
        source_descriptor = os.open(source_leaf, os.O_RDONLY | os.O_NOFOLLOW |
                                    os.O_NONBLOCK, dir_fd=source.descriptor)
        opened = os.fstat(source_descriptor)
        require(identity(before) == identity(opened) and opened.st_size <= MAX_RECORD_BYTES)
        source_bytes = read_exact(source_descriptor, opened.st_size)
        require(metadata(opened) == metadata(os.fstat(source_descriptor)) ==
                metadata(os.stat(source_leaf, dir_fd=source.descriptor, follow_symlinks=False)))
        rename_exclusive(source.descriptor, source_leaf, target.descriptor, target_leaf)
        after = os.stat(target_leaf, dir_fd=target.descriptor, follow_symlinks=False)
        moved = os.fstat(source_descriptor)
        require(physical_identity(before) == physical_identity(after) and
                physical_identity(moved) == physical_identity(after) and
                after.st_nlink == 1)
        require(read_exact(source_descriptor, moved.st_size) == source_bytes)
        require(metadata(moved) == metadata(os.fstat(source_descriptor)) ==
                metadata(os.stat(target_leaf, dir_fd=target.descriptor, follow_symlinks=False)))
        fsync_directory(source.descriptor)
        fsync_directory(target.descriptor)
        source.verify()
        target.verify()
        return {"schemaVersion": 1, "status": "RENAMED", "stat": metadata(after)}
    finally:
        if source_descriptor is not None:
            os.close(source_descriptor)
        if target is not None:
            target.close()
        source.close()


def main():
    try:
        require(sys.argv[1:] == ["--request"], "FILESYSTEM_REQUEST_INVALID")
        raw = sys.stdin.buffer.read(MAX_PUBLICATION_REQUEST + 1)
        require(len(raw) <= MAX_PUBLICATION_REQUEST, "FILESYSTEM_REQUEST_INVALID")
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, "FILESYSTEM_REQUEST_INVALID")
                result[key] = value
            return result
        request = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(request, dict) or request.get("operation") != "publish-record-exclusive":
            require(len(raw) <= MAX_REQUEST, "FILESYSTEM_REQUEST_INVALID")
        if isinstance(request, dict) and request.get("operation") == "write-record-exclusive":
            result = write_record_exclusive(request)
        elif isinstance(request, dict) and request.get("operation") == "inspect-owned-target":
            result = inspect_owned_target(request)
        elif isinstance(request, dict) and request.get("operation") == "remove-owned-target":
            result = remove_owned_target(request)
        elif isinstance(request, dict) and request.get("operation") == "recover-record-publication":
            result = recover_record_publication(request)
        elif isinstance(request, dict) and request.get("operation") == "assert-record-parent":
            result = assert_record_parent(request)
        elif isinstance(request, dict) and request.get("operation") == "publish-record-exclusive":
            result = publish_record_exclusive(request)
        elif isinstance(request, dict) and request.get("operation") == "rename-no-replace":
            result = rename_no_replace(request)
        else:
            result = run(request)
    except CaptureError as error:
        result = {"schemaVersion": 1, "status": "REFUSED", "code": error.code}
    except (ValueError, UnicodeError, TypeError):
        result = {"schemaVersion": 1, "status": "REFUSED", "code": "FILESYSTEM_REQUEST_INVALID"}
    except OSError:
        # No pathname or host error text is returned. ENOENT here might be a
        # raced ancestor, not proof that an authorized resource is absent.
        result = {"schemaVersion": 1, "status": "REFUSED", "code": "PREIMAGE_UNSAFE"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
