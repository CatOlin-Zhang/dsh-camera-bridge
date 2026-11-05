#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 阿根达斯 · dsh-camera-bridge
"""摄像头桥的转写工人（常驻进程）。

用法（由插件自己拉起，一般不用手动跑）：
    python asr_worker.py --model <模型目录>

协议（一行一条，UTF-8）：
    进：{"wav": "C:\\...\\xxx.wav"}
    出：{"ok": true, "text": "识别出的字", "ms": 123}
    出：{"ok": false, "error": "..."}
    就绪那一下先出一行：{"ok": true, "ready": true, "model": "..."}

为什么要常驻：SenseVoice 每次冷加载要 0.3~1 秒，一句话一句地重加载就白等了。
"""
import argparse
import json
import os
import sys
import time
import wave


def 读_wav(路径):
    with wave.open(路径, "rb") as w:
        声道 = w.getnchannels()
        位宽 = w.getsampwidth()
        采样率 = w.getframerate()
        帧数 = w.getnframes()
        数据 = w.readframes(帧数)
    if 位宽 != 2:
        raise ValueError("只吃 16-bit PCM 的 wav（这条是 %d bit）" % (位宽 * 8))
    import numpy as np
    音频 = np.frombuffer(数据, dtype=np.int16).astype("float32") / 32768.0
    if 声道 > 1:
        音频 = 音频.reshape(-1, 声道).mean(axis=1)
    if 采样率 != 16000:
        n = int(len(音频) * 16000 / 采样率)
        x = np.linspace(0.0, len(音频) - 1, n)
        音频 = np.interp(x, np.arange(len(音频)), 音频).astype("float32")
    return 音频


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="模型目录（含 model.int8.onnx 和 tokens.txt）")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()

    def 说(对象):
        sys.stdout.write(json.dumps(对象, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    try:
        import sherpa_onnx
    except Exception as e:  # noqa: BLE001
        说({"ok": False, "fatal": True, "error": "sherpa_onnx 没装：%s" % e})
        return 2

    模型 = os.path.join(a.model, "model.int8.onnx")
    词表 = os.path.join(a.model, "tokens.txt")
    for 文件 in (模型, 词表):
        if not os.path.exists(文件):
            说({"ok": False, "fatal": True, "error": "模型目录里缺文件：%s" % 文件})
            return 3

    try:
        rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=模型, tokens=词表, num_threads=a.threads, use_itn=True,
        )
    except Exception as e:  # noqa: BLE001
        说({"ok": False, "fatal": True, "error": "模型加载失败：%s" % e})
        return 4

    说({"ok": True, "ready": True, "model": a.model})

    for 行 in sys.stdin:
        行 = 行.strip()
        if not 行:
            continue
        开始 = time.time()
        try:
            请求 = json.loads(行)
            路径 = 请求.get("wav") or ""
            if not 路径 or not os.path.exists(路径):
                raise ValueError("找不到音频：%s" % 路径)
            音频 = 读_wav(路径)
            流 = rec.create_stream()
            流.accept_waveform(16000, 音频)
            rec.decode_stream(流)
            文本 = (流.result.text or "").strip()
            说({"ok": True, "text": 文本, "ms": int((time.time() - 开始) * 1000)})
        except Exception as e:  # noqa: BLE001
            说({"ok": False, "error": "%s: %s" % (type(e).__name__, e), "ms": int((time.time() - 开始) * 1000)})
        finally:
            try:
                if "路径" in dir() and 路径:
                    os.remove(路径)
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
