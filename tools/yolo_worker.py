#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 阿根达斯 · dsh-camera-bridge
"""摄像头桥的「眼睛」——常驻的 YOLO-World 检测工人。

用法（插件自己拉起）：
    python yolo_worker.py --model yolov8s-worldv2.pt --classes "pot,pan,knife" --conf 0.25

协议（一行一条，UTF-8）：
    进：{"jpg": "C:\\...\\frame.jpg", "conf": 0.3}
    出：{"ok": true, "objects": [{"label": "pot", "conf": 0.87, "box": [x1,y1,x2,y2]}], "ms": 43}
    进：{"set_classes": ["pot","knife"]}          # 换词表
    就绪：{"ok": true, "ready": true, "model": "...", "device": "cuda", "classes": [...]}

⚠ 启动时**不**设词表：set_classes 第一次会去下 CLIP 的 ViT-B/32（338MB），
  放在启动里会让「就绪」永远等不到。改成第一次检测前再设（只慢第一帧）。
"""
import argparse
import json
import os
import sys
import time


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--classes", default="")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--device", default="")
    a = ap.parse_args()

    def 说(对象):
        sys.stdout.write(json.dumps(对象, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    try:
        from ultralytics import YOLOWorld
    except Exception as e:  # noqa: BLE001
        说({"ok": False, "fatal": True, "error": "ultralytics 没装：%s" % e})
        return 2

    if not os.path.exists(a.model):
        说({"ok": False, "fatal": True, "error": "找不到权重：%s" % a.model})
        return 3

    开 = time.time()
    try:
        m = YOLOWorld(a.model)
    except Exception as e:  # noqa: BLE001
        说({"ok": False, "fatal": True, "error": "权重加载失败：%s" % e})
        return 4

    import torch

    设备 = a.device or ("cuda" if torch.cuda.is_available() else "cpu")

    状态 = {
        "词表": [c.strip() for c in a.classes.split(",") if c.strip()],
        "设好": False,
        "警告": "",
    }

    def 确保词表():
        """第一次检测前把词表设上（首次会下载 CLIP 权重，只发生一次）"""
        if 状态["设好"] or not 状态["词表"]:
            状态["设好"] = True
            return
        try:
            说({"ok": True, "progress": "正在准备开放词表（第一次要下 CLIP 模型，约 338MB）"})
            m.set_classes(状态["词表"])
            状态["设好"] = True
            说({"ok": True, "classes": 状态["词表"], "vocab": "ready"})
        except Exception as e:  # noqa: BLE001
            状态["警告"] = "开放词表没启用（%s），先用自带的 80 类" % str(e).splitlines()[0][:160]
            状态["词表"] = []
            状态["设好"] = True
            说({"ok": True, "warn": 状态["警告"], "classes": [], "vocab": "fallback"})

    说({
        "ok": True,
        "ready": True,
        "model": a.model,
        "device": 设备,
        "classes": [],
        "vocab": "lazy",
        "load_ms": int((time.time() - 开) * 1000),
    })

    for 行 in sys.stdin:
        行 = 行.strip()
        if not 行:
            continue
        try:
            请求 = json.loads(行)
        except Exception as e:  # noqa: BLE001
            说({"ok": False, "error": "不是 json：%s" % e})
            continue

        if "set_classes" in 请求:
            状态["词表"] = [str(c).strip() for c in 请求.get("set_classes") or [] if str(c).strip()]
            状态["设好"] = False
            try:
                确保词表()
            except Exception as e:  # noqa: BLE001
                说({"ok": False, "error": "换词表失败：%s" % e})
            continue

        开始 = time.time()
        路径 = str(请求.get("jpg") or "")
        try:
            if not 路径 or not os.path.exists(路径):
                raise ValueError("找不到图：%s" % 路径)
            确保词表()
            参数 = dict(conf=float(请求.get("conf") or a.conf), imgsz=int(a.imgsz), verbose=False, device=设备)
            结果 = m.predict(路径, **参数)[0]
            名字 = 结果.names or {}
            物体 = []
            for 框 in 结果.boxes:
                try:
                    编号 = int(框.cls[0])
                    分 = float(框.conf[0])
                    坐标 = [float(v) for v in 框.xyxy[0]]
                except Exception:
                    continue
                物体.append({
                    "label": str(名字.get(编号, 编号)),
                    "conf": round(分, 3),
                    "box": [round(v) for v in 坐标],
                })
            物体.sort(key=lambda o: -o["conf"])
            说({
                "ok": True,
                "objects": 物体[:20],
                "ms": int((time.time() - 开始) * 1000),
                "warn": 状态["警告"],
            })
        except Exception as e:  # noqa: BLE001
            说({"ok": False, "error": "%s: %s" % (type(e).__name__, e), "ms": int((time.time() - 开始) * 1000)})

    return 0


if __name__ == "__main__":
    sys.exit(main())
