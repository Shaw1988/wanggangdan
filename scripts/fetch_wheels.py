# -*- coding: utf-8 -*-
import re
import os
import sys
import urllib.request
import urllib.parse

BASE = "https://pypi.tuna.tsinghua.edu.cn/simple"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pip/26"})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf8", "ignore")


def pick(pkg):
    index = f"{BASE}/{pkg}/"
    html = fetch(index)
    hrefs = re.findall(r'href="([^"]+)"', html)
    cands = []
    for h in hrefs:
        url = urllib.parse.urljoin(index, h)
        name = url.split("/")[-1].split("#")[0]
        if ("cp313-cp313-win_amd64.whl" in name or "abi3-win_amd64.whl" in name or "py3-none-any.whl" in name):
            cands.append(url)
    if not cands:
        raise SystemExit(f"{pkg}: 没有找到 cp313 win_amd64 wheel")
    return cands[-1]


def main():
    os.makedirs(OUT, exist_ok=True)
    for pkg in sys.argv[1:] or ["numpy", "opencv-python-headless"]:
        url = pick(pkg)
        fname = url.split("/")[-1].split("#")[0]
        dest = os.path.join(OUT, fname)
        if not os.path.exists(dest):
            print("下载", fname)
            req = urllib.request.Request(url, headers={"User-Agent": "pip/26"})
            data = urllib.request.urlopen(req, timeout=600).read()
            with open(dest, "wb") as f:
                f.write(data)
        print(dest)


if __name__ == "__main__":
    main()
