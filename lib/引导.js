// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 引导 —— 第一次装完，先告诉模型「视频源从哪儿来」
 * ==========================================================================
 * 装插件的人常常只装了插件，手里并没有「RTSP 地址」这种东西：
 *
 *   · 有的电脑自带摄像头 —— 根本不需要地址，留空就行；
 *   · 有的是网络摄像头（IPC）—— 地址藏在机身标签、Web 后台、厂商 App 里；
 *   · 有的连摄像头在哪都不知道 —— 得先去局域网里找。
 *
 * 这些都不是能猜出来的。所以插件在**还没配通**的时候，往系统提示词里放一段引导，
 * 把「去哪拿 / 拿不到怎么找 / 拿到怎么试」讲清楚；一旦出了画面（或人/模型确认了），
 * 这段就消失，之后不再占用上下文。
 *
 * 为什么单独一个文件：
 *   宿主（lib/index.js）已经够大了，而「引导」这件事有明确的状态和边界 ——
 *   它不碰摄像头、不碰 ffmpeg、不读图片，只读写一个 引导.json 并给出文字。
 *   这样可以用假宿主直接测（test/引导.test.mjs），不用真开摄像头。
 *
 * 状态只有一条：`完成于`。为空 = 还在引导；有值 = 配通了 / 用户说不用了。
 * 「出过画面」不是一个独立开关，而是自动把 `完成于` 写上 —— 能出画面，就等于配好了。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 引导状态文件（放在 <DSH_HOME>/camera-bridge/ 里，和 timing.jsonl 同级） */
export const 记录文件名 = '引导.json'

/** 完整引导文档（相对包根；npm 包里会带上，装完就能读） */
export const 文档相对路径 = 'docs/引导.md'

/**
 * 往系统提示词里放的那段。
 *
 * ⚠ 刻意写成**常量**：提示词每变一次，DeepSeek 的前缀缓存就废一次（见 lib/模块 里的教训）。
 *   这里一个字都不随配置变 —— 现状、缺什么、下一步都交给 camera_setup 工具按需回答。
 */
export const 提示词全文 = [
  '【摄像头桥 · 首次配置引导】',
  '摄像头桥（camera-bridge）装好了，但「视频源」还没配通。先帮用户把视频源接上，**不要自己编 RTSP 地址**。',
  '',
  '① 看现状：camera_setup（action="status"）→ 现在填了什么、自检缺什么、下一步做什么。',
  '② 分清两种摄像头：',
  '   · 电脑自带 / USB 摄像头：**不需要 RTSP 地址**。留空让它自动挑，或把设备名填进 videoDevice。',
  '   · 网络摄像头（海康、大华、TP-Link、萤石、小米…）：要 RTSP 地址，依次从这几处拿：',
  '     a. 摄像头 Web 后台：浏览器开 http://<摄像头IP>，登录后找「RTSP / 取流地址 / 网络高级」',
  '     b. 厂商客户端（iVMS-4200、大华 ConfigTool、TP-Link Tapo…）里的取流地址',
  '     c. 机身标签 / 说明书上印的默认地址（密码通常就在标签上）',
  '③ 连 IP 都不知道（「找不到摄像头」）：',
  '   · 有 xpai-camera-control 技能 → 用它 search_devices 扫局域网（会写回 IP、端口）',
  '   · 没有 → 让用户去路由器后台「在线设备」念一个 IP 给你，或用 ONVIF Device Manager 搜',
  '   · 各品牌默认路径、端口、报错对照在 docs/引导.md（camera_setup action="guide" 直接读），别猜',
  '④ 配通：camera_setup（action="set_source", rtspUrl="..."）会立刻试一帧；成了调 camera_setup（action="done"），',
  '   引导就不再出现。没成按报错走：401/403 = 密码错，超时 = 不在线或不同网段，花屏 / 只有声音 = 编码是 H.265。',
  '',
  '⚠ 地址里带密码：别写进要提交的文件，别贴到公开地方。',
].join('\n')

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

