# ③ 朗读：等一句太久，换本地 TTS（IndexTTS）

> 回到总览：[`docs/引导.md`](../引导.md) ｜ 上一篇：[② 视觉方案](./2-视觉-本地多模态.md)

## 1. 先把链路摊开：延迟到底卡在哪

```
你说一句
  → 麦克风 → SenseVoice 转写（本机，0.3–0.6s）
  → 会话主模型（云端，首 token 1–3s，一**整轮**生成完更久）
  → 朗读桥：把整轮文字排进队列
  → 浏览器扩展：在 DeepSeek 页面找到「朗读」按钮 → 点它 → 等 DOM 响应
  → 云端 TTS 合成（网络 + 队列）
  → 出声
```

**这个插件（camera-bridge）在这条链里只做两件事**：

| 它做的 | 接口 |
|---|---|
| 问「现在在不在念」→ 决定要不要闭麦（半双工，免得把自己的声音当成你在说） | `GET <ttsBase>/status` → `{"playing":true,"waiting":0}` |
| 你要抢话时「停下正在念的」 | `POST <ttsBase>/stop` |

真正出声的是 **朗读桥（dsh-tts-bridge）** 和它背后那套 TTS。所以「换 TTS」不用改这个插件，
把配置 `ttsBase` 指过去就行 —— 前提是新服务提供上面那两个接口。

## 2. 换本地 TTS 能解决哪一段

| 段 | 本地 TTS 能治吗 |
|---|---|
| ① 主模型生成整轮太慢 | ❌ 不归 TTS 管（可以让它先说结论、别长篇大论） |
| ② 朗读桥等整轮说完才念 | ❌ 那是队列策略（改朗读桥，或自己写服务边生成边念） |
| ③ 浏览器扩展点按钮、等 DOM | ✅ 能绕开（本地服务直接出声，不经过浏览器） |
| ④ 云端合成排队 + 网络 | ✅ 能省掉（本地合成，毫秒到亚秒级） |

> 换句话说：**换本地 TTS 只砍 ③④**。如果慢在 ①②，换什么 TTS 都还是慢 —— 先测再换。

## 3. IndexTTS（B 站开源，中文强、零样本克隆）

- 官方仓库（**唯一官方渠道**）：<https://github.com/index-tts/index-tts>
- 团队：bilibili（IndexTeam），论文 arXiv 2502.05512 / 2506.21619 / 2601.03888
- 版本：**IndexTTS-2.5**（最新，0.8B 参数，中/英/日/西/阿，情感控制、语速控制 `duration_factor`）、IndexTTS-2、IndexTTS-1.5
- **许可**：bilibili Model Use License Agreement（**不是 OSI 开源许可**）。本项目不打包它，只是运行时对接 —— 但你要分发整合包时得看清许可
- **显存**：官方没给硬门槛；0.8B + bf16 推理，8GB 级显卡一般能跑，12GB 更稳（参考音频越长、并发越多越吃显存）。**以官方 README 和你的实测为准**
- **速度**：官方在 RTX 4090 上给的 RTF（生成耗时 / 音频时长，越低越快）——2.5 bf16 约 **0.21**，2.0 fp16 约 **0.33**。也就是 3 秒的话，合成约 0.6–1 秒
- 安装：官方用 `uv` 管环境（`uv sync --all-extras`），NVIDIA 驱动 / CUDA 12.8+；开 BF16（2.5）/ FP16（2）更省显存
- 生产部署：官方提供了 vLLM 的 recipe（见 README 的 "Serving with vLLM"）

> 为什么它适合这个场景：**中文自然 + 单段参考音频就能克隆音色 + 情感/语速可控**。
> 代价也明确：**吃显存、首次加载几十秒**（加载只在启动时发生一次，别每次请求都重载）。

## 4. 接到这个插件上：一个 30 行的本地服务

插件只认两个接口，所以你要的是一个「**IndexTTS 外面套一层 HTTP + 本地播放**」的小服务：

```python
# 示意骨架，不是可直接运行的成品；按你机器上的 IndexTTS 版本改 import 和参数
from fastapi import FastAPI
from indextts.infer_v2_5 import IndexTTS2
import sounddevice as sd, soundfile as sf

app = FastAPI()
# ⚠ 模型只加载一次（几十秒），别放在请求里
tts = IndexTTS2(cfg_path="checkpoints/config.yaml", model_dir="checkpoints", use_bf16=True)
播放中 = False

@app.get("/status")
def status():
    return {"playing": 播放中, "waiting": 0}      # 插件靠它决定闭不闭麦

@app.post("/stop")
def stop():
    sd.stop()                                     # 插件抢话时调它
    return {"ok": True}

@app.post("/speak")
def speak(body: dict):
    tts.infer(spk_audio_prompt="voice.wav", text=body["text"], lang="ZH", output_path="out.wav")
    data, sr = sf.read("out.wav", dtype="float32")
    sd.play(data, sr)
    return {"ok": True}
```

跑起来之后：

1. 服务监听 `127.0.0.1:9000`（别监听 0.0.0.0）
2. 面板「设置 → 摄像头桥」把朗读服务地址改成 `http://127.0.0.1:9000`
3. 手动验证：`curl http://127.0.0.1:9000/status` 能回 JSON、`POST /speak` 能出声
4. 再点面板「开始听」，说一句试试

> 也可以反过来：让 **dsh-tts-bridge 朗读桥**改用 IndexTTS 当后端，本插件什么都不用改
> （它一直只是调 `/status` + `/stop`）。

## 5. 换完还是慢？先查这几条

| 症状 | 多半是 | 怎么办 |
|---|---|---|
| 说完了，很久才开始出声 | 主模型整轮没生成完 / 朗读桥等整轮 | 让回复短一点；或改朗读桥的队列策略（边生成边念） |
| 第一句特别慢，后面正常 | 模型首次加载 | 启动时预热（先合成一句短的），别按请求加载 |
| 合成快，但播不出来 | 输出设备不对 / 被独占 | 选对声卡；别播到虚拟声卡；关掉独占音频的程序 |
| 音色不对 | 参考音频太短/太吵 | 换 5–10 秒干净人声；IndexTTS 是零样本克隆，参考音决定音色 |
| 显存爆了（OOM） | VLM + TTS 抢显存 | VLM 用 4bit、TTS 用 bf16/fp16；或分时加载（先 VLM 判完再加载 TTS） |
| Windows 上起不来 | 依赖 / CUDA 版本 | 按官方 README 用 uv；DeepSpeed 在 Windows 上可以跳过 |

## 6. 其它可选方案（按你的取舍）

| 方案 | 优点 | 代价 |
|---|---|---|
| **IndexTTS 2.5** | 中文自然、零样本克隆、情感/语速可控 | 吃显存、首次加载慢 |
| GPT-SoVITS | 音色克隆成熟、社区大 | 调参繁琐 |
| CosyVoice（阿里） | 流式好、延迟低 | 依赖多，版本差异大 |
| piper | CPU 就能跑、毫秒级 | 音色机械、情感弱 |
| edge-tts | 不用显存、延迟低 | **走微软云，不是本地** |

## 7. 一句话

**先量再换。** 十有八九慢在「整轮生成 + 浏览器点按钮」，而不是 TTS 本身；
真要换，IndexTTS 是中文场景里最省心的选择，但要做好「吃显存、首次加载慢」的准备，
并且**永远先让 `/status` 和 `/stop` 跑通**再动别的。
