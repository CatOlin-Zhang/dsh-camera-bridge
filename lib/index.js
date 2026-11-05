// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 摄像头桥 · 宿主半边
 * ==========================================================================
 * 做三件事（第一版只做第 ①，②③ 的结构先留好）：
 *   ① 听：ffmpeg 抓电脑麦克风 → 能量 VAD 切句 → SenseVoice 转写 → 当成你的话送进会话
 *   ② 看：ffmpeg 把 RTSP 拉成 MJPEG 给面板，低频抽帧喂 YOLO（下一版）
 *   ③ 盯：常驻观察 + 状态机，只在有事时开口（下一版）
 *
 * ⚠ 说话那半截不归我管：会话里回出来的字，由朗读桥（dsh-tts-bridge）念。
 *   我这里只负责「把嘴巴听到的变成会话里的一条 user 消息」。
 *
 * ⚠ 每一段都打时间戳（判停/转写/送达/总耗时），落到 timing.jsonl，
 *   面板上直接显示上一轮各段耗时 —— 拿数据调，不靠猜。
 */
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'camera-bridge'
export const inject = ['webServer', 'timer', 'agents', 'sessions', 'sessionTitle', 'tools', 'systemPrompt']

/** 包根目录（拿 tools/ 里的东西用） */
const 包根 = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH家 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 目录 = join(DSH家, 'camera-bridge')
const 配置路径 = join(DSH家, 'camera-bridge.json')
const 计时路径 = join(目录, 'timing.jsonl')
const 音频目录 = join(目录, 'clips')
const 截图目录 = join(目录, 'shots')
const P = '/api/camera-bridge'

/** 版本号从 package.json 读（不写死，免得两处对不上） */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(包根, 'package.json'), 'utf8'))
    return String(p.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/**
 * 发布阶段：pre = 预发布。
 * 面板上要显示出来 —— 预发布意味着「能用，但功能/配置键可能变」，别让人以为是稳定版。
 */
const 发布阶段 = 'pre'

/** 默认配置。都在面板「设置」里能改，改完写进 camera-bridge.json。 */
const 默认配置 = {
  /** RTSP 源。留空 = 用本机摄像头（先用它把链路跑通） */
  rtspUrl: '',
  /** 本机视频设备（留空 = 自动挑：优先名字里带「摄像头 / camera / webcam」的） */
  videoDevice: '',
  /** 麦克风设备名（空 = 自动挑，优先含「麦克风 / Microphone」的） */
  micDevice: '',
  /** ffmpeg 路径（空 = 先找常见位置，再退回 PATH 里的 ffmpeg） */
  ffmpegPath: '',
  /** 跑 ASR 的 python（空 = 先找常见位置，再退回 PATH 里的 python/python3） */
  pythonPath: '',
  /** SenseVoice 模型目录（空 = <DSH_HOME>/camera-bridge/models/sense-voice） */
  asrModelDir: '',
  /** 送到哪个会话（空 = 面板里选） */
  targetSession: '',
  /** 识别完自动发（对讲机模式） */
  autoSend: true,
  /** 静音多久算说完（毫秒） */
  silenceMs: 800,
  /** 一句话最短多长（毫秒） */
  minSpeechMs: 300,
  /** 一句话最长多长（毫秒，超了强制切） */
  maxSpeechMs: 15000,
  /**
   * 朗读服务的位置（默认指向朗读桥 /dsh-tts-bridge）。
   *
   * 本插件只用到它的两个接口：
   *   GET  <base>/status  → {"playing": true/false, "waiting": 排队几条}
   *   POST <base>/stop    → 停止播放
   * 换成别的本地 TTS，只要提供这两个接口，把这里改掉就行；
   * 留空 = 不用（不做半双工、也不抢话）。
   */
  ttsBase: '/dsh-tts-bridge',
  /** 半双工：朗读在念的时候不听，免得把自己的声音当成你说的 */
  halfDuplex: true,
  /** 朗读时允许抢话（比喇叭响 400ms 就打断） */
  allowInterrupt: true,
  /** 抢话门槛：麦克风 RMS 超过它才算「她真在说话」（0.03 很灵敏 … 0.2 很钝） */
  interruptRms: 0.08,
  /** 抢话要「够响够久」：连续超过门槛多少毫秒才算抢话（原来按块计数，50ms 就误触发） */
  interruptMs: 400,
  /** 半双工多久问一次朗读桥在不在念（毫秒）。越小越跟手，越大越省 */
  duplexPollMs: 200,
  /** 麦克风增益 */
  micGain: 1,
  /** 说话前保留多少毫秒（preroll） */
  prerollMs: 300,
  /** 画面：宽度 / 帧率 / jpeg 质量（2 最好 31 最差） */
  videoWidth: 640,
  videoFps: 8,
  videoQuality: 6,
  /** 眼睛：开着就一直认（YOLO-World），关着就只在需要时抓一张 */
  lookOn: false,
  /** 权重路径（空 = <DSH_HOME>/camera-bridge/models/yolov8s-worldv2.pt） */
  yoloModel: '',
  /** 词表：英文更准，显示时会翻成中文 */
  lookClasses: 'pot,pan,wok,knife,cutting board,bowl,plate,food,vegetables,egg,oil,steam,smoke,flame,hand,person,stove,spatula',
  lookConf: 0.25,
  lookHz: 2,
  /** 盯着：一直看画面、判阶段、有事才开口 */
  watchOn: false,
  /** 阶段一变就主动说话（关掉 = 只更新状态、不出声） */
  watchSpeak: true,
  /** 同一件异常多久内不重复说（秒） */
  watchCooldown: 90,
  /** 主动开口用哪个会话（空 = 跟 targetSession 一样） */
  watchSession: '',
  /** 做饭模块：想做什么菜（面板上填，点「开始做」就让模型编菜谱导进来） */
  cookDish: '',
}

/** 运行时状态（只给面板看的，不落盘） */
const 状态 = {
  listening: false,
  level: 0,
  peak: 0,
  vad: 'idle', // idle | listening | speech | suppress
  device: '',
  lastText: '',
  lastAt: 0,
  error: '',
  asrReady: false,
  ffmpegOk: null,
  timing: [], // 最近若干轮
  diag: [],
  video: { on: false, 宽: 0, 高: 0, at: 0, device: '', error: '' },
  mic: { rms: 0, 打断次数: 0, 上次打断: 0, 回声力度: null },
  look: { on: false, at: 0, 摘要: '', 物体: [], 毫秒: 0, 错误: '', 设备: '', 准备: '' },
  watch: {
    on: false,
    阶段: '',
    依据: '',
    变于: 0,
    开口数: 0,
    上次开口: '',
    上次开口于: 0,
    候选: null,
    连续: 0,
    当前异常: '',
    历史: [],
    // 菜谱进度
    步骤: -1,
    步名: '',
    步开始: 0,
    疑似: '',
    // 比例尺（估分量用）
    比例尺: null,
  },
}

function 记账(message) {
  const line = String(message)
  状态.diag.push({ at: Date.now(), message: line })
  if (状态.diag.length > 60) 状态.diag.shift()
  try {
    console.log('[camera-bridge] ' + line)
  } catch {}
}

/**
 * ⚠ 2026-11-04：事件回调里抛出的**同步**异常 = 未捕获异常 = 整个宿主退出
 *   （她就是这么看到「应用无法启动或已意外停止」的）。
 *   所以凡是 spawn 出来的子进程，监听器统一套一层 try/catch —— 一个回调写错，
 *   最多是这个功能不工作，不会把 DSH 带走。
 */
function 安全(fn) {
  return function (...参数) {
    try {
      return fn.apply(this, 参数)
    } catch (error) {
      try {
        记账('回调出错：' + ((error && error.message) || error))
      } catch {}
    }
  }
}

function spawn安全(...参数) {
  const proc = spawn(...参数)
  try {
    const 原on = proc.on.bind(proc)
    proc.on = (名, fn) => 原on(名, 安全(fn))
  } catch {}
  return proc
}

function 确保目录() {
  for (const d of [目录, 音频目录, 截图目录]) {
    try {
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
    } catch (error) {
      记账('建目录失败 ' + d + '：' + (error && error.message))
    }
  }
}

function 读配置() {
  try {
    if (!existsSync(配置路径)) return { ...默认配置 }
    const 掉 = JSON.parse(readFileSync(配置路径, 'utf8'))
    return { ...默认配置, ...(掉 && typeof 掉 === 'object' ? 掉 : {}) }
  } catch (error) {
    记账('读配置失败：' + (error && error.message))
    return { ...默认配置 }
  }
}

function 存配置(patch) {
  const 现在 = 读配置()
  const 下一份 = { ...现在 }
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in 默认配置)) continue
    if (typeof 默认配置[k] === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) 下一份[k] = n
    } else if (typeof 默认配置[k] === 'boolean') {
      下一份[k] = !!v
    } else {
      下一份[k] = String(v ?? '')
    }
  }
  确保目录()
  try {
    writeFileSync(配置路径, JSON.stringify(下一份, null, 2), 'utf8')
  } catch (error) {
    记账('写配置失败：' + (error && error.message))
  }
  return 下一份
}

function 模型目录(配置) {
  const 给定 = String(配置.asrModelDir || '').trim()
  return 给定 || join(目录, 'models', 'sense-voice')
}

/**
 * 找外部程序（ffmpeg / python）。
 *
 * ⚠ 分发版的坑：以前默认值写死了开发机上的 `D:\ANACONDA\...`，别人装完直接指向一个
 *   不存在的路径，而且不会退回 PATH —— 等于装上就废。现在改成三级：
 *     ① 配置里明确写了 → 用它（老用户/自定义环境不受影响）
 *     ② 常见安装位置里存在的 → 用它
 *     ③ 都没有 → 退回命令名，交给系统 PATH
 *
 * @param {string} 配置值   面板里填的路径
 * @param {string[]} 候选们 常见位置（按平台给，不存在的会被跳过）
 * @param {string} 命令名   最后兜底交给 PATH 的名字（ffmpeg / python）
 */
function 解析程序(配置值, 候选们, 命令名) {
  const 给定 = String(配置值 || '').trim()
  if (给定) return 给定
  for (const p of 候选们) {
    try {
      if (p && existsSync(p)) return p
    } catch {}
  }
  return 命令名
}

/** 各平台常见的 ffmpeg 位置（找不到就交给 PATH） */
const ffmpeg候选 = (() => {
  const 表 = []
  if (process.platform === 'win32') {
    表.push(
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Links\\ffmpeg.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    )
    // Anaconda / Miniconda 自带的那个（很多人装 AI 环境时顺手就有了）
    for (const 根 of [process.env.CONDA_PREFIX, process.env.USERPROFILE && join(process.env.USERPROFILE, 'anaconda3'), process.env.USERPROFILE && join(process.env.USERPROFILE, 'miniconda3')]) {
      if (根) 表.push(join(根, 'Library', 'bin', 'ffmpeg.exe'), join(根, 'bin', 'ffmpeg.exe'))
    }
  } else {
    表.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg')
  }
  return 表.filter(Boolean)
})()

/** 各平台常见的 python 位置（找不到就交给 PATH） */
const python候选 = (() => {
  const 表 = []
  if (process.platform === 'win32') {
    for (const 根 of [process.env.CONDA_PREFIX, process.env.USERPROFILE && join(process.env.USERPROFILE, 'anaconda3'), process.env.USERPROFILE && join(process.env.USERPROFILE, 'miniconda3')]) {
      if (根) 表.push(join(根, 'python.exe'))
    }
    表.push('C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe')
  } else {
    表.push('/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3')
  }
  return 表.filter(Boolean)
})()

/** 本插件实际用的 ffmpeg / python（每次现算，配置改完立即生效） */
function ffmpeg路径(配置) {
  return 解析程序(配置.ffmpegPath, ffmpeg候选, 'ffmpeg')
}
function python路径(配置) {
  return 解析程序(配置.pythonPath, python候选, process.platform === 'win32' ? 'python' : 'python3')
}

// ---------------------------------------------------------------- 传输小工具

/**
 * CORS：只给「本机面板自己」放行。
 *
 * ⚠ 以前是 `Access-Control-Allow-Origin: '*'` —— 意思是**你浏览器里开着的任意网页**
 *   都能调这些本地接口（注会话、改配置、读文件转写）。自己用问题不大，分发给别人就是洞。
 *   现在只回显与宿主同源的 Origin；外站拿不到 ACAO，浏览器会拦掉。
 */
function 组头(origin) {
  const h = {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    Vary: 'Origin',
  }
  if (origin) h['Access-Control-Allow-Origin'] = origin
  return h
}

/** 兼容老代码里 `...头` 的写法（不带 ACAO，相当于默认拒绝跨站） */
const 头 = 组头('')

/** 请求是不是来自本机面板；是就返回它的 Origin（回显用），不是就返回空 */
function 允许来源(ctx, req) {
  let 本机 = ''
  try {
    本机 = String(ctx.webServer.getOrigin() || '').trim()
  } catch {}
  const 来 = String((req && req.headers && req.headers.origin) || '').trim()
  if (!来) return 本机 || '' // 同源请求/非浏览器：给本机源也无害
  return 来 === 本机 ? 来 : ''
}

