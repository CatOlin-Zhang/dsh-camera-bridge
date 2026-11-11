// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 做饭模块的「看图兜底」—— 什么时候才允许花一次模型调用去看画面。
 *
 * 它是**事件驱动**的，不是定时轮询：
 *   ① 某一步到了时长、但硬条件没满足 → 看一眼（同一步只问一次）
 *   ② 画面 / 进度很久没推进 → 看门狗看一眼（每 stuckSec 最多一次）
 *   ③ 其余情况（条件能推进、没有菜谱也不卡）→ 一张都不发
 *
 * ⚠ 这里刻意**不测任何声音信号**：麦克风不保证收得到水开的咕嘟声、油的滋啦声，
 *   把做饭的判断建在这些声音上，等于建在运气上。所以决策输入只有两样：
 *   **时间** 和 **画面认出来的东西**。
 *
 * 下面全部用假宿主驱动真模块（lib/modules/cook.js），不碰摄像头、不碰模型、不碰网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { 创建做饭模块 } from '../lib/modules/cook.js'

/** 测试建的临时目录，跑完统一删掉（不留垃圾） */
const 临时目录 = []
process.on('exit', () => {
  for (const d of 临时目录) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------- 假的钟
const 钟 = (() => {
  const 真 = Date.now
  let 基准 = 0
  let 偏移 = 0
  return {
    装() {
      // 从「真实世界的时间」起步，不能是 0 —— 模块里 步开始=0 是「还没开始」的哨兵值
      偏移 = 0
      基准 = 真()
      Date.now = () => 基准 + 偏移
    },
    卸() {
      Date.now = 真
      偏移 = 0
    },
    进(毫秒) {
      偏移 += 毫秒
    },
  }
})()

/** 让挂起的 promise 链跑完（模块里是 `void 请求看图(...)`，不等它） */
const 等 = () => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------- 假宿主
function 造宿主(覆盖 = {}) {
  const 目录 = mkdtempSync(join(tmpdir(), 'cook-test-'))
  临时目录.push(目录)
  mkdirSync(join(目录, 'recipes'), { recursive: true })

  let cfg = {
    watchOn: true,
    watchSpeak: false,
    watchCooldown: 90,
    snapCooldownSec: 20,
    stuckSec: 180,
    lookOn: true,
    targetSession: 's1',
    ...(覆盖.配置 || {}),
  }

  const 状态 = {
    video: { on: true, 宽: 0, 高: 0, at: 0, device: 'fake', error: '' },
    mic: { rms: 0, 打断次数: 0, 上次打断: 0, 回声力度: null },
    look: { on: true, at: 0, 摘要: '', 物体: [], 毫秒: 0, 错误: '', 设备: 'fake', 准备: '' },
    watch: {
      on: false, 阶段: '', 依据: '', 变于: 0, 开口数: 0,
      上次开口: '', 上次开口于: 0, 候选: null, 连续: 0, 当前异常: '', 历史: [],
      步骤: -1, 步名: '', 步开始: 0, 疑似: '', 比例尺: null,
    },
    diag: [],
  }

  const 送图 = []
  const 开口 = []
  const 日志 = []

  const 宿主 = {
    取配置: () => cfg,
    存配置(补丁) {
      cfg = { ...cfg, ...补丁 }
      return cfg
    },
    状态,
    记账: (m) => 日志.push(String(m)),
    目录,
    ctx: {
      agents: {
        get: () => ({ session: {}, followup: async (m) => 开口.push(m) }),
      },
    },
    送进会话: async () => ({ ok: true }),
    视频: { 起: async () => {}, 等一帧: async () => null, 停: () => {}, 最新: null, 最新于: 0, on: true },
    检测一轮: async () => {},
    起能力: () => {},
    回: () => {},
    读体: async () => ({}),
    P: '/api/camera-bridge',
    用户消息: (t) => ({ role: 'user', content: t }),
    中文名: (l) => l,
    模块清单: () => ['cook'],
    拍一张: async () => {
      const 名 = join(目录, 'shot-' + Date.now() + '.jpg')
      writeFileSync(名, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      return { 文件: 名 }
    },
    送图给模型: async (话, 帧) => {
      送图.push({ 话, 帧 })
      return { ok: true }
    },
  }

  if (覆盖.菜谱) {
    writeFileSync(join(目录, 'recipes', 'current.json'), JSON.stringify(覆盖.菜谱), 'utf8')
  }

  return { 宿主, 状态, 送图, 开口, 日志, 目录 }
}

const 人 = [{ label: 'person', 中文: '人' }]
const 刀 = [{ label: 'knife', 中文: '刀' }]
const 锅 = [{ label: 'wok', 中文: '炒锅' }]

// ---------------------------------------------------------------- ① 到时不满足
test('到了时长但条件没满足：看一眼，同一步只问一次', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图, 状态 } = 造宿主({
    菜谱: { 名称: '番茄炒蛋', 步骤: [{ 名称: '下锅', 时长秒: 60, 条件: [{ 类型: '见', 词: ['锅'] }] }] },
  })
  const 模块 = 创建做饭模块(宿主)

  // 起步这一帧只登记，不该发图
  模块.接上视觉(人)
  await 等()
  assert.equal(状态.watch.步骤, 0)
  assert.equal(送图.length, 0, '起步不该看图')

  // 还没到时长
  钟.进(30_000)
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 0, '没到时长不该看图')

  // 到时长、但没看见锅
  钟.进(31_000)
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 1, '到时长还没条件 → 看一眼')
  assert.match(送图[0].话, /需要你看一眼/)
  assert.match(送图[0].话, /只回一个句号/, '要说清「没事别说话」')
  assert.ok(Buffer.isBuffer(送图[0].帧) || ArrayBuffer.isView(送图[0].帧), '得把画面一起发过去')

  // 同一境况再来一帧：不许连发
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 1, '同一步只问一次')
})