/**
 * 造一个引导对象。
 *
 * @param {object} 宿主
 * @param {string} 宿主.目录        数据目录（<DSH_HOME>/camera-bridge）
 * @param {string} [宿主.文档路径]   完整引导文档的绝对路径
 * @param {() => object} [宿主.读配置]
 * @param {(补丁: object) => object} [宿主.存配置]
 * @param {(消息: string) => void} [宿主.记账]
 */
export function 建引导(宿主 = {}) {
  const 目录 = String(宿主.目录 || '')
  const 文档路径 = String(宿主.文档路径 || '')
  const 记账 = typeof 宿主.记账 === 'function' ? 宿主.记账 : () => {}
  const 读配置 = typeof 宿主.读配置 === 'function' ? 宿主.读配置 : () => ({})
  const 存配置 =
    typeof 宿主.存配置 === 'function' ? 宿主.存配置 : (补丁) => ({ ...读配置(), ...(补丁 || {}) })

  const 文件 = () => join(目录, 记录文件名)

  /** 读状态文件；没有 / 坏了都当成「还没配通」 */
  function 读记录() {
    try {
      if (!目录 || !existsSync(文件())) return {}
      const 对象 = JSON.parse(readFileSync(文件(), 'utf8'))
      return 对象 && typeof 对象 === 'object' ? 对象 : {}
    } catch (error) {
      记账('引导记录读不了：' + ((error && error.message) || error))
      return {}
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

  /** 还在引导吗（= 既没配通，也没人说「不用了」） */
  function 需要引导() {
    return !读记录().完成于
  }

  /** 第一次看到它时记一笔，面板上能显示「从什么时候开始引导的」 */
  function 标记首见() {
    if (读记录().首次见) return 读记录().首次见
    const 时 = new Date().toISOString()
    写记录({ 首次见: 时 })
    return 时
  }

  /** 结束引导（模型/用户确认、或者画面已经通了）。幂等，不会覆盖第一次的时间 */
  function 完成(原因) {
    const 记录 = 读记录()
    if (记录.完成于) return 记录
    const 下 = 写记录({ 完成于: new Date().toISOString(), 原因: String(原因 || '已配好') })
    记账('引导结束：' + 下.原因)
    return 下
  }

  /** 出画面了 —— 这就是「配通了」最硬的证据 */
  function 出过画面() {
    if (!需要引导()) return false
    完成('已经能出画面')
    return true
  }

  /** 重新开始引导（面板上的「再看一次引导」） */
  function 重置() {
    return 写记录({ 完成于: '', 原因: '' })
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
      return '地址有了：立刻试一帧（camera_setup action="set_source" 或面板「开画面」）。连不上先看 docs/引导.md 的「报错对照」。'
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

  /** 完整引导文档的内容（读不到就空串，让调用方自己决定怎么兜） */
  function 读文档() {
    try {
      if (!文档路径 || !existsSync(文档路径)) return ''
      return String(readFileSync(文档路径, 'utf8'))
    } catch (error) {
      记账('引导文档读不了：' + ((error && error.message) || error))
      return ''
    }
  }

  /** 给 /state 和工具看的一份快照 */
  function 状态() {
    const 记录 = 读记录()
    const 配 = 读配置() || {}
    return {
      需要引导: !记录.完成于,
      首次见: 记录.首次见 || '',
      完成于: 记录.完成于 || '',
      完成原因: 记录.原因 || '',
      视频源: 源摘要(配),
      下一步: 下一步(配),
      文档: 文档路径,
    }
  }

  /** 往提示词里放的那段：不用引导时是空串（宿主会把它当没这段） */
  function 提示词() {
    return 需要引导() ? 提示词全文 : ''
  }

  return {
    需要引导,
    标记首见,
    完成,
    出过画面,
    重置,
    设置源,
    读文档,
    状态,
    提示词,
    源摘要,
    下一步,
  }
}
