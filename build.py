#!/usr/bin/env python3
"""
LuminaSlide SPK 打包脚本（遵循群晖 DSM 7 规范：USTAR_FORMAT + 显式 DIRTYPE + checksum + reloadui）
用法：python3 build-spk.py [version]
产出：dist/LuminaSlide_<version>_all.spk
"""
import hashlib
import io
import os
import re
import sys
import tarfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SPK_DIR = os.path.join(ROOT, "package")
DIST_DIR = os.path.join(ROOT, "dist")
MTIME = 1767225600


def read_info(override_version=None):
    info_path = os.path.join(SPK_DIR, "INFO")
    with open(info_path, "r", encoding="utf-8") as f:
        txt = f.read().replace("\r\n", "\n")
    m = re.search(r'^version="([^"]+)"', txt, re.M)
    if not m:
        raise RuntimeError("Cannot find version in package/INFO")
    ver = m.group(1)
    if override_version:
        ver = override_version.lstrip("v")
        txt = re.sub(r'^version="[^"]+"', f'version="{ver}"', txt, flags=re.M)
    return ver, txt


def make_dir_tracker(tf):
    added = set()

    def ensure_dir(d):
        d = d.strip("/")
        if not d or d == "." or d in added:
            return
        parent = os.path.dirname(d)
        if parent and parent != ".":
            ensure_dir(parent)
        ti = tarfile.TarInfo(name=d)
        ti.type = tarfile.DIRTYPE
        ti.mode = 0o755
        ti.uid = 0
        ti.gid = 0
        ti.uname = "root"
        ti.gname = "root"
        ti.mtime = MTIME
        tf.addfile(ti)
        added.add(d)

    return ensure_dir


def add_bytes(tf, ensure_dir, arcname, data, mode=0o644):
    arcname = arcname.lstrip("./")
    parent = os.path.dirname(arcname)
    if parent:
        ensure_dir(parent)
    ti = tarfile.TarInfo(name=arcname)
    ti.size = len(data)
    ti.mode = mode
    ti.uid = 0
    ti.gid = 0
    ti.uname = "root"
    ti.gname = "root"
    ti.mtime = MTIME
    tf.addfile(ti, io.BytesIO(data))


def add_file(tf, ensure_dir, src_path, arcname, mode=0o644, normalize_lf=False):
    with open(src_path, "rb") as f:
        data = f.read()
    if normalize_lf:
        data = data.replace(b"\r\n", b"\n")
    add_bytes(tf, ensure_dir, arcname, data, mode=mode)


def add_dir_tree(tf, ensure_dir, src_dir, arc_prefix, text_exts=(".js", ".css", ".html", ".json", ".svg", ".sc")):
    for root, _, files in os.walk(src_dir):
        rel_root = os.path.relpath(root, src_dir)
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = fn if rel_root == "." else os.path.join(rel_root, fn)
            arc = arc_prefix + "/" + rel.replace("\\", "/")
            is_text = fn.endswith(text_exts) or fn in ("config",)
            add_file(tf, ensure_dir, full, arc, mode=0o644, normalize_lf=is_text)


def build_package_tgz():
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.USTAR_FORMAT, compresslevel=6) as tf:
        ensure_dir = make_dir_tracker(tf)
        add_file(tf, ensure_dir, os.path.join(ROOT, "package.json"), "package.json", mode=0o644, normalize_lf=True)
        add_file(tf, ensure_dir, os.path.join(ROOT, "defaults", "config.default.json"), "conf/config.default.json", mode=0o644, normalize_lf=True)
        add_dir_tree(tf, ensure_dir, os.path.join(ROOT, "src"), "src")
        add_dir_tree(tf, ensure_dir, os.path.join(ROOT, "public"), "public")
        add_dir_tree(tf, ensure_dir, os.path.join(SPK_DIR, "ui"), "ui")
    return buf.getvalue()


def main():
    override_ver = sys.argv[1] if len(sys.argv) > 1 else None
    version, info_txt = read_info(override_ver)
    os.makedirs(DIST_DIR, exist_ok=True)
    out_spk = os.path.join(DIST_DIR, f"LuminaSlide_{version}_all.spk")

    pkg_tgz = build_package_tgz()
    pkg_md5 = hashlib.md5(pkg_tgz).hexdigest()

    if re.search(r'^checksum=', info_txt, re.M):
        info_txt = re.sub(r'^checksum=.*$', f'checksum="{pkg_md5}"', info_txt, flags=re.M)
    else:
        info_txt = info_txt.rstrip("\n") + f'\nchecksum="{pkg_md5}"\n'

    with tarfile.open(out_spk, mode="w", format=tarfile.USTAR_FORMAT) as tf:
        ensure_dir = make_dir_tracker(tf)
        add_bytes(tf, ensure_dir, "INFO", info_txt.encode("utf-8"), mode=0o644)
        add_file(tf, ensure_dir, os.path.join(SPK_DIR, "PACKAGE_ICON.PNG"), "PACKAGE_ICON.PNG", mode=0o644)
        add_file(tf, ensure_dir, os.path.join(SPK_DIR, "PACKAGE_ICON_256.PNG"), "PACKAGE_ICON_256.PNG", mode=0o644)

        for fn in ("privilege", "resource", "config.default.json"):
            p = os.path.join(SPK_DIR, "conf", fn)
            if os.path.exists(p):
                add_file(tf, ensure_dir, p, f"conf/{fn}", mode=0o644, normalize_lf=True)

        scripts_dir = os.path.join(SPK_DIR, "scripts")
        for fn in sorted(os.listdir(scripts_dir)):
            add_file(tf, ensure_dir, os.path.join(scripts_dir, fn), f"scripts/{fn}", mode=0o755, normalize_lf=True)

        wiz_dir = os.path.join(SPK_DIR, "WIZARD_UIFILES")
        for fn in sorted(os.listdir(wiz_dir)):
            add_file(tf, ensure_dir, os.path.join(wiz_dir, fn), f"WIZARD_UIFILES/{fn}", mode=0o644, normalize_lf=True)

        add_bytes(tf, ensure_dir, "package.tgz", pkg_tgz, mode=0o644)

    with open(out_spk, "rb") as f:
        magic = f.read(4)
    assert magic == b"INFO", f"SPK must be uncompressed tar starting with INFO, got {magic!r}"

    with tarfile.open(out_spk, "r:") as tf:
        names = tf.getnames()
        for req in ("INFO", "PACKAGE_ICON.PNG", "PACKAGE_ICON_256.PNG", "conf/privilege", "conf/resource", "scripts/start-stop-status", "package.tgz"):
            assert req in names, f"Missing {req} in spk"
        pkg_member = tf.extractfile("package.tgz")
        with tarfile.open(fileobj=pkg_member, mode="r:gz") as ptf:
            pnames = ptf.getnames()
            for preq in ("ui/config", "ui/LuminaSlide.sc", "src/server.js", "public/index.html", "public/icon.svg", "conf/config.default.json"):
                assert preq in pnames, f"Missing {preq} in package.tgz"

    size_kb = os.path.getsize(out_spk) / 1024
    print(f"[OK] Built and verified: {out_spk} ({size_kb:.1f} KB, md5={pkg_md5})")


if __name__ == "__main__":
    main()