// ---------------------------------------------------------------- ② 冷却
test('冷却期内，看门狗也发不出去', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图 } = 造宿主({
    配置: { snapCooldownSec: 120, stuckSec: 30 },
    菜谱: { 名称: '番茄炒蛋', 步骤: [{ 名称: '下锅', 时长秒: 60, 条件: [{ 类型: '见', 词: ['锅'] }] }] },
  })
  const 模块 = 创建做饭模块(宿主)

  模块.接上视觉(人)
  钟.进(61_000)
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 1)

  // 40 秒后：看门狗想发，但 120 秒冷却没到
  钟.进(40_000)
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 1, '冷却期内不许再发')

  // 再等到第一张图之后满 120 秒
  钟.进(81_000)
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 2, '冷却过了才允许')
})

// ---------------------------------------------------------------- ③ 正常推进
test('条件能推进的时候，一张图都不发', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图, 状态 } = 造宿主({
    菜谱: {
      名称: '炒个菜',
      步骤: [
        { 名称: '备菜', 条件: [{ 类型: '见', 词: ['刀'] }] },
        { 名称: '下锅', 条件: [{ 类型: '见', 词: ['锅'] }] },
      ],
    },
  })
  const 模块 = 创建做饭模块(宿主)

  模块.接上视觉(刀)
  模块.接上视觉(刀)
  await 等()
  assert.equal(状态.watch.步骤, 1, '看见刀 → 进第 2 步')

  模块.接上视觉(锅)
  await 等()
  assert.equal(状态.watch.步骤, 2, '看见锅 → 全部做完')

  assert.equal(送图.length, 0, '全程自己判得了，就别烧 token 看图')
})

// ---------------------------------------------------------------- ④ 没菜谱也有兜底
test('没菜谱、纯盯着看：卡住了最多每 stuckSec 看一次', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图, 状态 } = 造宿主({ 配置: { stuckSec: 30, snapCooldownSec: 10 } })
  const 模块 = 创建做饭模块(宿主)

  // 同一件东西连着认出来（阶段要稳 3 帧才认）
  模块.接上视觉(锅)
  模块.接上视觉(锅)
  模块.接上视觉(锅)
  await 等()
  assert.equal(状态.watch.阶段, '下锅')
  assert.equal(送图.length, 0, '刚推进过，不算卡住')

  钟.进(31_000)
  模块.接上视觉(锅)
  await 等()
  assert.equal(送图.length, 1, '30 秒没动静 → 看一眼')

  钟.进(31_000)
  模块.接上视觉(锅)
  await 等()
  assert.equal(送图.length, 2, '再过 30 秒 → 再看一眼')
})

test('stuckSec=0 就把看门狗关掉', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图 } = 造宿主({ 配置: { stuckSec: 0 } })
  const 模块 = 创建做饭模块(宿主)

  模块.接上视觉(锅)
  模块.接上视觉(锅)
  模块.接上视觉(锅)
  钟.进(3_600_000)
  模块.接上视觉(锅)
  await 等()
  assert.equal(送图.length, 0)
})

// ---------------------------------------------------------------- ⑤ 成本有上限
test('不看着不动（比如小火炖 10 分钟）：一共最多 3 张图', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图 } = 造宿主({
    配置: { stuckSec: 180, snapCooldownSec: 20 },
    菜谱: { 名称: '炖着', 步骤: [{ 名称: '小火炖', 时长秒: 3600, 条件: [{ 类型: '见', 词: ['锅'] }] }] },
  })
  const 模块 = 创建做饭模块(宿主)

  模块.接上视觉(人)
  // 每 10 秒认一帧，持续 10 分钟
  for (let i = 0; i < 60; i++) {
    钟.进(10_000)
    模块.接上视觉(人)
    await 等()
  }
  assert.equal(送图.length, 3, '180 秒一次 × 10 分钟 ≈ 3 张')
})

// ---------------------------------------------------------------- ⑥ 开关
test('没开「盯着」就一张都不发', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图 } = 造宿主({ 配置: { watchOn: false } })
  const 模块 = 创建做饭模块(宿主)

  模块.接上视觉(人)
  钟.进(3_600_000)
  模块.接上视觉(人)
  await 等()
  assert.equal(送图.length, 0)
})

test('选不到会话也不炸，只是记账说没发出去', async (t) => {
  钟.装()
  t.after(() => 钟.卸())
  const { 宿主, 送图, 状态 } = 造宿主({ 配置: { stuckSec: 30 } })
  宿主.送图给模型 = async () => ({ ok: false, 原因: '没有目标会话' })
  const 模块 = 创建做饭模块(宿主)

  模块.接上视觉(锅)
  模块.接上视觉(锅)
  模块.接上视觉(锅)
  钟.进(31_000)
  模块.接上视觉(锅)
  await 等()
  assert.equal(送图.length, 0)
  assert.ok(状态.watch.阶段, '看不了图也不影响状态机')
})

// ---------------------------------------------------------------- ⑦ 不靠声音
test('做饭的判断里没有任何声音输入', () => {
  const 源 = readFileSync(new URL('../lib/modules/cook.js', import.meta.url), 'utf8')
  // 只禁「输入声音」：麦克风电平、听音器、转写。
  // 「出声」(TTS 念出来) 是输出，不算。
  for (const 词 of ['状态.mic', 'rms', '听音器', 'asr', '麦克风', '音频']) {
    assert.equal(源.includes(词), false, '做饭模块不该依赖声音：「' + 词 + '」')
  }
})
