# -*- coding: utf-8 -*-
"""
把三张带灰底和投影的机器人照片处理成透明底 PNG。
- 默认用 OpenCV GrabCut 分割主体
- 如果装了 rembg，加 --rembg 会优先用它
输出统一画布，保证三张切换时人物位置和大小一致。
"""
import os
import sys
import json
import argparse

import numpy as np
import cv2
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
DEFAULT_SRC = [
    os.path.join(ASSETS, "src1.png"),
    os.path.join(ASSETS, "src2.png"),
    os.path.join(ASSETS, "src3.png"),
]

TARGET_BODY_H = 460      # 主体（不含留白）高度
TOP_MARGIN = 26
BOTTOM_MARGIN = 28
SIDE_MARGIN = 22
RECT = (0.14, 0.02, 0.72, 0.93)   # GrabCut 初始框（相对比例）


def largest_component(binary):
    num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if num <= 1:
        return binary
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return (labels == idx).astype(np.uint8)


def fill_holes(binary):
    h, w = binary.shape
    inv = (1 - binary).astype(np.uint8)
    ff = inv.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, mask, (0, 0), 0)
    return (binary | ff).astype(np.uint8)


def remove_floor_shadow(rgb, binary):
    """去掉脚下与地面接触的柔和投影：底部区域内，颜色接近背景且几乎没有纹理的部分判为背景"""
    h, w = binary.shape
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    gx = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blur, cv2.CV_32F, 0, 1, ksize=3)
    grad = cv2.magnitude(gx, gy)

    m = max(4, int(w * 0.05))
    bg_row = np.median(np.concatenate([rgb[:, :m], rgb[:, w - m:]], axis=1), axis=1)
    diff = np.abs(rgb.astype(np.float32) - bg_row[:, None, :]).max(axis=2)

    ys, _ = np.nonzero(binary)
    if len(ys) == 0:
        return binary
    top, bottom = int(ys.min()), int(ys.max())
    band_top = int(top + (bottom - top) * 0.70)

    band = np.zeros_like(binary)
    band[band_top:bottom + 1, :] = 1
    flat = ((grad < 10) & (diff < 58)).astype(np.uint8)
    shadowish = flat & band

    cut = binary.copy()
    cut[shadowish > 0] = 0
    cut = largest_component(cut)
    cut = fill_holes(cut)
    return cut


def grabcut_alpha(rgb, debug_name=None):
    h, w = rgb.shape[:2]
    work_w = 720
    scale = work_w / float(w)
    small = cv2.resize(rgb, (work_w, int(round(h * scale))), interpolation=cv2.INTER_AREA)
    sh, sw = small.shape[:2]

    rx, ry, rw, rh = RECT
    rect = (int(sw * rx), int(sh * ry), int(sw * rw), int(sh * rh))
    mask = np.zeros((sh, sw), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(small, mask, rect, bgd, fgd, 6, cv2.GC_INIT_WITH_RECT)

    binary = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 1, 0).astype(np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    binary = largest_component(binary)
    binary = fill_holes(binary)
    binary = cv2.dilate(binary, np.ones((3, 3), np.uint8), iterations=1)
    binary = remove_floor_shadow(small, binary)

    if debug_name:
        dbg = os.path.join(ASSETS, debug_name)
        cv2.imwrite(dbg, (binary * 255).astype(np.uint8))

    alpha_small = (binary * 255).astype(np.uint8)
    alpha = cv2.resize(alpha_small, (w, h), interpolation=cv2.INTER_LINEAR)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 0.9)
    return alpha


def load_model(path):
    # 用 OpenCV DNN 直接推理 onnx，绕开 onnxruntime 在本机的崩溃问题
    return cv2.dnn.readNetFromONNX(path)


MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def model_alpha(rgb, net, size=320):
    h, w = rgb.shape[:2]
    im = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    im = (im - MEAN) / STD
    net.setInput(im.transpose(2, 0, 1)[None].astype(np.float32))
    pred = np.squeeze(net.forward())
    if pred.ndim > 2:
        pred = pred[0]
    sal = (pred - pred.min()) / (pred.max() - pred.min() + 1e-8)

    alpha = cv2.resize(sal, (w, h), interpolation=cv2.INTER_CUBIC)
    alpha = np.clip((alpha - 0.20) * (1.0 / 0.55), 0, 1)
    binary = (alpha > 0.5).astype(np.uint8)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    binary = largest_component(binary)
    binary = fill_holes(binary)

    soft = (alpha * 255).astype(np.uint8)
    soft = cv2.GaussianBlur(soft, (0, 0), 1.0)
    # 去掉边缘外圈的浅灰光晕，避免残影/毛边
    soft[soft < 32] = 0
    # 主体内部强制 255 不透明：旧版有些过渡像素会让桌面透过身体
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    solid = ((dist >= 1.6) * 255).astype(np.uint8)
    out = np.maximum(soft, solid)
    return out