function 回(res, code, 对象) {
  try {
    const body = Buffer.from(JSON.stringify(对象), 'utf8')
    res.writeHead(code, {
      ...组头(res.__origin || ''),
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch (error) {
    记账('回包失败：' + (error && error.message))
  }
}

function 读体(req) {
  return new Promise((resolve) => {
    let 块 = ''
    req.on('data', (c) => {
      块 += c
      if (块.length > 1e6) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(块 ? JSON.parse(块) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// ---------------------------------------------------------------- 麦克风 / VAD

/**
 * 一个听音器：ffmpeg 抓 dshow 麦克风 → 16k 单声道 s16le 从 stdout 出来。
 * 20ms 一帧做能量判定；静音够久就切一句出来交给转写。
 */
class 听音器 {
  constructor(ctx, 配置, 交出去) {
    this.ctx = ctx
    this.配置 = 配置
    this.交出去 = 交出去
    this.proc = null
    this.残余 = Buffer.alloc(0)
    this.帧长 = 640 // 20ms * 16000 * 2 字节
    this.噪声底 = 0.001
    this.静音帧 = 0
    this.有声帧 = 0
    this.前摇 = [] // preroll
    this.当前 = []
    this.在说 = false
    this.打断于 = 0
    this.句末有声于 = 0
    this.开始于 = 0
    this.响毫秒 = 0
    this.响包络 = []
    this.打断 = null
  }

  async 起() {
    const 设备 = await 挑麦克风(this.ctx, this.配置)
    if (!设备) {
      状态.error = '找不到可用的麦克风（ffmpeg -list_devices 里没有 audio 设备）'
      throw new Error(状态.error)
    }
    this.设备 = 设备
    状态.device = 设备

    const ff = ffmpeg路径(this.配置)
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-audio_buffer_size', '50', // 50ms 缓冲，越小越跟手（太小会爆音）
      '-i', 'audio=' + 设备,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-',
    ]
    记账('起麦克风：' + 设备)
    const proc = spawn安全(ff, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc

    proc.stdout.on('data', (块) => this.吃(块))
    proc.stderr.on('data', (块) => {
      const 文 = String(块 || '').trim()
      if (文) 记账('ffmpeg: ' + 文.slice(0, 200))
    })
    proc.on('error', (error) => {
      状态.error = 'ffmpeg 起不来：' + (error && error.message)
      记账(状态.error)
      状态.listening = false
    })
    proc.on('exit', (code) => {
      this.proc = null
      const 还有 = 状态.listening
      状态.listening = false
      状态.vad = 'idle'
      if (还有) {
        状态.error = '麦克风断了（ffmpeg 退出码 ' + code + '）——多半是设备被别的程序占着'
        记账(状态.error)
      }
    })
  }

  停() {
    const proc = this.proc
    this.proc = null
    if (proc) {
      try {
        proc.kill()
      } catch {}
    }
    this.当前 = []
    this.前摇 = []
    this.在说 = false
    this.静音帧 = 0
    this.有声帧 = 0
  }

  吃(块) {
    if (!状态.listening) return
    if (状态.vad === 'suppress') {
      this.打断判(块)
      return
    }
    let buf = this.残余.length ? Buffer.concat([this.残余, 块]) : 块
    const 整 = Math.floor(buf.length / this.帧长)
    for (let i = 0; i < 整; i++) {
      const 帧 = buf.subarray(i * this.帧长, (i + 1) * this.帧长)
      this.判(帧)
    }
    this.残余 = buf.subarray(整 * this.帧长)
  }

  判(帧) {
    const 配置 = this.配置
    // 归一化 RMS
    let 和 = 0
    for (let i = 0; i < 帧.length; i += 2) {
      const v = 帧.readInt16LE(i) / 32768
      和 += v * v
    }
    const rms = Math.sqrt(和 / (帧.length / 2)) * (配置.micGain || 1)
    状态.level = Math.min(1, rms * 8)
    状态.peak = Math.max(状态.peak * 0.98, 状态.level)

    const 阈 = Math.max(this.噪声底 * 3, 0.008)
    const 有声 = rms > 阈

    if (!this.在说) {
      // 闲着：噪声底跟着走
      this.噪声底 = Math.min(0.02, Math.max(0.0004, this.噪声底 * 0.98 + rms * 0.02))
      this.前摇.push(帧)
      if (this.前摇.length > Math.ceil((配置.prerollMs || 300) / 20)) this.前摇.shift()
      if (有声) {
        this.有声帧++
        if (this.有声帧 >= 5) {
          this.在说 = true
          this.静音帧 = 0
          this.当前 = this.前摇.slice()
          this.开始于 = Date.now()
          状态.vad = 'speech'
        }
      } else {
        this.有声帧 = 0
      }
      return
    }

    // 正在说
    this.当前.push(帧)
    if (有声) {
      this.静音帧 = 0
      this.句末有声于 = Date.now()
    } else {
      this.静音帧++
    }
    const 静音毫秒 = this.静音帧 * 20
    const 总毫秒 = this.当前.length * 20
    if (静音毫秒 >= (配置.silenceMs || 800) || 总毫秒 >= (配置.maxSpeechMs || 15000)) {
      const 句子 = this.当前
      this.当前 = []
      this.在说 = false
      this.静音帧 = 0
      this.有声帧 = 0
      状态.vad = 'listening'
      this.交句子(句子, 静音毫秒)
    }
  }

  /**
   * 朗读桥在念的时候：默认闭麦（免得把它自己的声音当成她在说）。
   * 但如果她**明显比喇叭响**、而且持续 400ms，就当她抢话 —— 把朗读停掉，立刻开始听。
   * （没做回声消除，只能靠「够响够久」这个土办法；阈值调大就少误判，调小就更灵敏。）
   */
  打断判(块) {
    if (!this.配置.allowInterrupt) return
    let 和 = 0
    const 样 = Math.floor(块.length / 2)
    if (!样) return
    for (let i = 0; i < 样 * 2; i += 2) {
      const v = 块.readInt16LE(i) / 32768
      和 += v * v
    }
    const rms = Math.sqrt(和 / 样)
    // 音量包络：要能证明「她开始说话」是喇叭关掉之后才有的，不是喇叭自己的回声
    this.响包络 = this.响包络.filter((x) => Date.now() - x.at < 600)
    this.响包络.push({ at: Date.now(), rms })

    const 门槛 = Math.max(0.03, Number(this.配置.interruptRms) || 0.08)
    状态.mic.rms = Math.max(状态.mic.rms * 0.9, rms)
    // ⚠ 2026-11-05：原来是 `响帧 += Math.round(样/160)`，50ms 一块加 5 分、门槛却是 4 ——
    //   等于**一块就触发**，注释写的「400ms」根本没达到。朗读的回声、碰一下锅都能把朗读打断。
    //   现在按毫秒累计：够响就要够久（默认 400ms），掉下去就快速衰减。
    const 块毫秒 = 样 / 16 // 16k 采样 → 每采样 1/16 毫秒
    if (rms > 门槛) this.响毫秒 += 块毫秒
    else this.响毫秒 = Math.max(0, this.响毫秒 - 块毫秒 * 2)
    if (this.响毫秒 >= Math.max(100, Number(this.配置.interruptMs) || 400)) {
      this.响毫秒 = 0
      if (this.打断) {
        try {
          this.打断()
        } catch {}
      }
    }
  }

  /** 喇叭停了之后，麦克风里的声音掉下去多少？（掉得越多越像回声） */
  回声力度() {
    const 们 = this.响包络
    if (们.length < 2) return 1
    const 前 = Math.max(...们.map((x) => x.rms))
    const 后 = 们[们.length - 1].rms
    if (前 <= 1e-6) return 1
    return 后 / 前
  }

  交句子(帧们, 判停毫秒) {
    const PCM = Buffer.concat(帧们)
    const 语音毫秒 = PCM.length / 32 // 16000*2 字节每秒 → 每毫秒 32 字节
    if (语音毫秒 < (this.配置.minSpeechMs || 300)) return
    const 末次有声 = this.句末有声于 || Date.now()
    this.交出去(PCM, {
      语音毫秒: Math.round(语音毫秒),
      判停毫秒: Math.round(判停毫秒),
      末次有声,
    })
  }
}

/** 挑麦克风：优先配置里那个，其次「像真麦克风」的，最后第一个 audio 设备 */
async function 挑麦克风(ctx, 配置) {
  const 指定 = String(配置.micDevice || '').trim()
  const 列表 = await 列音频设备(ctx, 配置)
  // 配的那个如果这台机器上根本没有（换设备、名字打错），别硬撞，退回自动挑
  if (指定 && (!列表.length || 列表.includes(指定))) return 指定
  if (指定 && 列表.length) 记账('配置的麦克风不在了（' + 指定 + '），自动挑一个')
  if (!列表.length) return ''
  // ⚠ 虚拟设备（网易云音乐、Voicemeeter、VB-Cable…）经常也报成 audio，而且永远是静音/回环，
  //   优先挑到它就等于「装了个听不见的耳朵」。所以先把它们排后面。
  const 像虚拟 = /虚拟|virtual|网易|voicemeeter|vb-audio|vb cable|cable output|stereo mix|立体声混音/i
  const 真的 = 列表.filter((n) => !像虚拟.test(n))
  const 池 = 真的.length ? 真的 : 列表
  const 优先 = 池.find((n) => /麦克风|microphone|mic/i.test(n))
  return 优先 || 池[0]
}

/** 跑一次 ffmpeg -list_devices，抠出某一类设备名（audio / video） */
function 列设备(ctx, 配置, 类型) {
  return new Promise((resolve) => {
    const ff = ffmpeg路径(配置)
    const 收 = []
    let buf = ''
    let proc
    // ⚠ 2026-11-04 血的教训：这里原来是 new RegExp('...\\s+\\' + 想要)，
    //   想要 = "(audio)" → 拼出来是 /\s+\(audio)/ —— 转了左括号、没转右括号 →
    //   **SyntaxError: Unmatched ')'**，而且是在 ffmpeg 的 exit 回调里抛的：
    //   事件回调里的同步异常 = 未捕获异常 = **整个 DSH 宿主退出**（她看到的
    //   「应用无法启动或已意外停止」，日志里写着 dsh: fatal uncaught exception）。
    //   现在：括号两边都转义，而且整段回调包在 try 里 —— 这种地方绝不能再抛出去。
    const 规源 = '\\]\\s+"([^"]+)"\\s+\\(' + String(类型).replace(/[^a-z]/gi, '') + '\\)'
    let 规 = null
    try {
      规 = new RegExp(规源)
    } catch (error) {
      记账('设备名正则拼错了（' + 规源 + '）：' + ((error && error.message) || error))
      规 = null
    }
    try {
      proc = spawn安全(ff, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(收)
      return
    }
    const 吃 = (块) => {
      try {
        buf += String(块 || '')
      } catch {}
    }
    proc.stdout.on('data', 吃)
    proc.stderr.on('data', 吃)
    const 完 = () => {
      try {
        if (规) {
          for (const 行 of buf.split(/\r?\n/)) {
            const m = 行.match(规)
            if (m) 收.push(m[1])
          }
        }
      } catch (error) {
        记账('解析设备名出错：' + ((error && error.message) || error))
      }
      resolve([...new Set(收)])
    }
    proc.on('exit', 完)
    proc.on('error', () => resolve(收))
  })
}

const 列音频设备 = (ctx, 配置) => 列设备(ctx, 配置, 'audio')
const 列视频设备 = (ctx, 配置) => 列设备(ctx, 配置, 'video')

// ---------------------------------------------------------------- 转写工人

/**
 * 常驻 python 工人：一行一条 {"wav": 路径}，回来一行 {"ok","text","ms"}。
 * 冷启动一次（加载模型 ~0.3-1s），之后每句只要几十毫秒。
 */
class 转写工人 {
  constructor(ctx, 配置) {
    this.ctx = ctx
    this.配置 = 配置
    this.proc = null
    this.排队 = []
    this.就绪 = null
    this.缓存 = ''
  }

  路径() {
    return join(包根, 'tools', 'asr_worker.py')
  }

  起() {
    if (this.proc) return Promise.resolve(true)
    const py = python路径(this.配置)
    const 模型 = 模型目录(this.配置)
    if (!existsSync(join(模型, 'model.int8.onnx'))) {
      const 错 = '模型还没装：' + 模型 + '（面板「自检」里有一键安装命令）'
      状态.error = 错
      记账(错)
      return Promise.reject(new Error(错))
    }
    const args = [this.路径(), '--model', 模型]
    记账('起转写工人：' + py)
    const proc = spawn安全(py, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', KMP_DUPLICATE_LIB_OK: 'TRUE' },
    })
    this.proc = proc
    this.缓存 = ''

    const 就绪 = new Promise((resolve, reject) => {
      const 超时 = setTimeout(() => reject(new Error('转写工人 20 秒没就绪')), 20000)
      this.就绪 = (值) => {
        clearTimeout(超时)
        resolve(值)
      }
      this.就绪失败 = (错) => {
        clearTimeout(超时)
        reject(new Error(错))
      }
    })

    proc.stdout.on('data', (块) => this.吃(块))
    proc.stderr.on('data', (块) => {
      const 文 = String(块 || '').trim()
      if (文) 记账('asr: ' + 文.slice(0, 300))
    })
    proc.on('error', (error) => {
      this.proc = null
      状态.asrReady = false
      if (this.就绪失败) this.就绪失败('python 起不来：' + (error && error.message))
    })
    proc.on('exit', (code) => {
      this.proc = null
      状态.asrReady = false
      const 剩 = this.排队
      this.排队 = []
      for (const r of 剩) r.失败(new Error('转写工人退出（' + code + '）'))
      if (this.就绪失败) this.就绪失败('转写工人退出（' + code + '）')
    })
    return 就绪
  }

  吃(块) {
    this.缓存 += String(块 || '')
     let 行们 = this.缓存.split('\n')
    this.缓存 = 行们.pop() || ''
    for (const 行 of 行们) {
      const 文 = 行.trim()
      if (!文) continue
      let 对象 = null
      try {
        对象 = JSON.parse(文)
      } catch {
        记账('asr 非 json 输出：' + 文.slice(0, 160))
        continue
      }
      if (对象.ready) {
        状态.asrReady = true
        状态.error = ''
        记账('转写工人就绪')
        if (this.就绪) this.就绪(true)
        continue
      }
      if (对象.fatal) {
        状态.asrReady = false
        状态.error = '转写工人起不来：' + 对象.error
        记账(状态.error)
        if (this.就绪失败) this.就绪失败(对象.error)
        continue
      }
      const 等 = this.排队.shift()
      if (!等) continue
      if (对象.ok) 等.成功(对象)
      else 等.失败(new Error(对象.error || '转写失败'))
    }
  }

  async 转写(wav路径) {
    await this.起()
    return new Promise((resolve, reject) => {
      this.排队.push({ 成功: resolve, 失败: reject })
      try {
        this.proc.stdin.write(JSON.stringify({ wav: wav路径 }) + '\n')
      } catch (error) {
        this.排队.pop()
        reject(error)
      }
    })
  }

  停() {
    const proc = this.proc
    this.proc = null
    状态.asrReady = false
    if (proc) {
      try {
        proc.kill()
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- 画面

/** 从 jpeg 头里读宽高（不引库，就扫 SOF 段） */
function jpeg尺寸(buf) {
  try {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const 段 = buf[i + 1]
      if (段 >= 0xc0 && 段 <= 0xcf && 段 !== 0xc4 && 段 !== 0xc8 && 段 !== 0xcc) {
        return { 高: buf.readUInt16BE(i + 5), 宽: buf.readUInt16BE(i + 7) }
      }
      const 长 = buf.readUInt16BE(i + 2)
      if (!长) break
      i += 2 + 长
    }
  } catch {}
  return { 宽: 0, 高: 0 }
}

/**
 * 一路视频：ffmpeg 从 RTSP（或本机摄像头）解出 JPEG 帧，只留最新的那一帧。
 * - 面板的 <img> 定时来取（不用每帧推）
 * - 「看摄像头」工具直接拿这一帧存成文件
 * 一个解码器服务所有出口 —— 摄像头不能被打开两次。
 */
class 视频源 {
  constructor(ctx, 读配置) {
    this.ctx = ctx
    this.读配置 = 读配置
    this.proc = null
    this.残余 = Buffer.alloc(0)
    this.最新 = null
    this.最新于 = 0
    this.帧数 = 0
    this.错误 = ''
    this.设备 = ''
  }

  async 源参数() {
    const 配置 = this.读配置()
    const url = String(配置.rtspUrl || '').trim()
    if (url) {
      if (!/^rtsps?:\/\//i.test(url)) throw new Error('RTSP 地址得是 rtsp:// 或 rtsps:// 开头')
      return ['-rtsp_transport', 'tcp', '-i', url]
    }
    let 设备 = String(配置.videoDevice || '').trim()
    if (!设备) {
      const 们 = await 列视频设备(this.ctx, 配置)
      设备 = 们.find((n) => /摄像头|camera|webcam/i.test(n)) || 们[0] || ''
    }
    if (!设备) throw new Error('没有视频源：RTSP 地址空着，本机也没找到摄像头')
    this.设备 = 设备
    return ['-f', 'dshow', '-i', 'video=' + 设备]
  }

  async 起() {
    if (this.proc) return true
    const 配置 = this.读配置()
    const 源 = await this.源参数()
    const 宽 = Math.max(160, Number(配置.videoWidth) || 640)
    const 帧率 = Math.max(1, Math.min(30, Number(配置.videoFps) || 8))
    const 质 = Math.max(2, Math.min(31, Number(配置.videoQuality) || 6))
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...源,
      '-an',
      '-vf', 'fps=' + 帧率 + ',scale=' + 宽 + ':-2',
      '-q:v', String(质),
      '-f', 'image2pipe', '-vcodec', 'mjpeg',
      '-',
    ]
    记账('起画面：' + (配置.rtspUrl ? String(配置.rtspUrl).replace(/\/\/[^@]*@/, '//***@') : 'video=' + this.设备))
    const proc = spawn安全(ffmpeg路径(配置), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.proc = proc
    this.错误 = ''
    this.残余 = Buffer.alloc(0)

    proc.stdout.on('data', (块) => this.吃(块))
    proc.stderr.on('data', (块) => {
      const 文 = String(块 || '').trim()
      if (文) {
        this.错误 = 文.slice(0, 300)
        记账('画面 ffmpeg: ' + this.错误)
      }
    })
    proc.on('error', (error) => {
      this.proc = null
      this.错误 = 'ffmpeg 起不来：' + (error && error.message)
      记账(this.错误)
    })
    proc.on('exit', (code) => {
      this.proc = null
      if (状态.video.on) {
        this.错误 = '画面断了（ffmpeg 退出码 ' + code + '）'
        记账(this.错误)
      }
      状态.video.on = false
    })
    状态.video.on = true
    状态.video.device = this.设备
    return true
  }

  停() {
    const proc = this.proc
    this.proc = null
    this.残余 = Buffer.alloc(0)
    状态.video.on = false
    if (proc) {
      try {
        proc.kill()
      } catch {}
    }
  }

  吃(块) {
    let buf = this.残余.length ? Buffer.concat([this.残余, 块]) : 块
    let 位置 = 0
    let 拿到 = 0
    while (位置 < buf.length) {
      const 始 = buf.indexOf(Buffer.from([0xff, 0xd8]), 位置)
      if (始 < 0) break
      const 终 = buf.indexOf(Buffer.from([0xff, 0xd9]), 始 + 2)
      if (终 < 0) break
      const 帧 = buf.subarray(始, 终 + 2)
      if (帧.length > 2000) {
        this.最新 = Buffer.from(帧)
        this.最新于 = Date.now()
        this.帧数++
        拿到++
      }
      位置 = 终 + 2
    }
    this.残余 = buf.subarray(位置)
    if (this.残余.length > 4 * 1024 * 1024) this.残余 = Buffer.alloc(0)
    if (拿到) {
      const { 宽, 高 } = jpeg尺寸(this.最新)
      状态.video.宽 = 宽
      状态.video.高 = 高
      状态.video.at = this.最新于
    }
  }

  /** 等一帧「比 after 新」的画面 */
  等一帧(after, 超时毫秒 = 8000) {
    if (this.最新 && this.最新于 > after) return Promise.resolve(this.最新)
    return new Promise((resolve) => {
      const 开始 = Date.now()
      const 查 = setInterval(() => {
        if (this.最新 && this.最新于 > after) {
          clearInterval(查)
          resolve(this.最新)
          return
        }
        if (Date.now() - 开始 > 超时毫秒) {
          clearInterval(查)
          resolve(null)
        }
      }, 100)
    })
  }
}

// ---------------------------------------------------------------- 眼睛（YOLO-World）

/** 英文词表 → 中文（YOLO-World 的 CLIP 认英文更准，给它中文会飘） */
const 词表中文 = {
  // 厨房那套（开放词表用的）
  pot: '锅', pan: '平底锅', wok: '炒锅', knife: '刀', 'cutting board': '砧板',
  bowl: '碗', plate: '盘子', food: '食物', vegetables: '菜', egg: '鸡蛋',
  oil: '油', steam: '蒸汽', smoke: '烟', flame: '火', hand: '手',
  person: '人', stove: '灶台', spatula: '锅铲', spoon: '勺子', chopsticks: '筷子',
  water: '水', sink: '水池', refrigerator: '冰箱', microwave: '微波炉', oven: '烤箱',
  // 模型自带那 80 类（没装 CLIP 时的退路）
  cup: '杯子', fork: '叉子', bottle: '瓶子', 'wine glass': '酒杯', banana: '香蕉',
  apple: '苹果', sandwich: '三明治', orange: '橙子', broccoli: '西兰花', carrot: '胡萝卜',
  'hot dog': '热狗', pizza: '披萨', donut: '甜甜圈', cake: '蛋糕', chair: '椅子',
  'dining table': '餐桌', 'potted plant': '盆栽', couch: '沙发', bed: '床',
  tv: '电视', laptop: '笔记本电脑', mouse: '鼠标', remote: '遥控器', keyboard: '键盘',
  'cell phone': '手机', toaster: '烤面包机', book: '书', clock: '时钟', vase: '花瓶',
  scissors: '剪刀', 'teddy bear': '玩具熊', 'hair drier': '吹风机', toothbrush: '牙刷',
  'sports ball': '球', backpack: '背包', umbrella: '雨伞', 'tie': '领带', suitcase: '行李箱',
}

function 中文名(label) {
  const 原 = String(label || '')
  return 词表中文[原] || 词表中文[原.toLowerCase()] || 原
}

/** 常驻的 YOLO 工人：一行 jpg 路径进去，一行检测结果出来 */
class 检测器 {
  constructor(ctx, 读配置) {
    this.ctx = ctx
    this.读配置 = 读配置
    this.proc = null
    this.排队 = []
    this.缓存 = ''
    this.就绪 = false
    this.设备 = ''
    this.词表 = []
  }

  权重() {
    const 配置 = this.读配置()
    return String(配置.yoloModel || '').trim() || join(目录, 'models', 'yolov8s-worldv2.pt')
  }

  async 起() {
    if (this.proc) return this.就绪
    const 配置 = this.读配置()
    const 权重 = this.权重()
    if (!existsSync(权重)) throw new Error('还没有 YOLO 权重：' + 权重)
    const py = python路径(配置)
    const args = [join(包根, 'tools', 'yolo_worker.py'), '--model', 权重, '--classes', String(配置.lookClasses || ''), '--conf', String(Number(配置.lookConf) || 0.25)]
    记账('起眼睛：YOLO-World（' + 权重.split('\\').pop() + '）')
    const proc = spawn安全(py, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', KMP_DUPLICATE_LIB_OK: 'TRUE' },
    })
    this.proc = proc
    this.缓存 = ''
    this.就绪 = false

    const 就绪 = new Promise((resolve, reject) => {
      const 超时 = setTimeout(() => reject(new Error('YOLO 180 秒没就绪')), 180000)
      this.好了 = (v) => {
        clearTimeout(超时)
        resolve(v)
      }
      this.坏了 = (e) => {
        clearTimeout(超时)
        reject(new Error(e))
      }
    })

    proc.stdout.on('data', (块) => this.吃(块))
    proc.stderr.on('data', (块) => {
      const 文 = String(块 || '').trim()
      if (文) 记账('yolo: ' + 文.slice(0, 240))
    })
    proc.on('error', (error) => {
      this.proc = null
      this.就绪 = false
      if (this.坏了) this.坏了('python 起不来：' + (error && error.message))
    })
    proc.on('exit', (code) => {
      this.proc = null
      this.就绪 = false
      const 剩 = this.排队
      this.排队 = []
      for (const r of 剩) r.失败(new Error('眼睛退出（' + code + '）'))
      if (this.坏了) this.坏了('眼睛退出（' + code + '）')
    })
    return 就绪
  }

  吃(块) {
    this.缓存 += String(块 || '')
    const 行们 = this.缓存.split('\n')
    this.缓存 = 行们.pop() || ''
    for (const 行 of 行们) {
      const 文 = 行.trim()
      if (!文) continue
      let 对象
      try {
        对象 = JSON.parse(文)
      } catch {
        记账('yolo 非 json：' + 文.slice(0, 140))
        continue
      }
      if (对象.progress) {
        记账('yolo: ' + 对象.progress)
        状态.look.准备 = String(对象.progress)
        continue
      }
      if (对象.ready) {
        this.就绪 = true
        this.设备 = String(对象.device || '')
        this.词表 = 对象.classes || []
        if (对象.warn) 记账('yolo 警告：' + 对象.warn)
        记账('眼睛就绪（' + this.设备 + '，加载 ' + 对象.load_ms + 'ms，词表 ' + this.词表.length + ' 个）')
        if (this.好了) this.好了(true)
        continue
      }
      if (对象.vocab) {
        状态.look.准备 = ''
        this.词表 = 对象.classes || []
        if (对象.warn) 记账('yolo 警告：' + 对象.warn)
        else 记账('yolo 词表就绪（' + (对象.classes || []).length + ' 个）')
        continue
      }
      if (对象.fatal) {
        if (this.坏了) this.坏了(对象.error)
        continue
      }
      const 等 = this.排队.shift()
      if (!等) continue
      if (对象.ok) 等.成功(对象)
      else 等.失败(new Error(对象.error || '检测失败'))
    }
  }

  async 查(jpg路径) {
    await this.起()
    return new Promise((resolve, reject) => {
      this.排队.push({ 成功: resolve, 失败: reject })
      try {
        this.proc.stdin.write(JSON.stringify({ jpg: jpg路径 }) + '\n')
      } catch (error) {
        this.排队.pop()
        reject(error)
      }
    })
  }

  停() {
    const proc = this.proc
    this.proc = null
    this.就绪 = false
    if (proc) {
      try {
        proc.kill()
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- WAV

function 写wav(路径, pcm) {
  const 头 = Buffer.alloc(44)
  头.write('RIFF', 0)
  头.writeUInt32LE(36 + pcm.length, 4)
  头.write('WAVE', 8)
  头.write('fmt ', 12)
  头.writeUInt32LE(16, 16) // fmt 块大小
  头.writeUInt16LE(1, 20) // PCM
  头.writeUInt16LE(1, 22) // 单声道
  头.writeUInt32LE(16000, 24)
  头.writeUInt32LE(16000 * 2, 28)
  头.writeUInt16LE(2, 32)
  头.writeUInt16LE(16, 34)
  头.write('data', 36)
  头.writeUInt32LE(pcm.length, 40)
  writeFileSync(路径, Buffer.concat([头, pcm]))
}

// ---------------------------------------------------------------- 插件本体

/**
 * ⚠ 整个插件包在一层 try 里：它再出问题，最多是这个插件不可用，
 *   **绝不能连累 DSH 启动**（桌面版起不来等于整台机器没法用）。
 */
export function apply(ctx) {
  try {
    启动(ctx)
  } catch (error) {
    try {
      console.error('[camera-bridge] 启动失败：', error)
    } catch {}
  }
}

function 启动(ctx) {
  确保目录()
  let 配置 = 读配置()
  // 「盯着」不跨重启自动恢复：不想让摄像头在没打招呼的时候自己开起来
  if (配置.watchOn) {
    配置 = 存配置({ watchOn: false })
    记账('上次停在「盯着」状态，这次没自动恢复（要就点面板的 👀）')
  }

  const 工人 = new 转写工人(ctx, 配置)
  const 视频 = new 视频源(ctx, () => 配置)
  const 眼睛 = new 检测器(ctx, () => 配置)
  let 听 = null
  let 半双工定时 = null
  let 正在处理 = false
  const 待送 = []

  /**
   * 收一句：排队，一句一句送。
   * ⚠ 以前是「忙就丢掉」—— 做饭时人说话快，丢掉的那句就真的没回应了。
   *   现在排队：她说几句，就依次回几句。
   */
  const 收句子 = async (pcm, 信息) => {
    待送.push({ pcm, 信息 })
    if (正在处理) {
      记账('还在送上一句，这句排队（前面 ' + 待送.length + ' 句）')
      return
    }
    正在处理 = true
    try {
      while (待送.length) {
        const 件 = 待送.shift()
        await 送一句(件.pcm, 件.信息)
      }
    } finally {
      正在处理 = false
    }
  }

  /** 把一句 PCM 走完：转写 → 送进会话。整条链的耗时都记下来。 */
  const 送一句 = async (pcm, 信息) => {
    const 计 = {
      at: new Date().toISOString(),
      atMs: 信息.末次有声 || Date.now(),
      语音毫秒: 信息.语音毫秒,
      判停毫秒: 信息.判停毫秒,
    }
    let 文件 = ''
    try {
      const 名 = 'clip-' + Date.now() + '-' + randomUUID().slice(0, 6) + '.wav'
      文件 = join(音频目录, 名)
      写wav(文件, pcm)

      const 转写开始 = Date.now()
      const 结果 = await 工人.转写(文件)
      计.转写毫秒 = Date.now() - 转写开始
      计.引擎毫秒 = 结果.ms
      const 文本 = String(结果.text || '').trim()
      计.文本 = 文本
      // ⚠ 噪音/键盘声也常能切出一句，SenseVoice 会回一个「。」——那种别往会话里塞
      const 净 = 文本.replace(/[\s.,。，、！？!?…~～\-—_:：;；"'“”‘’()（）\[\]【】<>]/g, '')
      if (!净) {
        计.结果 = '空'
        记账('这句没识别出字（' + 信息.语音毫秒 + 'ms）')
        return
      }

      状态.lastText = 文本
      状态.lastAt = Date.now()

      const 送开始 = Date.now()
      const 送到 = 配置.autoSend ? await 送进会话(ctx, 配置, 文本) : { ok: false, 原因: 'autoSend 关着' }
      计.送达毫秒 = Date.now() - 送开始
      计.结果 = 送到.ok ? '已送出' : '没送：' + (送到.原因 || '')
      计.总毫秒 = Date.now() - 计.atMs
      if (!送到.ok) 记账('识别到「' + 文本 + '」但没送出去：' + (送到.原因 || ''))
      else 记账('你说「' + 文本 + '」→ 已送进会话（' + 计.总毫秒 + 'ms）')
    } catch (error) {
      计.结果 = '出错：' + String((error && error.message) || error)
      记账(计.结果)
    } finally {
      if (文件) {
        // 留最近 20 个，别把盘塞满
        try {
          const 们 = readdirSync(音频目录).filter((f) => f.endsWith('.wav')).sort()
          while (们.length > 20) {
            const 老 = 们.shift()
            try {
              unlinkSync(join(音频目录, 老))
            } catch {}
          }
        } catch {}
      }
      记一轮(计)
    }
    return 计
  }

  function 记一轮(计) {
    const 精简 = { ...计 }
    状态.timing.unshift(精简)
    if (状态.timing.length > 12) 状态.timing.pop()
    try {
      appendFileSync(计时路径, JSON.stringify(精简) + '\n', 'utf8')
    } catch {}
  }

  // 启动时把历史上最近几轮读回来
  try {
    if (existsSync(计时路径)) {
      const 行们 = readFileSync(计时路径, 'utf8').trim().split('\n').filter(Boolean).slice(-12)
      状态.timing = 行们.map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      }).filter(Boolean).reverse()
    }
  } catch {}

  async function 开始听() {
    if (听) return { ok: true, 已经在听: true }
    配置 = 读配置()
    状态.error = ''
    const 新 = new 听音器(ctx, 配置, 收句子)
    try {
      await 新.起()
    } catch (error) {
      状态.error = String((error && error.message) || error)
      return { ok: false, 原因: 状态.error }
    }
    听 = 新
    状态.listening = true
    状态.vad = 'listening'

    // 抢话：把正在念的停掉，立刻开始听
    const 源 = (() => {
      try {
        const o = String(ctx.webServer.getOrigin() || '')
        if (o) return o
      } catch {}
      return 'http://127.0.0.1:' + 端口()
    })()
    // 朗读服务地址（可换成任何提供 /status + /stop 的本地 TTS；空 = 不用）
    // 支持两种写法：同源路径（/dsh-tts-bridge）或完整地址（http://127.0.0.1:9000/tts）
    const 朗读桥 = String(配置.ttsBase || '').trim().replace(/\/+$/, '')
    const 朗读URL = (尾) => (/^https?:\/\//i.test(朗读桥) ? 朗读桥 + 尾 : 源 + 朗读桥 + 尾)
    新.打断 = () => {
      if (!配置.allowInterrupt) return
      // 喇叭停了之后麦克风要是几乎没变化，那就是把喇叭自己的声音误当成了她在说
      状态.mic.回声力度 = 听 ? 听.回声力度() : null
      状态.mic.打断次数++
      状态.mic.上次打断 = Date.now()
      记账('她抢话 → 把正在念的停掉')
      if (朗读桥) void fetch(朗读URL('/stop'), { method: 'POST' }).catch(() => {})
      状态.vad = 'listening'
    }

    // 顺手把转写工人热起来（模型冷加载一次，第一句就不用等）
    工人.起().catch((error) => 记账('转写工人预热失败：' + ((error && error.message) || error)))

    // 半双工：朗读服务在念 → 不听
    if (配置.halfDuplex && 朗读桥) {
      const 轮询 = async () => {
        try {
          const r = await fetch(朗读URL('/status'), { signal: AbortSignal.timeout(1500) })
          const j = await r.json()
          const 在念 = !!(j && (j.playing || (j.waiting || 0) > 0))
          if (在念) {
            if (状态.vad !== 'suppress') {
              状态.vad = 'suppress'
              if (听) {
                听.当前 = []
                听.在说 = false
                听.静音帧 = 0
              }
            }
          } else if (状态.vad === 'suppress') {
            状态.vad = 'listening'
          }
        } catch {
          // 朗读桥不在就算了，别挡着听
          if (状态.vad === 'suppress') 状态.vad = 'listening'
        }
      }
      // ⚠ 500ms 太慢：朗读一停，耳朵最多要等半秒才回来，她抢着回「对」就掉进空窗了。
      //   默认 200ms（配 duplexPollMs），够跟手，本地轮询也没负担。
      半双工定时 = ctx.interval(轮询, Math.max(100, Number(配置.duplexPollMs) || 200))
    }
    return { ok: true }
  }

  function 停止听() {
    if (半双工定时) {
      try {
        半双工定时()
      } catch {}
      半双工定时 = null
    }
    if (听) {
      听.停()
      听 = null
    }
    状态.listening = false
    状态.vad = 'idle'
    状态.level = 0
    return { ok: true }
  }

  // 插件卸载时收干净
  ctx.effect(() => () => {
    停止听()
    工人.停()
    视频.停()
    眼睛.停()
    卸载工具()
  })

  // ---------------------------------------------------------------- 路由

  const 挂 = (路径, 处理) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          // 给这一条请求定好「允许谁跨站读」——回包时统一用它
          try {
            res.__origin = 允许来源(ctx, req)
          } catch {}

          if (req.method === 'OPTIONS') {
            res.writeHead(204, 组头(res.__origin || ''))
            res.end()
            return
          }
          try {
            await 处理(req, res)
          } catch (error) {
            记账('路由 ' + 路径 + ' 出错：' + (error && error.message))
            回(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    )

  挂(P + '/state', async (req, res) => {
    回(res, 200, {
      ok: true,
      listening: 状态.listening,
      vad: 状态.vad,
      level: Number(状态.level.toFixed(3)),
      peak: Number(状态.peak.toFixed(3)),
      device: 状态.device,
      lastText: 状态.lastText,
      lastAt: 状态.lastAt,
      error: 状态.error,
      asrReady: 状态.asrReady,
      timing: 状态.timing,
      diag: 状态.diag.slice(-12),
      config: 公开配置(配置),
      sessions: 会话清单(ctx),
      modelDir: 模型目录(配置),
      video: { ...状态.video },
      mic: { ...状态.mic, rms: Number((状态.mic.rms || 0).toFixed(3)) },
      look: { ...状态.look, 物体: 状态.look.物体.slice(0, 8) },
      watch: { ...状态.watch },
      // 挂在视觉下面的模块（做饭…）—— 前端照这份清单渲染
      modules: 模块清单(配置),
      // 预发布标记：面板顶部要显示
      release: { stage: 发布阶段, version: 版本 },
    })
  })

  挂(P + '/start', async (req, res) => {
    起能力()
    配置 = 读配置()
    const 体 = await 读体(req)
    if (体.targetSession) 配置 = 存配置({ targetSession: String(体.targetSession) })
    const r = await 开始听()
    回(res, 200, { ...r, state: { listening: 状态.listening, device: 状态.device, error: 状态.error } })
  })

  挂(P + '/stop', async (req, res) => {
    停止听()
    回(res, 200, { ok: true })
  })

  挂(P + '/config', async (req, res) => {
    if (req.method === 'GET') {
      回(res, 200, { ok: true, config: 公开配置(配置) })
      return
    }
    const 体 = await 读体(req)
    const 旧设备 = 配置.micDevice
    配置 = 存配置(体)
    状态.error = ''
    // 改了麦克风/路径这类，重开一次
    const 要重开 = 状态.listening && (旧设备 !== 配置.micDevice || 'ffmpegPath' in 体)
    if (要重开) {
      停止听()
      await 开始听()
    }
    回(res, 200, { ok: true, config: 公开配置(配置), restarted: 要重开 })
  })

  挂(P + '/devices', async (req, res) => {
    回(res, 200, {
      ok: true,
      audio: await 列音频设备(ctx, 配置),
      video: await 列视频设备(ctx, 配置),
    })
  })

  挂(P + '/sessions', async (req, res) => {
    回(res, 200, { ok: true, sessions: 会话清单(ctx) })
  })

  挂(P + '/timing', async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const n = Math.max(1, Math.min(50, Number(u.searchParams.get('n')) || 12))
    回(res, 200, { ok: true, timing: 状态.timing.slice(0, n), file: 计时路径 })
  })

  挂(P + '/selfcheck', async (req, res) => {
    const ff = ffmpeg路径(配置)
    const py = python路径(配置)
    const 模型 = 模型目录(配置)
    const 权重 = String(配置.yoloModel || '').trim() || join(目录, 'models', 'yolov8s-worldv2.pt')
    const 有ff = !!ff && existsSync(ff)
    const 有py = !!py && existsSync(py)
    const 有模型 = existsSync(join(模型, 'model.int8.onnx')) && existsSync(join(模型, 'tokens.txt'))
    const 有权重 = existsSync(权重)
    const 有词表 = existsSync(join(模型, 'tokens.txt'))

    // 「缺什么 + 怎么补」—— 新用户第一次打开面板就能照着做
    const 缺 = []
    if (!有ff) 缺.push({ 项: 'ffmpeg', 说明: '没找到 ffmpeg。装一个并加进 PATH，或在上面「ffmpeg 路径」里填绝对路径。' })
    if (!有py) 缺.push({ 项: 'python', 说明: '没找到 python。装 Python 3.10+ 并加进 PATH，或在「python 路径」里填绝对路径。' })
    if (!有模型) {
      缺.push({
        项: 'SenseVoice 模型',
        说明: '把这个目录放进 ' + 模型 + '（需要 model.int8.onnx 和 tokens.txt，约 230MB）。',
      })
    }
    if (!有权重) {
      缺.push({
        项: 'YOLO 权重',
        说明: '把 yolov8s-worldv2.pt 放进 ' + join(目录, 'models') + '（约 25MB），或把「yoloModel」改成已有路径。',
      })
    }

    回(res, 200, {
      ok: true,
      ffmpeg: { path: ff, exists: 有ff, 来源: String(配置.ffmpegPath || '').trim() ? '配置' : '自动' },
      python: { path: py, exists: 有py, 来源: String(配置.pythonPath || '').trim() ? '配置' : '自动' },
      model: { dir: 模型, exists: 有模型, tokens: 有词表, need: 'model.int8.onnx + tokens.txt' },
      yolo: { path: 权重, exists: 有权重, need: 'yolov8s-worldv2.pt' },
      clip: { note: '开放词表第一次用会下 CLIP ViT-B/32（约 338MB）到 ~/.cache/clip，需要联网' },
      audio: await 列音频设备(ctx, 配置),
      video: await 列视频设备(ctx, 配置),
      缺,
      可以跑: !缺.length,
      configFile: 配置路径,
      timingFile: 计时路径,
    })
  })

  // 一句话自测：不经过麦克风，直接拿一段 wav 走「转写 → 送会话」
  挂(P + '/inject', async (req, res) => {
    const 体 = await 读体(req)
    let 路径 = String(体.wav || '')
    if (!路径) {
      回(res, 400, { ok: false, error: '没给 wav 路径' })
      return
    }
    // ⚠ 安全：以前这里能读**任意绝对路径**的文件并转写（等于一个本地文件读取口子）。
    //   现在只允许 clips 目录里的 wav —— 自测需要的素材本来就在那儿。
    let 绝对 = ''
    try {
      绝对 = resolve(路径)
    } catch {
      回(res, 400, { ok: false, error: '路径看不懂：' + 路径 })
      return
    }
    const 允许根 = resolve(音频目录)
    if (绝对 !== 允许根 && !绝对.startsWith(允许根 + sep)) {
      回(res, 400, { ok: false, error: '只允许读 ' + 音频目录 + ' 里的 wav（自测用）' })
      return
    }
    if (!existsSync(绝对)) {
      回(res, 400, { ok: false, error: 'wav 路径不对：' + 路径 })
      return
    }
    路径 = 绝对
    let pcm
    try {
      pcm = readFileSync(路径).subarray(44)
    } catch (error) {
      回(res, 400, { ok: false, error: '读不了：' + String((error && error.message) || error) })
      return
    }
    if (pcm.length < 3200) {
      回(res, 400, { ok: false, error: '太短（不到 0.1 秒）' })
      return
    }
    const 计 = await 收句子(pcm, {
      语音毫秒: Math.round(pcm.length / 32),
      判停毫秒: 0,
      末次有声: Date.now(),
    })
    回(res, 200, { ok: true, timing: 计 })
  })

  // ---------------------------------------------------------------- 画面

  /** 校准比例尺：她知道那东西多宽，我们就知道一像素多少厘米 */
  function 校准比例尺(帧, 物件, 参考宽厘米) {
    const 宽 = Number(参考宽厘米)
    if (!(宽 > 0.5 && 宽 < 300)) return null
    const { 宽: 图宽 } = jpeg尺寸(帧)
    // 用画面宽度做粗估：默认那件参照物占大约 1/3 画面宽（她会把碗/锅对着镜头）
    const 像素 = Math.round(图宽 / 3)
    状态.watch.比例尺 = {
      物件: String(物件 || '参照物'),
      参考宽: 宽,
      像素,
      图宽,
      每厘米像素: Number((像素 / 宽).toFixed(1)),
      at: Date.now(),
    }
    记账('比例尺校准：' + 物件 + ' ' + 宽 + 'cm ≈ ' + 像素 + 'px → 1cm ≈ ' + 状态.watch.比例尺.每厘米像素 + 'px')
    return 状态.watch.比例尺
  }

  /** 抓一帧存成文件，返回能交给模型看的路径 */
  async function 拍一张(校准) {
    确保目录()
    const 旧 = 视频.最新于
    let 帧 = 视频.最新
    if (!帧 || Date.now() - 旧 > 1500) {
      await 视频.起()
      帧 = (await 视频.等一帧(旧, 8000)) || 视频.最新
    }
    if (!帧) {
      throw new Error('摄像头没出画面' + (状态.video.error ? '：' + 状态.video.error : '（8 秒没等到帧）'))
    }
    const 名 = join(截图目录, 'shot-' + Date.now() + '.jpg')
    writeFileSync(名, 帧)
    // 只留最近 20 张，别把盘塞满
    try {
      const 们 = readdirSync(截图目录).filter((f) => f.startsWith('shot-') && f.endsWith('.jpg')).sort()
      while (们.length > 20) {
        const 老 = 们.shift()
        try {
          unlinkSync(join(截图目录, 老))
        } catch {}
      }
    } catch {}
    const { 宽, 高 } = jpeg尺寸(帧)
    if (校准 && 校准.ref_object && 校准.ref_width_cm) {
      校准比例尺(帧, 校准.ref_object, 校准.ref_width_cm)
    }
    const 时间 = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const 附 = 状态.look.摘要 ? ' 顺便，眼睛这会儿认出来的是「' + 状态.look.摘要 + '」。' : ''
    // 比例尺：让她拿个碗/锅对着镜头比一下，我们就能知道一帧里 1 厘米大概几个像素。
    // 只会出现在上下文里（模型自己算），不会念出来 —— 念一串数字只会更难懂。
    const 尺 = 状态.watch.比例尺
    const 尺文 = 尺
      ? '【比例尺】画面里那件东西宽 ' + 尺.物件 + '（参考宽 ' + 尺.参考宽 + 'cm）占了 ' + 尺.像素 + ' 像素，' +
        '所以画面里 1 厘米 ≈ ' + 尺.每厘米像素 + ' 像素。估分量时先用这个换算，别凭感觉。'
      : '【比例尺】还没校准。要估分量（一勺盐大概多少、油够不够），先让她拿个碗或锅对着镜头，' +
        '用 look_camera 拍一张并填 ref_object（比如「碗」）和 ref_width_cm（比如 12），我就知道画面里 1 厘米多大了。'
    return {
      文件: 名,
      时间,
      宽,
      高,
      说明:
        '摄像头画面（' + 时间 + '）已存成 ' + 名 + '。想真看到内容，就用 read_image 读这个文件。' + 附,
      比例尺: 尺文,
    }
  }

  挂(P + '/video/start', async (req, res) => {
    起能力()
    try {
      await 视频.起()
      回(res, 200, { ok: true, video: { ...状态.video } })
    } catch (error) {
      状态.video.error = String((error && error.message) || error)
      记账('画面起不来：' + 状态.video.error)
      回(res, 200, { ok: false, 原因: 状态.video.error })
    }
  })

  挂(P + '/video/stop', async (req, res) => {
    视频.停()
    回(res, 200, { ok: true })
  })

  挂(P + '/snapshot', async (req, res) => {
    try {
      await 视频.起()
      const 帧 = await 视频.等一帧(0, 6000)
      if (!帧) {
        res.writeHead(503, 组头(res.__origin || ''))
        res.end('no frame yet')
        return
      }
      res.writeHead(200, {
        ...组头(res.__origin || ''),
        'content-type': 'image/jpeg',
        'content-length': String(帧.length),
        'cache-control': 'no-store',
      })
      res.end(帧)
    } catch (error) {
      res.writeHead(503, { ...组头(res.__origin || ''), 'content-type': 'text/plain; charset=utf-8' })
      res.end(String((error && error.message) || error))
    }
  })

  // MJPEG：每来一个客户端，就把「最新那一帧」按帧率写过去
  挂(P + '/mjpeg', async (req, res) => {
    try {
      await 视频.起()
    } catch (error) {
      res.writeHead(503, { ...组头(res.__origin || ''), 'content-type': 'text/plain; charset=utf-8' })
      res.end(String((error && error.message) || error))
      return
    }
    res.writeHead(200, {
      'content-type': 'multipart/x-mixed-replace; boundary=frame',
      'cache-control': 'no-store',
      connection: 'close',
      ...组头(res.__origin || ''),
    })
    const 帧率 = Math.max(1, Math.min(30, Number(配置.videoFps) || 8))
    const 定时 = setInterval(() => {
      const 帧 = 视频.最新
      if (!帧) return
      try {
        res.write('--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ' + 帧.length + '\r\n\r\n')
        res.write(帧)
        res.write('\r\n')
      } catch {}
    }, Math.max(40, Math.round(1000 / 帧率)))
    const 收 = () => {
      clearInterval(定时)
      try {
        res.end()
      } catch {}
    }
    req.on('close', 收)
    req.on('error', 收)
  })

  挂(P + '/shot', async (req, res) => {
    try {
      const r = await 拍一张()
      回(res, 200, { ok: true, ...r })
    } catch (error) {
      回(res, 200, { ok: false, 错误: String((error && error.message) || error) })
    }
  })

  挂(P + '/look/start', async (req, res) => {
    起能力()
    配置 = 存配置({ lookOn: true })
    if (!状态.video.on) {
      try {
        await 视频.起()
      } catch (error) {
        回(res, 200, { ok: false, 原因: String((error && error.message) || error) })
        return
      }
    }
    try {
      await 检测一轮(true)
    } catch (error) {
      回(res, 200, { ok: false, 原因: String((error && error.message) || error) })
      return
    }
    // 第一次要等 CLIP 词表 + 第一帧推理，别让面板拿到空结果
    for (let i = 0; i < 60 && !状态.look.摘要 && !状态.look.错误; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    回(res, 200, { ok: true, look: { ...状态.look } })
  })

  挂(P + '/look/stop', async (req, res) => {
    配置 = 存配置({ lookOn: false })
    回(res, 200, { ok: true })
  })

  挂(P + '/watch/start', async (req, res) => {
    起能力()
    配置 = 存配置({ watchOn: true, lookOn: true })
    if (!状态.video.on) {
      try {
        await 视频.起()
        await 视频.等一帧(0, 6000)
      } catch (error) {
        回(res, 200, { ok: false, 原因: String((error && error.message) || error) })
        return
      }
    }
    try {
      await 检测一轮(true)
    } catch (error) {}
    for (let i = 0; i < 24 && !状态.watch.阶段; i++) await new Promise((r) => setTimeout(r, 250))
    回(res, 200, { ok: true, watch: { ...状态.watch } })
  })

  挂(P + '/watch/stop', async (req, res) => {
    配置 = 存配置({ watchOn: false })
    状态.watch.阶段 = ''
    状态.watch.依据 = ''
    回(res, 200, { ok: true })
  })

  // ---------------------------------------------------------------- 模块：做饭

  /**
   * 「开始做」：面板上填了菜名，点这一下。
   *
   * 做三件事：
   *   ① 把菜名存进配置（下次打开面板还看得见）
   *   ② 打开盯着（视频 + 眼睛 + 状态机）
   *   ③ 往会话里送一句话，让模型去查/编菜谱、用 recipe_import 导入
   *
   * ⚠ 菜谱本身由模型用 recipe_import 工具写进来 —— 面板只负责告诉它「做什么菜」。
   *   这样菜谱内容仍然是模型的活（可以查、可以按她口味改），面板不越界。
   */
  挂(P + '/modules/cook/start', async (req, res) => {
    起能力()
    const 体 = await 读体(req)
    const 菜 = String(体.菜 || 体.菜名 || 体.dish || '').trim()
    if (!菜) {
      回(res, 400, { ok: false, 原因: '先在「想做什么菜」里写个菜名' })
      return
    }
    // ⚠ 先看有没有地方说话：没选会话就开摄像头、开状态机，等于白转
    if (!String(配置.targetSession || '').trim()) {
      回(res, 400, { ok: false, 原因: '还没选「送到」哪个会话 —— 先在设置里选一个，再开始做' })
      return
    }
    if (!ctx.agents.get(String(配置.targetSession).trim())) {
      回(res, 400, { ok: false, 原因: '那个会话没开着 —— 先在 DSH 里把它打开' })
      return
    }

    // 菜名先记下（就算后面失败，也不用重打）
    配置 = 存配置({ cookDish: 菜 })
    const 旧盯 = 配置.watchOn
    配置 = 存配置({ watchOn: true, lookOn: true })
    状态.watch.阶段 = ''
    状态.watch.依据 = ''

    // 摄像头先起得来，否则「盯着看」是假的
    if (!状态.video.on) {
      try {
        await 视频.起()
        await 视频.等一帧(0, 6000)
      } catch (error) {
        // 起不来就把盯着关回去，别留个开着但没画面的状态
        配置 = 存配置({ watchOn: 旧盯 })
        回(res, 200, { ok: false, 原因: '摄像头起不来：' + String((error && error.message) || error) })
        return
      }
    }

    // 让模型去准备菜谱
    const 话 =
      '我想做「' + 菜 + '」。请查一份靠谱的菜谱（或按常见做法编一份），然后调用 recipe_import（动作 import）' +
      '把步骤导进来 —— 每步尽量给「时长秒」，能看见的条件（steam/smoke/flame/oil/锅/刀…）写成「见」条件，' +
      '生熟颜色这种写不出条件的就留「必看」。导完告诉我一声，我这边摄像头已经开着盯了。'
    const 送 = await 送进会话(ctx, 配置, 话)
    if (!送.ok) {
      // 话没送到，盯着也没意义 —— 回滚，别让她以为在看着
      配置 = 存配置({ watchOn: 旧盯 })
      状态.watch.阶段 = ''
      回(res, 200, { ok: false, 原因: '菜名记下了，但没送进会话：' + (送.原因 || '') })
      return
    }

    // 顺手先认一帧，让面板立刻有东西看
    try {
      await 检测一轮(true)
    } catch (error) {}
    回(res, 200, { ok: true, 菜, modules: 模块清单(配置) })
  })

  // ---------------------------------------------------------------- 工具：look_camera

  const 做盯着工具 = () => ({
    name: 'watch_camera',
    description:
      '让摄像头「盯着看」：开着之后它一直认画面、自己判阶段（备菜 → 下锅 → 加热 → 沸腾 → 出锅），只在出事（冒烟/糊）时先开口。' +
      '她说「我做菜了 / 帮我看着锅」就打开；说「好了 / 不看了」就关掉。',
    parameters: {
      type: 'object',
      properties: {
        开启: { type: 'boolean', description: 'true = 开始盯着；false = 不看了' },
      },
      required: ['开启'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { 开着: { type: 'boolean' }, 阶段: { type: 'string' }, 摘要: { type: 'string' } },
        required: ['开着', '阶段', '摘要'],
      },
      render: (_args, v) => [
        {
          type: 'text',
          text: v.开着
            ? '好，盯着呢。现在大概在「' + (v.阶段 || '空') + '」（' + (v.摘要 || '画面里没认出来什么') + '）。'
            : '好，不盯了。',
        },
      ],
    },
    async execute(args) {
      const 开 = !!args.开启
      配置 = 存配置(开 ? { watchOn: true, lookOn: true } : { watchOn: false })
      if (开) {
        if (!状态.video.on) {
          try {
            await 视频.起()
            await 视频.等一帧(0, 6000)
          } catch {}
        }
        try {
          await 检测一轮(true)
        } catch {}
      } else {
        状态.watch.阶段 = ''
      }
      return { 开着: 开, 阶段: 状态.watch.阶段 || '', 摘要: 状态.look.摘要 || '' }
    },
  })

  /** 菜谱：导入 / 查询 / 清掉 */
  const 做菜谱工具 = () => ({
    name: 'recipe_import',
    description:
      '把一份菜谱编成摄像头的「做菜状态机」。她说「我想做番茄炒蛋」「帮我看火」，你就去查菜谱、写成下面的格式导进来 —— ' +
      '之后摄像头会按步骤自己跟进，到点/到状态就主动开口。' +
      '动作：import（导入并开始）、get（看现在导入的是哪份、走到第几步）、clear（清掉）。',
    parameters: {
      type: 'object',
      properties: {
        动作: { type: 'string', enum: ['import', 'get', 'clear'], description: '要干什么' },
        菜谱: {
          type: 'object',
          description:
            'import 时必填。{名称, 分量, 原料:[{名, 用量}], 步骤:[{名称, 说, 提示, 时长秒, 必看, 用量:{料:量}, ' +
            '条件:[{类型:"见"|"时", 词:["steam"] 或 秒:90}]}]}。条件只写「看得见的东西」（smoke/steam/flame/oil/knife/pot…）或时长；' +
            '生熟、颜色这种写不出条件的，就只给时长秒 并留 必看 不填 —— 到点会叫你用 look_camera 看图确认。',
          additionalProperties: true,
        },
      },
      required: ['动作'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, v) => [{ type: 'text', text: String(v && v.说 ? v.说 : JSON.stringify(v)) }],
    },
    async execute(args) {
      const 动作 = String(args.动作 || 'get')
      if (动作 === 'clear') {
        菜谱 = null
        try {
          unlinkSync(菜谱文件())
        } catch {}
        状态.watch.步骤 = -1
        状态.watch.步名 = ''
        return { ok: true, 说: '菜谱清掉了，回到通用状态机。' }
      }
      if (动作 === 'get') {
        if (!菜谱) return { ok: true, 菜谱: null, 说: '现在没有导入菜谱，走的是通用状态机。' }
        return {
          ok: true,
          菜谱: 菜谱.名称,
          步骤总数: 菜谱.步骤.length,
          当前: 目前进度(),
          步骤: 菜谱.步骤.map((s, i) => (i + 1) + '. ' + s.名称),
          说: 目前进度(),
        }
      }
      // import
      try {
        const 结果 = 存菜谱(args.菜谱)
        // ⚠ 这里原来还有一句 `状态.watch.步骤 = -1` —— 它会把 存菜谱 里刚做的
        //   「同名保留进度」当场覆盖掉，导致重复导入照样「起步 → 开口」。
        //   重置进度这件事已经交给 存菜谱 判断了，这里不能再插手。
        // 顺带把词表补上（菜谱里提到的英文词）
        return {
          ok: true,
          菜谱: 结果.名称,
          步骤数: 结果.步骤.length,
          说:
            `菜谱「${结果.名称}」导进来了，共 ${结果.步骤.length} 步：` +
            结果.步骤.map((s, i) => (i + 1) + '.' + s.名称).join(' → ') +
            '。现在点「盯着看」，摄像头就开始跟了。',
        }
      } catch (error) {
        return { ok: false, 说: '菜谱没导入：' + ((error && error.message) || error) }
      }
    },
  })

  const 做状态工具 = () => ({
    name: 'camera_state',
    description:
      '只问「摄像头里认出了什么」——返回一句文字摘要（比如「锅×1、手×1、蒸汽」），不返回图片，便宜又快。' +
      '想知道画面里大概有什么、还在不在做同一件事时用它；要看颜色、生熟、细节，用 look_camera 拿图。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          摘要: { type: 'string' },
          时间: { type: 'string' },
          开着: { type: 'boolean' },
        },
        required: ['摘要', '时间', '开着'],
      },
      render: (_args, v) =>
        [
          {
            type: 'text',
            text: v.摘要
              ? '摄像头里现在有：' + v.摘要 + '（' + v.时间 + '）'
              : '摄像头这会儿什么也没认出来（' + v.时间 + (v.开着 ? '' : '，画面还没开') + '）',
          },
        ],
    },
    async execute() {
      if (!状态.video.on) {
        try {
          await 视频.起()
          await 视频.等一帧(0, 6000)
        } catch {}
      }
      const 基线 = 状态.look.at
      if (!状态.look.at || Date.now() - 状态.look.at > 1200) {
        try {
          await 检测一轮(true)
        } catch {}
        for (let i = 0; i < 24; i++) {
          if (状态.look.at > 基线 || 状态.look.准备 || 状态.look.错误) break
          await new Promise((r) => setTimeout(r, 250))
        }
      }
      const 摘要 = 状态.look.摘要 || (状态.look.准备 ? '（眼睛在准备：' + 状态.look.准备 + '）' : 状态.look.错误 || '')
      return {
        摘要,
        时间: 状态.look.at ? new Date(状态.look.at).toLocaleTimeString('zh-CN', { hour12: false }) : '还没看过',
        开着: !!状态.video.on,
      }
    },
  })

  const 做摄像头工具 = () => ({
    name: 'look_camera',
    description:
      '看一眼摄像头现在的画面，返回一张已经存好的 jpg 路径。' +
      '凡是必须看画面才能回答的事（锅里什么状态、桌上有什么、菜切到哪一步、有没有冒烟、一勺盐放了多少）都先用它；' +
      '拿到路径后**再用 read_image 打开那张图**，你就真的看到了，再回答。' +
      '要估分量（盐/油/水多少）时，让她拿个碗或锅对着镜头，填 ref_object 和 ref_width_cm，' +
      '返回值里会带「画面里 1 厘米 ≈ 几个像素」，照那个估算，别凭感觉说克数。',
    parameters: {
      type: 'object',
      properties: {
        问题: { type: 'string', description: '你想在画面里确认什么（可选，只记日志）' },
        ref_object: { type: 'string', description: '校准用的参照物（可选），比如「碗」「炒锅」' },
        ref_width_cm: { type: 'number', description: '那个参照物大概多宽（厘米，可选）。填了就校准比例尺' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          文件: { type: 'string' },
          时间: { type: 'string' },
          宽: { type: 'integer' },
          高: { type: 'integer' },
          说明: { type: 'string' },
          比例尺: { type: 'string' },
        },
        required: ['文件', '时间', '说明'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value && value.说明 ? value.说明 : JSON.stringify(value)) }],
    },
    async execute(args) {
      try {
        return await 拍一张({ ref_object: args.ref_object, ref_width_cm: args.ref_width_cm })
      } catch (error) {
        状态.video.error = String((error && error.message) || error)
        throw error
      }
    },
  })

  let 工具收尾 = null

  /** 画面里认出来的东西 → 一句话 */
  function 组摘要(物体) {
    const 计 = new Map()
    for (const o of 物体) {
      const n = o.中文 || o.label
      计.set(n, (计.get(n) || 0) + 1)
    }
    return [...计.entries()].map(([n, c]) => (c > 1 ? n + '×' + c : n)).join('、')
  }

  let 检测忙 = false
  let 上次检测帧 = 0
  let 下次检测 = 0
  let 冒烟上次说 = 0

  // ---------------------------------------------------------------- 视觉广播
  /**
   * 视觉的「每认出一次」就广播一次，谁关心谁订阅。
   *
   * 为什么要有这一层：以前 检测一轮() 里直接调 判观察()，做饭状态机是**写死**在视觉循环里的。
   * 想让「帮我盯着猫」也能用上同一个循环，就得把「认出了什么」和「拿这些干什么」
   * 拆开 —— 视觉只管认，认完广播；做饭、看猫都是订阅者，互相不认识。
   *
   * ⚠ 订阅回调一律包 try：一个订阅者写错，不能让整个识别循环挂掉，更不能带崩宿主。
   */
  const 视觉订阅者 = new Set()

  /** 订阅「每认出一次」。返回退订函数。 */
  function 订阅视觉(fn) {
    if (typeof fn !== 'function') return () => {}
    视觉订阅者.add(fn)
    return () => {
      视觉订阅者.delete(fn)
    }
  }

  /**
   * 广播一次识别结果。
   *  物体  —— 这一帧认出来的东西（带 中文）
   *  快照  —— 同时的 状态.look，省的订阅者再去读全局
   * 返回值 = 有几家收了（给自检/日志用）
   */
  function 广播视觉(物体, 快照) {
    let 数 = 0
    for (const fn of [...视觉订阅者]) {
      try {
        fn(物体, 快照)
        数++
      } catch (error) {
        记账('视觉订阅者出错：' + ((error && error.message) || error))
      }
    }
    return 数
  }

  // ---------------------------------------------------------------- 挂载模块
  /**
   * 「长在视觉下面的服务」注册表。
   *
   * 视觉是底座（摄像头 + 认东西），做饭 / 看猫 / 以后别的都是往它下面挂的模块。
   * 每个模块自己声明：叫什么、干什么、要用户填哪些配置、现在是什么状态。
   * 前端不写死任何模块 —— 拉这份清单，照着渲染。以后加「看猫」只加一个注册，前端零改动。
   *
   * def = {
   *   id, 名, 说明,
   *   配置: [{ 键, 标签, 类型:'文本'|'数字'|'开关', 占位, 说明 }],   // 键必须在 默认配置 里
   *   操作: [{ 键, 标签, 需要 }],                                  // 需要 = 必须先填的配置键
   *   状态: () => ({ ... })                                        // 给面板显示
   * }
   */
  const 挂载模块 = new Map()

  function 注册模块(def) {
    if (!def || !def.id) return () => {}
    挂载模块.set(String(def.id), def)
    return () => {
      挂载模块.delete(String(def.id))
    }
  }

  /** 给面板的模块清单（含当前配置值和运行时状态） */
  function 模块清单(当前配置) {
    const 出 = []
    for (const def of 挂载模块.values()) {
      let 状态快照 = {}
      try {
        状态快照 = def.状态 ? def.状态() || {} : {}
      } catch (error) {
        状态快照 = { 错误: String((error && error.message) || error) }
      }
      出.push({
        id: String(def.id),
        名: String(def.名 || def.id),
        说明: String(def.说明 || ''),
        操作: Array.isArray(def.操作) ? def.操作 : [],
        配置: (Array.isArray(def.配置) ? def.配置 : []).map((f) => ({
          ...f,
          值: 当前配置 ? 当前配置[f.键] : undefined,
        })),
        状态: 状态快照,
      })
    }
    return 出
  }

  /**
   * 做菜状态机
   * ==========================================================================
   * 状态图（只往前走，不会往回退）：
   *
   *   空 ──► 备菜 ──► 热锅 ──► 下锅 ──► 咕嘟 ──► 冒烟/糊 ──► 出锅 ──► 收拾
   *                                    ▲         │
   *                                    └── 回落到下锅 ──┘（只是提醒，不算事件）
   *
   * 每一跳都要「稳住」：同一个判定连续出现 稳定帧 次才认 —— 免得画面抖一下就乱跳。
   * 出事（冒烟）不要求稳住，一看见就说；而且有冷却，不会连着喊。
   */
  const 状态顺序 = ['空', '备菜', '热锅', '下锅', '咕嘟', '出锅', '收拾']

  // ---------------------------------------------------------------- 菜谱
  /**
   * 菜谱是一串「步骤」，每步带一个或多个具体条件：
   *   { 步骤: 3, 名称: '爆香', 说: '…（主动开口说的话）', 提示: '…（写进上下文的提醒）',
   *     时长秒: 60, 条件: [{类型:'见', 词:['steam']}, {类型:'时', 秒:90}],
   *     必达: false }
   * 任一条件成立 → 进入下一步；超过时长 → 「疑似完成」，要模型自己看一眼图确认。
   *
   * ⚠ 条件只能是「看得见的东西」（烟雾火水气、某个物体、时长），
   *   生熟、咸淡这类必须靠 look_camera 看图 —— 那一步就不写硬条件，给 时长 + 必看。
   */
  let 菜谱 = 载入菜谱()

  function 菜谱文件() {
    return join(目录, 'recipes', 'current.json')
  }

  function 载入菜谱() {
    try {
      const f = 菜谱文件()
      if (!existsSync(f)) return null
      const 对象 = JSON.parse(readFileSync(f, 'utf8'))
      return 校验菜谱(对象) ? 对象 : null
    } catch (error) {
      记账('菜谱读不了：' + ((error && error.message) || error))
      return null
    }
  }

  /** 校验：不行就抛，别让坏菜谱把状态机弄懵 */
  function 校验菜谱(对象) {
    if (!对象 || typeof 对象 !== 'object') throw new Error('菜谱得是个对象')
    if (!String(对象.名称 || '').trim()) throw new Error('菜谱缺「名称」')
    const 步 = Array.isArray(对象.步骤) ? 对象.步骤 : null
    if (!步 || !步.length) throw new Error('菜谱缺「步骤」')
    if (步.length > 30) throw new Error('步骤太多了（上限 30）')
    for (const [i, s] of 步.entries()) {
      if (!String(s.名称 || '').trim()) throw new Error('第 ' + (i + 1) + ' 步没有名字')
      const 条件 = Array.isArray(s.条件) ? s.条件 : []
      for (const c of 条件) {
        const 类型 = String(c.类型 || '')
        if (类型 !== '见' && 类型 !== '时') throw new Error('第 ' + (i + 1) + ' 步的条件类型只能是「见」或「时」')
        if (类型 === '见' && !(Array.isArray(c.词) ? c.词 : [c.词]).filter(Boolean).length) {
          throw new Error('第 ' + (i + 1) + ' 步的「见」条件没写词')
        }
      }
    }
    return true
  }

  function 存菜谱(对象) {
    校验菜谱(对象)
    const 目录2 = join(目录, 'recipes')
    if (!existsSync(目录2)) mkdirSync(目录2, { recursive: true })

    // ⚠ 2026-11-05（端到端测出来的自激循环）：
    //   起步时主动开口说「开始做X了，第 1 步：…」，收到这句的模型会自作主张**再导一次菜谱**；
    //   旧代码在这里无条件把步骤打回 -1 → 又「起步」→ 又开口 → 又再导一次 …… 一圈圈转。
    //   现在：**同名菜谱重新导入，保留当前进度**。要真正重来，先 recipe_import clear。
    const 旧名 = 菜谱 ? String(菜谱.名称 || '') : ''
    const 同名在跑 = !!旧名 && 旧名 === String(对象.名称 || '') && 状态.watch.步骤 >= 0

    菜谱 = { ...对象, 导入于: new Date().toISOString() }
    writeFileSync(菜谱文件(), JSON.stringify(菜谱, null, 2), 'utf8')

    if (同名在跑) {
      // 新版本步骤数可能不一样，把游标夹回有效范围（不发呆、也不越界）
      const 末 = 菜谱.步骤.length - 1
      if (状态.watch.步骤 > 末) 状态.watch.步骤 = 末
      if (状态.watch.步骤 < -1) 状态.watch.步骤 = -1
      状态.watch.步名 = 状态.watch.步骤 >= 0 ? String(菜谱.步骤[状态.watch.步骤].名称) : ''
      记账('菜谱重新导入（同名，保留进度）：' + 菜谱.名称 + ' → 第 ' + (状态.watch.步骤 + 1) + ' 步')
      return 菜谱
    }

    状态.watch.步骤 = -1
    状态.watch.步名 = ''
    状态.watch.步开始 = 0
    状态.watch.疑似 = ''
    记账('菜谱导入：' + 菜谱.名称 + '（' + 菜谱.步骤.length + ' 步）')
    return 菜谱
  }

  /** 当前该盯哪一步（-1 = 还没开始） */
  function 当前步() {
    const i = 状态.watch.步骤
    if (!菜谱 || i < 0 || i >= 菜谱.步骤.length) return null
    return { 索引: i, 步: 菜谱.步骤[i] }
  }

  /** 满足条件了没有 —— 返回「命中的条件」或 null */
  function 条件命中(步, 物体, 已过秒) {
    const 有 = (re) => 物体.some((o) => re.test(o.中文 || o.label))
    for (const c of Array.isArray(步.条件) ? 步.条件 : []) {
      if (c.类型 === '时' && Number(c.秒) > 0 && 已过秒 >= Number(c.秒)) return '到时'
      if (c.类型 === '见') {
        const 词们 = Array.isArray(c.词) ? c.词 : [c.词]
        for (const 词 of 词们) {
          const w = String(词 || '').trim()
          if (w && (有(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) || 物体.some((o) => String(o.中文 || o.label).includes(中文名(w)) || String(o.label || '').toLowerCase() === w.toLowerCase()))) {
            return '看见' + w
          }
        }
      }
    }
    return null
  }

  /** 推进菜谱：跳步就开口 */
  function 推菜谱(物体) {
    const w = 状态.watch
    if (!菜谱) return
    const 现在 = Date.now()

    // 还没起步：第一次看到画面就进第 1 步
    if (w.步骤 < 0) {
      w.步骤 = 0
      w.步开始 = 现在
      w.步名 = String(菜谱.步骤[0].名称)
      w.疑似 = ''
      记账('菜谱起步：' + 菜谱.名称 + ' → 第 1 步「' + w.步名 + '」')
      if (配置.watchSpeak) {
        const 开场 = `开始做${菜谱.名称}了。第 1 步：${w.步名}。`
        void 主动开口(开场)
      }
      return
    }

    const 当 = 当前步()
    if (!当) return
    const 已过秒 = Math.round((现在 - w.步开始) / 1000)
    const 命中 = 条件命中(当.步, 物体, 已过秒)

    // 时长到了但没把握：喊模型看一眼图确认，而不是自己瞎判
    const 时长 = Number(当.步.时长秒 || 0)
    if (!命中 && 时长 > 0 && 已过秒 >= 时长 && w.疑似 !== 当.索引) {
      w.疑似 = 当.索引
      if (当.步.必看 !== false) {
        void 主动开口(
          `第 ${当.索引 + 1} 步「${当.步.名称}」已经过了 ${已过秒} 秒，画面里是「${状态.look.摘要 || '没认出来什么'}」。` +
            '用 look_camera 看一眼，确认能不能进下一步。',
        )
      }
      return
    }

    if (!命中) return

    // 命中 → 下一步
    const 下一步 = 当.索引 + 1
    if (下一步 >= 菜谱.步骤.length) {
      w.步骤 = 菜谱.步骤.length
      w.步名 = '全部做完'
      w.步开始 = 现在
      w.疑似 = ''
      记账('菜谱完成：' + 菜谱.名称)
      if (配置.watchSpeak) void 主动开口(`${菜谱.名称}好像做完了（${命中}）。`)
      return
    }
    w.步骤 = 下一步
    w.步开始 = 现在
    w.步名 = String(菜谱.步骤[下一步].名称)
    w.疑似 = ''
    记账('菜谱：' + 当.步.名称 + '（' + 命中 + '）→ ' + w.步名)
    if (配置.watchSpeak) {
      const 说 = String(菜谱.步骤[下一步].说 || '').trim()
      const 提示 = String(菜谱.步骤[下一步].提示 || '').trim()
      void 主动开口(
        `第 ${下一步 + 1} 步：${w.步名}。` + (说 || 提示 || ''),
      )
    }
  }

  /** 给中文：一句话描述现在做菜到哪了（也写进上下文） */
  function 目前进度() {
    if (!菜谱) return ''
    const w = 状态.watch
    if (w.步骤 < 0) return '菜谱「' + 菜谱.名称 + '」还没开始'
    if (w.步骤 >= 菜谱.步骤.length) return '菜谱「' + 菜谱.名称 + '」全部做完'
    const 当 = 菜谱.步骤[w.步骤]
    const 已过 = Math.round((Date.now() - w.步开始) / 1000)
    const 料 = (当.用量 && Object.keys(当.用量).length)
      ? '　这一步的料：' + Object.entries(当.用量).map(([k, v]) => k + ' ' + v).join('、')
      : ''
    return `菜谱「${菜谱.名称}」第 ${w.步骤 + 1}/${菜谱.步骤.length} 步「${当.名称}」，已过 ${已过} 秒${料}`
  }

  /** 认出来的东西 → 一个「建议阶段」+ 依据 */
  function 判阶段(物体) {
    const 有 = (re) => 物体.some((o) => re.test(o.中文 || o.label))
    if (有(/烟/)) return { 阶段: '冒烟', 依据: '看见烟', 异常: true }
    if (有(/蒸汽/)) return { 阶段: '咕嘟', 依据: '锅在冒蒸汽' }
    if (有(/火|灶台/)) {
      if (有(/锅|平底锅|炒锅|油|锅铲/)) return { 阶段: '下锅', 依据: '有火 + 锅/油' }
      return { 阶段: '热锅', 依据: '有火、还没见到锅' }
    }
    if (有(/锅|平底锅|炒锅|碗|盘子/)) return { 阶段: '下锅', 依据: '看见锅/碗盘' }
    if (有(/刀|砧板|菜|鸡蛋|食物/)) return { 阶段: '备菜', 依据: '刀/砧板/菜' }
    if (有(/人|手/)) return { 阶段: '有人', 依据: '看见人' }
    return { 阶段: '空', 依据: '什么都没认出来' }
  }

  /** 阶段文案：主动开口时用 */
  const 阶段口令 = {
    备菜: '看起来在备菜。切完该下锅的时候我提醒你。',
    热锅: '火已经开了，锅热了先润一下油，别急着下菜。',
    下锅: '菜下锅了。这会儿别走开，翻得勤一点。',
    咕嘟: '锅里咕嘟起来了，转小火慢慢煨，别糊底。',
    出锅: '看着差不多了，可以出锅了。',
    收拾: '收尾了？锅洗完放在灶上就行。',
  }

  /** 主动开口 —— 真的叫醒它（会花钱、会出声） */
  async function 主动开口(话) {
    const 目标 = String(配置.watchSession || 配置.targetSession || '').trim()
    if (!目标) return
    const agent = ctx.agents.get(目标)
    if (!agent) return
    // ⚠ 菜谱在跑的时候，明确告诉模型「别再导入」——
    //   否则它收到「开始做X了，第1步…」会以为要建菜谱，再 import 一次（实测发生过）。
    //   这句话只进上下文，不会被念出来（念的是模型的回复）。
    const 约束 = 菜谱 ? '（菜谱已经导入、正在跟，不要再调用 recipe_import；直接根据这一步说下一步就行。）' : ''
    try {
      await agent.followup(用户消息('[摄像头] ' + 话 + 约束))
      状态.watch.开口数++
      状态.watch.上次开口 = 话
      状态.watch.上次开口于 = Date.now()
      记账('主动开口：' + 话)
    } catch (error) {
      记账('主动开口失败：' + ((error && error.message) || error))
    }
  }

  /** 每认完一帧：推进状态机；跳档就开口 */
  function 判观察(物体) {
    const w = 状态.watch
    w.on = !!配置.watchOn
    if (!配置.watchOn) return

    // 菜谱在手：进度由菜谱推；没有菜谱：走通用阶段
    if (菜谱) 推菜谱(物体)
    else 推阶段(物体)
  }

  /**
   * 把「做饭」接成视觉的订阅者。
   *
   * 以前 检测一轮() 里直接调 判观察()，做饭状态机是焊死在视觉循环里的；
   * 现在改成订阅：视觉不认识做饭，做饭自己挂上去。
   * 以后「帮我盯着猫」照抄这个模式即可 —— 加一个 订阅视觉(自己的处理函数)。
   *
   * ctx.effect 保证插件卸载时自动退订，不会留下悬空回调。
   */
  ctx.effect(() => {
    const 退订 = 订阅视觉((物体) => 判观察(物体))
    记账('做饭状态机已订阅视觉广播')
    return () => {
      try {
        退订()
      } catch {}
      记账('做饭状态机已退订')
    }
  })

  // 把「做饭」登记成挂在视觉下面的一个模块 —— 前端照这份清单渲染，不写死。
  ctx.effect(() =>
    注册模块({
      id: 'cook',
      名: '做饭',
      说明: '盯着锅看火候，按菜谱一步步提示；出事（冒烟/糊）先开口。',
      配置: [
        {
          键: 'cookDish',
          标签: '想做什么菜',
          类型: '文本',
          占位: '比如：番茄炒蛋',
          说明: '填菜名，点「开始做」后模型会查/编一份菜谱导进来，然后摄像头按步骤跟。',
        },
        {
          键: 'watchSpeak',
          标签: '阶段变化时出声',
          类型: '开关',
          说明: '关掉 = 只更新面板和上下文，不主动念。',
        },
        {
          键: 'watchCooldown',
          标签: '异常冷却（秒）',
          类型: '数字',
          说明: '同一个异常多久内不重复提醒。',
        },
      ],
      操作: [{ 键: '开始做', 标签: '开始做', 需要: 'cookDish' }],
      状态: () => ({
        已启用: !!配置.watchOn,
        菜谱: 菜谱 ? 菜谱.名称 : '',
        第几步: 状态.watch.步骤 >= 0 && 菜谱 ? 状态.watch.步骤 + 1 : 0,
        总步数: 菜谱 ? 菜谱.步骤.length : 0,
        步名: 状态.watch.步名,
        // ⚠ 有菜谱时 推菜谱 不走 推阶段，状态.watch.阶段 一直是空 —— 面板会显示一栏空白。
        //   这里把「阶段」在有菜谱时改成菜谱视角，没有菜谱时才用通用阶段机。
        阶段: 菜谱 ? '菜谱·' + (状态.watch.步名 || '未开始') : 状态.watch.阶段,
        进度: 目前进度(),
        认出: 状态.look.摘要,
        开口数: 状态.watch.开口数,
      }),
    }),
  )

  /** 没有菜谱时的通用阶段机 */
  function 推阶段(物体) {
    const w = 状态.watch
    const 建议 = 判阶段(物体)
    const 现在 = Date.now()

    // —— 出事：不要求稳住，一看见就说（带冷却）
    if (建议.异常) {
      w.当前异常 = 建议.阶段
      const 冷 = Math.max(20, Number(配置.watchCooldown) || 90) * 1000
      if (现在 - 冒烟上次说 > 冷) {
        冒烟上次说 = 现在
        w.依据 = 建议.依据
        w.变于 = 现在
        void 主动开口('锅里好像在冒烟了（' + (状态.look.摘要 || 建议.依据) + '），要不要看一眼火？')
        w.历史.push({ at: 现在, 从: w.阶段, 到: '冒烟', 依据: 建议.依据 })
        if (w.历史.length > 30) w.历史.shift()
      }
      return
    }
    w.当前异常 = ''

    // —— 只往前走：回头的不算
    const 目标位 = 状态顺序.indexOf(建议.阶段)
    const 现在位 = w.阶段 ? 状态顺序.indexOf(w.阶段) : -1

    // 「有人」不算做菜阶段，别让它在有人/没人之间来回跳
    if (建议.阶段 === '有人' || 建议.阶段 === '空') {
      w.候选 = null
      w.连续 = 0
      return
    }

    if (目标位 <= 现在位) {
      w.候选 = null
      w.连续 = 0
      return
    }

    // 同系内的推进（热锅→下锅）只要 2 帧；跨段（备菜→热锅）要 3 帧
    if (w.候选 === 建议.阶段) w.连续++
    else {
      w.候选 = 建议.阶段
      w.连续 = 1
    }
    const 需要 = 目标位 - 现在位 > 1 ? 3 : 2
    if (w.连续 < 需要) return

    const 旧 = w.阶段
    w.阶段 = 建议.阶段
    w.依据 = 建议.依据
    w.变于 = 现在
    w.候选 = null
    w.连续 = 0
    if (!旧) return // 第一次进入状态机：只登记，不打扰

    w.历史.push({ at: 现在, 从: 旧, 到: w.阶段, 依据: 建议.依据 })
    if (w.历史.length > 30) w.历史.shift()
    记账('阶段：' + 旧 + ' → ' + w.阶段 + '（' + 建议.依据 + '）')

    // 跳档才开口 —— 这是她要的「锅里状态一变就说话」
    const 话 = 阶段口令[w.阶段]
    if (配置.watchSpeak && 话) void 主动开口(话)
  }

  /** 眼睛：视频开着 + lookOn 开着，就按 lookHz 一直认；强制 = 这一次不管开关 */
  async function 检测一轮(强制) {
    状态.look.on = !!配置.lookOn
    if (!强制 && !配置.lookOn) return
    if (!状态.video.on || !视频.最新) return
    if (检测忙) return
    const 现在 = Date.now()
    if (!强制 && 现在 < 下次检测) return
    if (!强制 && 状态.video.at === 上次检测帧) return
    检测忙 = true
    下次检测 = 现在 + 1000 / Math.max(0.3, Number(配置.lookHz) || 2)
    const 帧时 = 状态.video.at
    try {
      const 路径 = join(截图目录, 'latest.jpg')
      writeFileSync(路径, 视频.最新)
      const 开始 = Date.now()
      const r = await 眼睛.查(路径)
      const 物体 = (r.objects || []).map((o) => ({ ...o, 中文: 中文名(o.label) }))
      状态.look = {
        on: true,
        at: Date.now(),
        物体: 物体.slice(0, 12),
        摘要: 组摘要(物体),
        毫秒: Date.now() - 开始,
        错误: '',
        设备: 眼睛.设备,
      }
      // 视觉只管「认出什么」，认完广播出去；谁要用这些结果（做饭、看猫…）谁自己订阅。
      // ⚠ 这里不再直接调 判观察 —— 视觉不该知道做饭的存在。
      广播视觉(物体, 状态.look)
      上次检测帧 = 帧时
    } catch (error) {
      状态.look = { ...状态.look, on: true, 错误: String((error && error.message) || error) }
    } finally {
      检测忙 = false
    }
  }

  ctx.effect(() => () => { 能力开了 = false })

  /** 把 look_camera / camera_state / watch_camera 挂上去（全局） */
  function 挂工具() {
    if (工具收尾) return
    try {
      const 各有 = [ctx.tools.register(做摄像头工具()), ctx.tools.register(做状态工具()), ctx.tools.register(做盯着工具()), ctx.tools.register(做菜谱工具())]
      工具收尾 = () => {
        for (const off of 各有) {
          try {
            off()
          } catch {}
        }
      }
      记账('look_camera / camera_state / watch_camera / recipe_import 已注册（所有会话可用）')
    } catch (error) {
      记账('工具挂不上：' + ((error && error.message) || error))
    }
  }

  const 卸载工具 = () => {
    if (工具收尾) {
      try {
        工具收尾()
      } catch {}
    }
    工具收尾 = null
  }

  /**
   * ⚠ 2026-11-04（这次崩溃之后改的）：**开机什么都不做**。
   *   以前在 apply 里就把工具、提示词注入、400ms 定时器全挂上 —— 意思是 DSH 每次启动
   *   都得先跑一遍我这套东西。万一中间有一处抛了，整个宿主就起不来（桌面版直接弹
   *   「应用无法启动或意外终止」）。
   *   现在改成：**等你真的点了「开始听 / 看画面 / 盯着」才把能力挂上去**。
   *   开机只剩几条 HTTP 路由（那种出问题最多是这个插件用不了，不会带崩整个应用）。
   */
  let 能力开了 = false
  function 起能力() {
    if (能力开了) return
    能力开了 = true
    try {
      挂工具()
    } catch (error) {
      记账('起能力/工具：' + ((error && error.message) || error))
    }
    try {
      挂注入()
    } catch (error) {
      记账('起能力/注入：' + ((error && error.message) || error))
    }
    try {
      // ⚠ 定时器里的 async 函数必须自己接住 rejection，否则 Node 22+ 直接退出进程
      ctx.effect(() => ctx.interval(() => { void 检测一轮().catch(() => {}) }, 400))
    } catch (error) {
      记账('起能力/循环：' + ((error && error.message) || error))
    }
  }

  // 她说话的时候，我这边已经知道锅到哪一步了。
  // 用 context 不是 section：context 是「每轮都可能变」的那条，只有内容真变了才追加一条，
  // 系统提示词不动 → 缓存照旧命中（这条是 fish-memory 踩出来的经验）。
  function 挂注入() {
    try {
      ctx.effect(() =>
        ctx.systemPrompt.context({
          name: 'camera-state',
          order: 900,
          interpolate: false,
          text: () => {
            try {
              const w = 状态.watch
              if (!配置.watchOn || !w.阶段) return ''
              return (
                '【摄像头】这会儿大概在「' + w.阶段 + '」，画面里是：' + (状态.look.摘要 || '没认出来什么') +
                '。她可能一边做一边问，回答短一点、先说下一步该干什么。'
              )
            } catch (error) {
              return ''
            }
          },
        }),
      )
      记账('状态注入已挂上（camera-state）')
    } catch (error) {
      记账('状态注入挂不上：' + ((error && error.message) || error))
    }
  }

  // 一句话自测：不经过麦克风，直接拿一段 wav 走「转写 → 送会话」
  挂(P + '/selftest', async (req, res) => {
    const 体 = await 读体(req)
    const 文本 = String(体.text || '').trim()
    if (!文本) {
      回(res, 400, { ok: false, error: '给个 text' })
      return
    }
    const 送 = await 送进会话(ctx, 配置, 文本)
    回(res, 200, 送)
  })

  记账('已加载；配置 ' + 配置路径)
}

// ---------------------------------------------------------------- 会话

function 公开配置(配置) {
  return { ...配置 }
}

function 会话清单(ctx) {
  const 出 = []
  try {
    for (const s of ctx.sessions.list() || []) {
      let 标题 = ''
      let 更新于 = 0
      try {
        const t = ctx.sessionTitle && typeof ctx.sessionTitle.get === 'function' ? ctx.sessionTitle.get(s) : undefined
        if (t) {
          标题 = String(t.title || '')
          更新于 = Number(t.updatedAt || 0)
        }
      } catch {}
      if (!更新于) {
        try {
          更新于 = Number((s && s.header && s.header.createdAt) || 0)
        } catch {}
      }
      出.push({
        id: String((s && s.id) || ''),
        标题: 标题 || String((s && s.id) || '').slice(0, 18),
        at: 更新于,
      })
    }
  } catch (error) {}
  return 出.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30)
}

function 用户消息(文本) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(文本) }],
    source: { kind: 'camera-bridge' },
  }
}

/** 把一句话当成「你说的」送进会话。走 agent.followup —— 和打字发过去同一条路。 */
async function 送进会话(ctx, 配置, 文本) {
  const 目标 = String(配置.targetSession || '').trim()
  if (!目标) return { ok: false, 原因: '还没选会话（面板上选一个）' }
  const agent = ctx.agents.get(目标)
  if (!agent) return { ok: false, 原因: '那个会话没开着：' + 目标 }
  const 消息 = 用户消息(文本)
  try {
    // ⚠ 必须 await：未处理的 rejection 在 Node 22+ 会让整个宿主进程退出
    await agent.followup(消息)
  } catch (error) {
    return { ok: false, 原因: 'followup 失败：' + String((error && error.message) || error) }
  }
  try {
    if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
  } catch {}
  return { ok: true }
}

/** 当前 Web 端口（问朗读桥状态用） */
function 端口() {
  try {
    const u = new URL(process.env.DSH_WEB_URL || '')
    if (u.port) return u.port
  } catch {}
  return process.env.DSH_WEB_PORT || '54877'
}
