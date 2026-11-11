// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 引导 —— 第一次装完，先把「这套东西该怎么配、哪儿有坑」讲清楚
 * ==========================================================================
 * 装插件的人常常只装了插件，手里既没有「RTSP 地址」，也不知道：
 *
 *   · 视频源从哪儿来（本机摄像头根本不用地址）；
 *   · 眼睛为什么认不出烟、火、蒸汽（YOLO-World 只认有形状的东西）；
 *     以及「那能不能每帧发给云端多模态」的答案是**不能，按张计费**；
 *   · 它为什么不说话、或者说一句要等半天（朗读桥那条链路的延迟）。
 *
 * 这些都不是能猜出来的，而模型默认会「顺着用户说的编」。所以插件按**主题**放引导：
 * 每件事一小段，做完（或人说「知道了」）就撤掉那一段，全撤完提示词里就干净了。
 *
 * 三个主题共用一套状态（`引导.json`），但**各自独立完成** ——
 * 视频源配通了不该把「视觉方案」那段也一起关掉。
 *
 * 为什么单独一个文件：
 *   宿主（lib/index.js）已经够大了，而「引导」有明确的状态和边界 ——
 *   它不碰摄像头、不碰 ffmpeg、不读图片，只读写一个 引导.json 并给出文字。
 *   这样可以用假宿主直接测（test/引导.test.mjs），不用真开摄像头。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 引导状态文件（放在 <DSH_HOME>/camera-bridge/ 里，和 timing.jsonl 同级） */
export const 记录文件名 = '引导.json'

/** 状态文件格式版本（v1 是「只有一个完成于」的老格式，读的时候会被升级） */
export const 格式版本 = 2

/**
 * 引导主题表。
 *
 * ⚠ 提示词（`提示`）刻意写短：它每一轮都在系统提示词里，直到这个主题完成。
 *   能展开讲的都放 `文件` 里，模型真要做的时候用 camera_setup action="guide" 去读。
 */
export const 主题表 = [
  {
    id: 'source',
    标题: '视频源还没配通',
    摘要: '本机摄像头不用地址；网络摄像头要 RTSP，地址从 Web 后台 / App / 机身标签拿',
    文件: '1-视频源.md',
    提示: [
      '  本机 / USB 摄像头：不用地址，留空自动挑。网络摄像头：要 rtsp://…，从摄像头 Web 后台、',
      '  厂商 App 或机身标签上抄；连 IP 都不知道，就用 xpai-camera-control 的 search_devices 扫局域网。',
      '  **别自己编地址**，拿不到就问用户要。',
    ],
  },
  {
    id: 'vision',
    标题: '眼睛：YOLO-World 认不出烟、火这类「没有形状」的东西',
    摘要: '别每帧发云端多模态（按张计费）；要判这些就换本地多模态，并且只在判不了时抽一帧',
    文件: '2-视觉-本地多模态.md',
    提示: [
      '  YOLO-World 只认有边界、有形状的物体（锅、刀、手）；烟 / 火 / 蒸汽 / 生熟 / 油温它看不见。',
      '  **不要**建议把画面逐帧发给云端多模态 —— 一张图一次计费，8fps 就是一分钟几百张。',
      '  正确做法：换**本地**多模态（VLM），并且只在「YOLO 判不了」时抽一帧问它，替状态机供料、',
      '  别让对话主模型逐帧看图。',
    ],
  },
  {
    id: 'tts',
    标题: '朗读：说一句要等太久',
    摘要: '瓶颈多半在「朗读桥排队 + 浏览器扩展 + 云端合成」；可换本地 TTS（IndexTTS，吃显存）',
    文件: '3-朗读-本地TTS.md',
    提示: [
      '  延迟大头通常不是模型，而是「排进朗读桥队列 → 浏览器扩展点朗读 → 云端合成」这条链。',
      '  要快就换**本地** TTS（IndexTTS，显存要求高），把配置 ttsBase 指过去；',
      '  接口只要 /status + /stop 两个，插件这边不用改代码。',
    ],
  },
]

/** 把地址里的凭据盖掉，日志和面板上只显示 `//***@` */
export function 脱敏(地址) {
  return String(地址 || '').replace(/\/\/[^/@]*@/, '//***@')
}

/** 「rtsp://…」这种才收；空串是合法的（= 用本机摄像头） */
export function 检查地址(地址) {
  const 文 = String(地址 ?? '').trim()
  if (!文) return ''
  if (!/^rtsps?:\/\//i.test(文)) {
    throw new Error('RTSP 地址得是 rtsp:// 或 rtsps:// 开头（拿到的是「' + 文.slice(0, 32) + '」）')
  }
  if (/\s/.test(文)) {
    throw new Error('RTSP 地址里不能有空格；密码里的特殊字符要做 URL 转义（@ → %40，: → %3A，/ → %2F）')
  }
  return 文
}

