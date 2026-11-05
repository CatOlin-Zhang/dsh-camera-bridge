# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
预发布版本发布到 npm 的 `beta` 标签（`npm i dsh-camera-bridge@beta`）。

---

## [0.9.0-beta.1] — 2026-11-05

**首个预发布版**：把「摄像头桥」从自用脚本整理成可以分发给别人安装的插件。

### 新增

- **挂载模块机制**：视觉作为底座，`ctx.effect` + 订阅者模型让做饭这类场景挂在它下面；
  模块自己声明配置项和状态，设置页照着渲染，加新场景不用改前端
- **做饭模块**：设置页里填「想做什么菜」→「开始做」→ 模型查/编菜谱并 `recipe_import` 导入，摄像头按步骤跟
- **自检**：`/api/camera-bridge/selfcheck` + 设置页面板，直接列出缺 ffmpeg / python / 模型 / 权重的哪一项、该放哪
- **摄像头设备下拉**：设置页可以直接选设备，不用手打设备名
- 预发布标记：`/state` 带 `release: { stage, version }`，设置页顶部显示徽章
- `LICENSE`（MIT）、`THIRD-PARTY-NOTICES.md`、`CHANGELOG.md`、`tools/requirements.txt`

### 改变

- **默认配置不再写死开发机路径**：`ffmpegPath` / `pythonPath` / `videoDevice` 默认改为空，
  改为「配置 → 常见安装位置 → PATH」三级解析。以前别人装完直接指向不存在的 `D:\ANACONDA\...`
- `package.json` 去掉 `private`，补 author / keywords / engines，
  版本改 `0.9.0-beta.1`，`publishConfig.tag = beta`
- README 重写：跨平台、说明外部依赖、列出已知限制

### 修复

- **做饭状态机自激循环**：重复导入同名菜谱会重置进度 → 又「起步」→ 又主动开口 → 又导入。
  现在同名菜谱重新导入**保留当前进度**；并且工具层不再重复重置步骤
- **抢话阈值与注释不符**：原来按块计数，50ms 就触发（注释写的是 400ms）。
  改成按毫秒累计，默认 400ms 才打断，回声/碰锅不再误停朗读
- **半双工轮询 500ms 太长**：朗读一停要等半秒耳朵才回来。默认改 200ms
- 有菜谱时「阶段」显示为空：改为显示 `菜谱·<步骤名>`
- 超时提醒里出现 `undefined`：`当.步名` 不存在，应为 `当.步.名称`

### 安全

- **CORS 从 `*` 收紧到同源**：以前任何网页都能调这些本地接口（注会话、改配置、读文件转写）
- **`/inject` 限制在 `clips/` 目录内**：以前可以读任意绝对路径的 wav 并转写

### 许可

- **整个项目改为 AGPL-3.0-or-later**。原因是运行时依赖 `ultralytics`（AGPL-3.0），
  用同一套许可就不存在 MIT 与 AGPL 的冲突。
- 评估过改用 ONNX Runtime 以保留 MIT，**但实测发现 YOLO-World 导出 ONNX 后词表被烘焙进模型，
  会失去开放词表**（详见 `THIRD-PARTY-NOTICES.md` 第三节），与核心体验冲突，故放弃。

### 已知问题

- 界面只有中文
- 没有自动化测试

---

## [0.1.0] — 2026-11-04

内部自用版本：听（SenseVoice）、看（MJPEG）、眼睛（YOLO-World）、盯着（状态机 + 主动开口）。
