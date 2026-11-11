// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 做饭 —— 挂在摄像头桥下面的一个模块
 * ==========================================================================
 * 这个文件**不认识摄像头，也不认识视觉循环**。
 *
 * 宿主（lib/index.js）把下面这些打包成一个 宿主 对象传进来：
 *   取配置 / 存配置   配置读写（返回的是最新一份）
 *   状态             运行时状态（video / look / watch …）
 *   记账             写诊断日志
 *   目录             数据目录（<DSH_HOME>/camera-bridge）
 *   ctx              插件上下文（要用 ctx.agents 找人）
 *   送进会话         把一句话当「她说的」送进会话
 *   视频 / 检测一轮 / 起能力   摄像头那套（「开始做」要用）
 *   回 / 读体 / P    路由小工具
 *   用户消息         造一条 user 消息
 *   模块清单         给面板的模块列表
 *
 * 模块自己决定「认出来之后干什么」——想加「盯着猫」，照这个文件抄一份，
 * 宿主只会多挂一个模块，别的都不用改。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function 创建做饭模块(宿主) {
  const {
    状态, 记账, 目录, ctx, 送进会话, 视频, 检测一轮, 起能力,
    回, 读体, P, 用户消息, 中文名, 模块清单,
    拍一张, 送图给模型,
  } = 宿主

  let 配置 = 宿主.取配置()
  /** 写配置：同时更新宿主那份，并把最新值留在本地 */
  const 存配置 = (补丁) => {
    配置 = 宿主.存配置(补丁)
    return 配置
  }
  /** 别的地方（面板）可能改过配置，用之前刷新一下 */
  const 刷新配置 = () => {
    配置 = 宿主.取配置()
  }

  let 冒烟上次说 = 0

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
        // 这一步状态机自己判不了 → 让模型看一眼（**只这一次**，不是定时）
        void 请求看图(
          `第 ${当.索引 + 1} 步「${当.步.名称}」已经过了 ${已过秒} 秒，` +
            `画面里是「${状态.look.摘要 || '没认出来什么'}」，看不出能不能进下一步。`,
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

  // ---------------------------------------------------------------- 看图兜底
  /**
   * 兜底：拍一张**直接发给模型**，让它自己判断。
   *
   * ⚠ 这**不是定时轮询** —— 只有「状态机自己判不了」时才调：
   *   ① 某一步到了时长、但看不到硬条件 → 让模型看一眼能不能进下一步
   *   ② 画面很久没有任何推进 → 看门狗确认一次
   * 其余时候（YOLO 认得出、步骤能按条件推进）**一次都不发图**，不烧 token。
   *
   * 两次之间至少隔 `snapCooldownSec` 秒，防止连续触发把图刷屏。
   */
  let 上次发图 = 0
  let 发图中 = false

  async function 请求看图(原因) {
    刷新配置()
    if (!配置.watchOn) return false
    if (发图中) return false
    const 冷 = Math.max(0, Number(配置.snapCooldownSec) || 0) * 1000
    const 现在 = Date.now()
    if (冷 > 0 && 现在 - 上次发图 < 冷) return false

    发图中 = true
    上次发图 = 现在
    try {
      const 拍 = await 拍一张()
      const 帧 = readFileSync(拍.文件)
      const 进度 = 目前进度()
      const 话 =
        '【需要你看一眼】' + (原因 ? 原因 + ' ' : '') +
        (进度 ? 进度 + '。' : '') +
        '画面在附件里。判断一下：还能不能按菜谱走？有没有冒烟、糊底、溢锅？' +
        '一切正常就**只回一个句号**，别说话；有问题再用一句话说清楚。'
      const 送 = await 送图给模型(话, 帧)
      if (送.ok) 记账('看图兜底：' + (原因 || '（无原因）'))
      else 记账('看图兜底没发出去：' + (送.原因 || ''))
      return !!送.ok
    } catch (error) {
      记账('看图兜底出错：' + ((error && error.message) || error))
      return false
    } finally {
      发图中 = false
    }
  }

  /**
   * 看门狗：画面很久没推进，主动看一眼。
   * 最多每 `stuckSec` 秒一次 —— 是「卡住了」才触发，不是定时心跳。
   */
  let 上次看门狗 = 0
  function 检查看门狗() {
    刷新配置()
    const 静默秒 = Number(配置.stuckSec) || 0
    if (静默秒 <= 0) return
    const w = 状态.watch
    const 基准 = Math.max(w.变于 || 0, w.步开始 || 0)
    if (!基准) return
    const 现在 = Date.now()
    const 多久 = 现在 - 基准
    if (多久 < 静默秒 * 1000) return
    if (现在 - 上次看门狗 < 静默秒 * 1000) return
    上次看门狗 = 现在
    void 请求看图('画面已经 ' + Math.round(多久 / 1000) + ' 秒没有新进展了。')
  }

  /** 每认完一帧：推进状态机；跳档就开口 */
  function 判观察(物体) {
    const w = 状态.watch
    w.on = !!配置.watchOn
    if (!配置.watchOn) return

    // 菜谱在手：进度由菜谱推；没有菜谱：走通用阶段
    if (菜谱) 推菜谱(物体)
    else 推阶段(物体)

    // 兜底看门狗：只有真的卡住了才会发图
    检查看门狗()
  }


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
  async function 处理开始做(req, res) {
    起能力()
    刷新配置()
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
    回(res, 200, { ok: true, 菜, modules: 模块清单() })
  }

  // ---------------------------------------------------------------- 对外
  return {
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
      {
        键: 'snapCooldownSec',
        标签: '看图冷却（秒）',
        类型: '数字',
        说明: '两次「发图让模型看一眼」之间至少隔多久。这是兜底，不是定时轮询。',
      },
      {
        键: 'stuckSec',
        标签: '卡住多久问一次（秒）',
        类型: '数字',
        说明: '画面这么久没有任何进展才主动看一眼；0 = 关。',
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
    工具: [做盯着工具(), 做菜谱工具()],
    路由: [{ 路径: P + '/modules/cook/start', 处理: 处理开始做 }],
    接上视觉(物体) {
      刷新配置()
      判观察(物体)
    },
    /** 写进系统提示词的那一行（每轮都问它） */
    上下文() {
      刷新配置()
      const w = 状态.watch
      if (!配置.watchOn || !w.阶段) return ''
      return (
        '【摄像头】这会儿大概在「' + w.阶段 + '」，画面里是：' + (状态.look.摘要 || '没认出来什么') +
        '。她可能一边做一边问，回答短一点、先说下一步该干什么。'
      )
    },
    卸载() {},
  }
}
