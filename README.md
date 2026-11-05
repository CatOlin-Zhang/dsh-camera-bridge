# 🎥 摄像头桥

> **预发布版 `0.9.0-beta.1`** —— 能用，但**功能、配置键、接口都可能随版本变化**。
> 遇到问题欢迎反馈；升级前建议备份 `~/.dsh/camera-bridge.json`。

把「你说话」和「摄像头画面」接进 DSH 的会话里。

**说话不用手**：对着电脑说话 → 本机转成文字 → 当成你这一轮的话送进会话 → 它回 → **朗读桥**念出来。
**画面当眼睛**：摄像头常驻解码，YOLO 认画面里有什么；模型拿不准时自己看一眼快照。

> 出声那一半是另一个插件 `dsh-tts-bridge`（朗读桥）的事。**不装它也能用**，只是不会念出来。

---

## 能做什么

- 🎤 **听**：ffmpeg 抓麦克风 → 能量 VAD 切句 → SenseVoice 转写 → `agent.followup()` 送进会话。说几句就回几句（送不完的排队）
- 📷 **看**：ffmpeg 解 RTSP（或本机摄像头）成 JPEG，面板里实时放（MJPEG）
- 👁 **眼睛**：YOLO-World 开放词表，CUDA 下**一帧 20–30ms**
- 🧰 **四个工具**：`camera_state`（一句话摘要）、`look_camera`（一张 jpg，模型自己看）、`watch_camera`（开/关盯着）、`recipe_import`（导入菜谱）
- 🍳 **挂载模块**：做饭只是第一个。视觉是底座，模块挂在它下面，各自决定「认出来之后干什么」；以后加「盯着猫」只要再写一个模块
- ✋ **抢话**：朗读桥念的时候默认闭麦，你比喇叭响且**持续 400ms** 就把朗读停掉、立刻听你说
- ⏱ **每轮计时**：判停 / 转写 / 送达 / 总耗时 → 面板 + `~/.dsh/camera-bridge/timing.jsonl`

---

## 装之前：需要三样外部东西

本插件**不打包**这些（体积 + 许可原因），得你自己准备：

| 东西 | 说明 | 大小 |
|---|---|---|
| **ffmpeg** | 抓麦克风、解视频。装好并加进 `PATH`，或在面板里填绝对路径 | ~80 MB |
| **Python 3.10+** | 跑语音识别和 YOLO。需要 `pip install -r tools/requirements.txt` | — |
| **SenseVoice 模型** | 放进 `~/.dsh/camera-bridge/models/sense-voice/`，需要 `model.int8.onnx` + `tokens.txt` | ~230 MB |
| **YOLO-World 权重** | `yolov8s-worldv2.pt` 放进 `~/.dsh/camera-bridge/models/` | ~25 MB |
| CLIP ViT-B/32 | 首次用开放词表时**自动下载**到 `~/.cache/clip`，需联网 | ~338 MB |

> 面板里有个「**自检**」按钮，装完点一下就知道缺哪一样、该放哪儿。

---

## 装

在 DSH 里装插件（设置 → 插件 → 安装），或者让它装本地目录：

```
帮我装 D:\path\to\dsh-camera-bridge
```

装完右下角出现 **🎥 摄像头桥** 卡片，设置里多一页「摄像头桥」。

### 装 Python 依赖

```bash
<你的 python> -m pip install -r tools/requirements.txt
```

只想听、不看画面的话，可以不装 `ultralytics`（省一大坨 torch），但「眼睛」相关的自动识别会不可用——手动拍快照让你自己看仍然能工作。

---

## 用

1. 卡片「详情」→「送到」选一个**开着的**会话
2. 点「📷」（开画面）、「👁」（开眼睛）——第一次会下载 CLIP，等一下
3. 点「开始听」，对着电脑说话
4. 想让它盯着锅：**设置 → 摄像头桥 → 挂载的服务 → 做饭**，填「想做什么菜」，点「开始做」

---

## 配置

`~/.dsh/camera-bridge.json`（面板上改也行，改完即时生效）：

| 键 | 默认 | 说明 |
|---|---|---|
| `micDevice` | 空 | 麦克风设备名；空 = 自动挑（会跳过虚拟声卡） |
| `videoDevice` | 空 | 摄像头设备名；空 = 自动挑 |
| `ffmpegPath` | 空 | 空 = 自动找常见位置，再退回 `PATH` |
| `pythonPath` | 空 | 同上 |
| `silenceMs` | 600 | 静音多久算说完。**调小更快，但容易把停顿切成两句**（实测 400 时 250ms 词间停顿安全、500ms 会切） |
| `maxSpeechMs` | 15000 | 单句上限，超了强制切 |
| `halfDuplex` | true | 朗读桥出声时不听 |
| `duplexPollMs` | 200 | 多久问一次朗读桥在不在念 |
| `interruptRms` | 0.08 | 抢话门槛（RMS） |
| `interruptMs` | 400 | 抢话要**持续多久**才算（防止回声/碰锅误打断） |
| `autoSend` | true | 识别完自动送进会话 |
| `targetSession` | 空 | 送到哪个会话 |
| `cookDish` | 空 | 做饭模块里填的菜名 |

---

## 数据在哪

```
~/.dsh/camera-bridge/
├── timing.jsonl          每一轮耗时（一行一轮，可以直接拿去算）
├── clips/                录音临时文件（转写完即删，不留）
├── shots/                最近 20 张快照
├── recipes/current.json  当前菜谱
└── models/               SenseVoice / YOLO 权重
```

---

## 已知限制

- **一轮 2–35 秒**：说话 5 秒的完整链路，实测三段（判停 600ms + 转写 ~120ms + 送达 ~20ms）合计不到 1 秒；剩下全花在模型生成和朗读排队上
- **朗读要等整轮结束**：不是流式边生成边念，所以「第一个字出声」的延迟 = 整轮生成时间 + 朗读桥 1.5 秒扫描
- 麦克风是独占的：别的软件占着就抓不到（面板会报）
- 摄像头也是独占的：同一时间只能一个进程用
- 开放词表**第一次**要下 338MB CLIP，之后才快
- 没有回声消除，抢话靠「够响够久」判断
- **界面只有中文**（`locale/` 里只有标题和简介的翻译）
- 只支持 Windows 的 dshow 设备枚举最完整；macOS / Linux 走 `PATH` 里的 ffmpeg，设备名要手填

---

## 许可

本项目按 **GNU AGPL v3.0 或更高版本**发布 —— 见 [`LICENSE`](./LICENSE)。

选它是因为运行时依赖 **ultralytics（YOLOv8 / YOLO-World），它也是 AGPL-3.0**，用同一套许可就没有冲突。
你可以自由使用、修改、再分发，但**分发修改版时也要开源**（AGPL 的 copyleft）。

依赖清单和模型许可见 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。
