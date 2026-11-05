# 第三方组件与许可

本项目自身代码按 **GNU AGPL v3.0 或更高版本**发布（见 `LICENSE`）。

选 AGPL 的原因很直接：本插件运行时依赖 **ultralytics（AGPL-3.0）**，两边用同一套许可，
就不存在"MIT 项目引用 AGPL 组件"的冲突。代价是 copyleft——如果你分发修改版，也要开源。

> ⚠ 这份清单是"把依赖摆在桌面上"，**不是法律意见**。真要商用或再分发前，建议核对每个上游的最新许可文本。

---

## 一、运行时依赖

| 组件 | 许可 | 用在哪 | 说明 |
|---|---|---|---|
| **ultralytics**（YOLOv8 / YOLO-World） | **AGPL-3.0** | `tools/yolo_worker.py` | 检测运行时。本项目因此也采用 AGPL-3.0 |
| **PyTorch** | BSD-3-Clause | `tools/yolo_worker.py` | 被 ultralytics 间接使用 |
| **sherpa-onnx** | Apache-2.0 | `tools/asr_worker.py` | 语音识别运行时，宽松许可 |
| **onnxruntime** | MIT | 被 sherpa-onnx 间接使用 | — |
| **numpy** | BSD-3-Clause | 两个 worker | — |

## 二、模型与外部程序（**不随包分发**）

| 组件 | 许可 | 说明 |
|---|---|---|
| **SenseVoice 模型**（`model.int8.onnx` + `tokens.txt`） | 见上游仓库（FunAudioLLM / SenseVoice） | 约 230MB，用户自行下载 |
| **YOLO-World 权重**（`yolov8s-worldv2.pt`） | AGPL-3.0（随 ultralytics） | 约 25MB，用户自行下载 |
| **CLIP ViT-B/32**（`ViT-B-32.pt`） | MIT（OpenAI） | 约 338MB，首次使用自动下载到 `~/.cache/clip` |
| **ffmpeg** | LGPL-2.1+ / GPL（取决于编译选项） | 外部程序，不随包分发 |
| **Python** | PSF License | 外部程序，不随包分发 |

本仓库**不包含**上述模型和外部程序，既控制包体积，也避免替用户承担分发责任。

---

## 三、曾经考虑过、但放弃的方案：ONNX Runtime

思路：把 YOLO 推理换成 ONNX Runtime，运行时只依赖 `onnxruntime`（MIT），
这样就能绕开 AGPL、保住 MIT。

**实测结论：不可行（对本项目而言）。**

- YOLO-World 导出 ONNX 时，`set_classes()` 算出的文本嵌入会被**折叠成图里的常量权重**
- 实测导出的模型只有 1 个输入 `images [1,3,640,640]`，没有任何文本/嵌入输入
- 输出固定 `48 = 4 + 44` 通道 —— **只会认导出时那 N 个词**

也就是说，走 ONNX 就**失去开放词表**：面板里改「识别词表」完全无效，换词必须重新导出。
而"随口说一个新词就能认"是本项目的核心体验，所以放弃了这条路。

顺带记录性能对比（同一台机器、同一张图）：

| 方案 | 词表 | 单帧耗时 |
|---|---|---|
| ultralytics + CUDA（现在用这个） | **开放** | 16–25 ms |
| ONNX Runtime（CPU） | 冻结 | 111 ms |

真要在保留开放词表的前提下用 ONNX，得把 class projection 拆出来，
让 ONNX 接受 `(1, N, 512)` 的文本嵌入输入，运行时再用 CLIP 的 ONNX 现编码类名——
那不是"导出一下"，而是要改模型结构。

---

## 四、如果你要再分发本项目

AGPL-3.0 的要求：

1. **保留 `LICENSE`**，并说明你改了什么、什么时候改的
2. **提供完整对应源码**（包括你的修改）
3. 如果改了之后还通过网络提供服务，要**让使用者能拿到源码**
4. 保留本 `THIRD-PARTY-NOTICES.md`

模型权重、ffmpeg、Python 仍由使用者自行安装，不在你的分发义务里（除非你也一并分发了它们）。
