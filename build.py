#!/usr/bin/env python3
"""把 app.js 内联进 index.html，生成可直接发给别人的单文件版本。

用法：python build.py
产出：PKG图片提取器.html（与 index.html 同目录）
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MARKER = '<script src="app.js"></script>'
OUT = ROOT / "PKG图片提取器.html"


def main() -> None:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "app.js").read_text(encoding="utf-8")
    if MARKER not in html:
        raise SystemExit(f"index.html 中找不到 {MARKER!r}，请检查是否改过引用方式")

    single = html.replace(MARKER, "<script>\n" + js + "\n</script>")
    OUT.write_text(single, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.name} ({OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