def cutout(path, use_rembg, debug_name=None, model=None):
    rgb = np.array(Image.open(path).convert("RGB"))
    if model is not None:
        alpha = model_alpha(rgb, model)
    else:
        alpha = grabcut_alpha(rgb, debug_name)
    rgba = np.dstack([rgb, alpha]).astype(np.uint8)
    return rgba


def subject_metrics(rgba):
    alpha = rgba[:, :, 3]
    ys, xs = np.nonzero(alpha > 24)
    if len(xs) == 0:
        raise RuntimeError("没有检测到主体")
    left, right = int(xs.min()), int(xs.max()) + 1
    top, bottom = int(ys.min()), int(ys.max()) + 1

    # 头顶附近区域的水平中心，用头而不是整张外接框来对齐，避免抬手那张偏移
    head_h = max(8, int((bottom - top) * 0.16))
    head_slice = alpha[top:top + head_h, :]
    hys, hxs = np.nonzero(head_slice > 40)
    head_cx = float(hxs.mean()) if len(hxs) else (left + right) / 2.0
    return {
        "box": (left, top, right, bottom),
        "width": right - left,
        "height": bottom - top,
        "head_cx": head_cx,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rembg", action="store_true", help="优先使用 rembg")
    parser.add_argument("--model", default=os.path.join("vendor", "models", "silueta.onnx"),
                        help="使用 onnx 分割模型（默认 silueta，需在项目根目录运行）")
    parser.add_argument("--debug", action="store_true", help="输出分割掩膜")
    parser.add_argument("--src", nargs=3, default=DEFAULT_SRC)
    args = parser.parse_args()

    os.makedirs(ASSETS, exist_ok=True)

    model = load_model(args.model) if args.model and os.path.exists(args.model) else None
    if model is not None:
        print("使用分割模型:", os.path.basename(args.model))

    cutouts = []
    for i, src in enumerate(args.src, start=1):
        if not os.path.exists(src):
            raise SystemExit(f"缺少源图：{src}")
        rgba = cutout(src, args.rembg, f"debug{i}.png" if args.debug else None, model)
        cutouts.append(rgba)
        m = subject_metrics(rgba)
        print(f"图{i}: box={m['box']} 高={m['height']} 宽={m['width']} 头心x={m['head_cx']:.1f}")

    metrics = [subject_metrics(c) for c in cutouts]
    scales = [TARGET_BODY_H / m["height"] for m in metrics]

    left_ext = max((m["head_cx"] - m["box"][0]) * s for m, s in zip(metrics, scales))
    right_ext = max((m["box"][2] - m["head_cx"]) * s for m, s in zip(metrics, scales))
    canvas_w = int(round(left_ext + right_ext + SIDE_MARGIN * 2))
    canvas_h = TARGET_BODY_H + TOP_MARGIN + BOTTOM_MARGIN
    head_x = SIDE_MARGIN + left_ext
    feet_y = TOP_MARGIN + TARGET_BODY_H

    print(f"画布: {canvas_w}x{canvas_h}  头心x={head_x:.1f}  脚底y={feet_y}")

    for i, (rgba, m, s) in enumerate(zip(cutouts, metrics, scales), start=1):
        pil = Image.fromarray(rgba, "RGBA")
        new_w = max(1, int(round(rgba.shape[1] * s)))
        new_h = max(1, int(round(rgba.shape[0] * s)))
        pil = pil.resize((new_w, new_h), Image.LANCZOS)

        ox = int(round(head_x - m["head_cx"] * s))
        oy = int(round(feet_y - m["box"][3] * s))

        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        canvas.alpha_composite(pil, (ox, oy))
        out_path = os.path.join(ASSETS, f"char{i}.png")
        canvas.save(out_path, optimize=True)
        print(f"输出 {os.path.basename(out_path)}")

    # 托盘图标：取第一张的头部
    first = Image.open(os.path.join(ASSETS, "char1.png"))
    m0 = subject_metrics(np.array(first))
    left, top, right, bottom = m0["box"]
    head_size = int(min(right - left, m0["height"] * 0.62))
    cx = int(m0["head_cx"])
    hx = max(0, cx - head_size // 2)
    hy = max(0, top - 4)
    head = first.crop((hx, hy, hx + head_size, hy + head_size)).resize((64, 64), Image.LANCZOS)
    head.save(os.path.join(ASSETS, "tray.png"))
    print("输出 tray.png")

    with open(os.path.join(ASSETS, "canvas.json"), "w", encoding="utf-8") as f:
        json.dump({"width": canvas_w, "height": canvas_h}, f)


if __name__ == "__main__":
    main()
