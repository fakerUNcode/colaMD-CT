#!/usr/bin/env python3
"""符号链接感知的 zip 解压（macOS app bundle 必需）。

Ubuntu 最小安装没有 unzip；python3 zipfile 又不还原符号链接（framework 版本
结构里全是链接，退成普通文件 = app 直接废）。这里按 entry 的 unix 属性位
（external_attr 高 16 位）识别 symlink，用 os.symlink 还原。

用法: python3 unzip-symlinks.py <zip> <dest>
"""
import os
import sys
import stat
import zipfile


def main() -> int:
    src, dest = sys.argv[1], sys.argv[2]
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(src) as zf:
        for info in zf.infolist():
            target = os.path.join(dest, info.filename)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                link_to = zf.read(info).decode('utf-8')
                os.makedirs(os.path.dirname(target), exist_ok=True)
                if os.path.lexists(target):
                    os.remove(target)
                os.symlink(link_to, target)
            elif info.is_dir() or stat.S_ISDIR(mode):
                os.makedirs(target, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as r, open(target, 'wb') as w:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        w.write(chunk)
                os.chmod(target, mode & 0o777 or 0o644)
    print(f'EXTRACTED {len(zipfile.ZipFile(src).namelist())} entries -> {dest}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