/** 只把「还没完成」的主题拼成提示词；全完成就返回空串（宿主会当成没这段） */
export function 组提示词(未完成id们) {
  const 要 = 主题表.filter((t) => (未完成id们 || []).includes(t.id))
  if (!要.length) return ''
  const 行 = ['【摄像头桥 · 引导】下面这几件事还没定。做完一件少一件，全做完这段就消失：']
  for (const t of 要) {
    行.push('')
    行.push('▸ ' + t.标题)
    行.push(...t.提示)
  }
  return 行.join('\n')
}

/** 三个主题都没完成时的完整引导（文档/测试用；宿主实际用的是 组提示词） */
export const 提示词全文 = 组提示词(主题表.map((t) => t.id))

/**
 * 造一个引导对象。
 *
 * @param {object} 宿主
 * @param {string} 宿主.目录        数据目录（<DSH_HOME>/camera-bridge）
 * @param {string} [宿主.文档根]     docs 目录的绝对路径（每篇主题文档在它下面）
 * @param {() => object} [宿主.读配置]
 * @param {(补丁: object) => object} [宿主.存配置]
 * @param {(消息: string) => void} [宿主.记账]
 */
export function 建引导(宿主 = {}) {
  const 目录 = String(宿主.目录 || '')
  const 文档根 = String(宿主.文档根 || '')
  const 记账 = typeof 宿主.记账 === 'function' ? 宿主.记账 : () => {}
  const 读配置 = typeof 宿主.读配置 === 'function' ? 宿主.读配置 : () => ({})
  const 存配置 =
    typeof 宿主.存配置 === 'function' ? 宿主.存配置 : (补丁) => ({ ...读配置(), ...(补丁 || {}) })

  const 文件 = () => join(目录, 记录文件名)

  /** 老格式（只有 完成于 / 原因）升级成「视频源主题已完成」 */
  function 升级(原始) {
    const 记录 = 原始 && typeof 原始 === 'object' ? { ...原始 } : {}
    if (!记录.主题 || typeof 记录.主题 !== 'object') {
      const 主题 = {}
      if (记录.完成于) 主题.source = { 完成于: String(记录.完成于), 原因: String(记录.原因 || '已配好') }
      记录.主题 = 主题
    }
    记录.版本 = 格式版本
    return 记录
  }

  /** 读状态文件；没有 / 坏了都当成「一个都没完成」 */
  function 读记录() {
    try {
      if (!目录 || !existsSync(文件())) return 升级({})
      return 升级(JSON.parse(readFileSync(文件(), 'utf8')))
    } catch (error) {
      记账('引导记录读不了：' + ((error && error.message) || error))
      return 升级({})
    }
  }

  function 写记录(补丁) {
    const 下 = { ...读记录(), ...(补丁 || {}), 更新于: new Date().toISOString() }
    try {
      if (!目录) return 下
      if (!existsSync(目录)) mkdirSync(目录, { recursive: true })
      writeFileSync(文件(), JSON.stringify(下, null, 2), 'utf8')
    } catch (error) {
      记账('引导记录写不了：' + ((error && error.message) || error))
    }
    return 下
  }

  /** 某个主题的完成情况 */
  function 完成情况(id) {
    const 主题 = 读记录().主题 || {}
    const 条 = 主题[id]
    return 条 && typeof 条 === 'object' ? 条 : {}
  }

  /** 这个主题还没完成？ */
  function 需要(id) {
    return !完成情况(id).完成于
  }

  /** 还没完成的主题（按主题表顺序） */
  function 未完成() {
    return 主题表.filter((t) => 需要(t.id))
  }

  /** 还有没有没做完的 */
  function 需要引导() {
    return 未完成().length > 0
  }

  /** 第一次看到它时记一笔，面板上能显示「从什么时候开始引导的」 */
  function 标记首见() {
    const 记录 = 读记录()
    if (记录.首次见) return 记录.首次见
    const 时 = new Date().toISOString()
    写记录({ 首次见: 时 })
    return 时
  }

  /** 完成一个主题。幂等：已经完成的不覆盖第一次的时间 */
  function 完成主题(id, 原因) {
    const 主题 = String(id || '')
    if (!主题表.some((t) => t.id === 主题)) throw new Error('没有这个引导主题：' + 主题)
    const 记录 = 读记录()
    if (记录.主题[主题] && 记录.主题[主题].完成于) return 记录
    const 下 = 写记录({
      主题: { ...记录.主题, [主题]: { 完成于: new Date().toISOString(), 原因: String(原因 || '已处理') } },
    })
    记账('引导完成「' + 主题 + '」：' + 下.主题[主题].原因)
    return 下
  }

  /** 完成一个（传 id）或全部（不传） */
  function 完成(原因, id) {
    if (id) return 完成主题(id, 原因)
    let 记录 = 读记录()
    for (const t of 主题表) {
      if (!记录.主题[t.id] || !记录.主题[t.id].完成于) 记录 = 完成主题(t.id, 原因)
    }
    return 记录
  }

  /** 出画面了 —— 「视频源」这个主题最硬的证据 */
  function 出过画面() {
    if (!需要('source')) return false
    完成主题('source', '已经能出画面')
    return true
  }

  /** 重新开始引导：传 id 只重开那一个，不传全重开 */
  function 重置(id) {
    const 记录 = 读记录()
    if (id) {
      const 主题 = { ...记录.主题 }
      delete 主题[String(id)]
      return 写记录({ 主题 })
    }
    return 写记录({ 主题: {} })
  }

  /** 现在的视频源，一句话（凭据盖掉） */
  function 源摘要(配 = 读配置() || {}) {
    const 地址 = String(配.rtspUrl || '').trim()
    if (地址) return 'RTSP：' + 脱敏(地址)
    const 设备 = String(配.videoDevice || '').trim()
    if (设备) return '本机设备：' + 设备
    return '（还没配：RTSP 地址空着，也没指定本机设备）'
  }

  /** 下一步该干什么 —— 只按「有没有配」推，不猜硬件 */
  function 下一步(配 = 读配置() || {}) {
    if (String(配.rtspUrl || '').trim()) {
      return '地址有了：立刻试一帧（camera_setup action="set_source" 或面板「开画面」）。连不上先看 docs/引导/1-视频源.md 的「报错对照」。'
    }
    if (String(配.videoDevice || '').trim()) {
      return '用本机设备「' + 配.videoDevice + '」试一帧；起不来多半是设备被别的程序占着（摄像头是独占的）。'
    }
    return '先问清是哪一种：电脑自带 / USB 摄像头（不需要地址，留空自动挑）还是网络摄像头（要 RTSP 地址）。' +
      '地址不知道就从机身标签、Web 后台、厂商 App 拿；连 IP 都不知道就先扫局域网。'
  }

  /** 按用户/模型给的补丁改视频源。校验不过就抛（宿主那边会变成一条清楚的报错） */
  function 设置源(补丁 = {}) {
    const 改 = {}
    if (Object.prototype.hasOwnProperty.call(补丁, 'rtspUrl')) 改.rtspUrl = 检查地址(补丁.rtspUrl)
    if (Object.prototype.hasOwnProperty.call(补丁, 'videoDevice')) {
      改.videoDevice = String(补丁.videoDevice ?? '').trim()
    }
    if (!Object.keys(改).length) return 读配置()
    const 新 = 存配置(改)
    记账('引导：视频源 → ' + 源摘要(新))
    return 新
  }

  function 读文件(相对) {
    try {
      if (!文档根 || !相对) return ''
      const 路 = join(文档根, 相对)
      if (!existsSync(路)) return ''
      return String(readFileSync(路, 'utf8'))
    } catch (error) {
      记账('引导文档读不了：' + ((error && error.message) || error))
      return ''
    }
  }

  /** 总览（docs/引导.md） */
  function 读总览() {
    return 读文件('引导.md')
  }

  /** 某个主题的完整文档；主题不存在返回空串 */
  function 读主题文档(id) {
    const 主题 = 主题表.find((t) => t.id === String(id))
    return 主题 ? 读文件(join('引导', 主题.文件)) : ''
  }

  /** 兼容老接口：不带参数时给总览 */
  function 读文档() {
    return 读总览()
  }

  /** 给 /state 和工具看的一份快照 */
  function 状态() {
    const 记录 = 读记录()
    const 配 = 读配置() || {}
    const 剩 = 未完成()
    const 全部完成 = !剩.length
    return {
      需要引导: !全部完成,
      首次见: 记录.首次见 || '',
      完成于: 全部完成 ? String((记录.主题.source && 记录.主题.source.完成于) || 记录.更新于 || '') : '',
      完成原因: 全部完成 ? '全部处理完了' : '',
      主题: 主题表.map((t) => {
        const 条 = 完成情况(t.id)
        return {
          id: t.id,
          标题: t.标题,
          摘要: t.摘要,
          需要: !条.完成于,
          完成于: 条.完成于 || '',
          原因: 条.原因 || '',
          文档: 文档根 ? join(文档根, '引导', t.文件) : '',
        }
      }),
      视频源: 源摘要(配),
      下一步: 下一步(配),
      文档: 文档根 ? join(文档根, '引导.md') : '',
    }
  }

  /** 往提示词里放的那段：没有未完成主题时是空串 */
  function 提示词() {
    return 组提示词(未完成().map((t) => t.id))
  }

  return {
    需要引导,
    需要,
    未完成,
    标记首见,
    完成,
    完成主题,
    出过画面,
    重置,
    设置源,
    读总览,
    读主题文档,
    读文档,
    状态,
    提示词,
    源摘要,
    下一步,
  }
}
