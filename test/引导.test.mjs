// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 引导的**行为契约** —— 装完插件，模型凭什么知道「该怎么配、哪儿有坑」。
 *
 * 要守住四件事：
 *   ① 没处理完的主题，提示词里**必须有**（否则模型只会顺着用户瞎编）；
 *   ② 处理完一个撤一个，全处理完提示词**必须没有**（不白烧上下文）；
 *   ③ 三个主题**互相独立** —— 出画面只该结束「视频源」，不该顺手把视觉/朗读也关掉；
 *   ④ 文案要点到关键动作：地址从哪拿、为什么要本地多模态、TTS 换哪个；
 *      而且必须明确「别把每帧发云端」，那是这个仓库最贵的坑。
 *
 * 全部用临时目录 + 假配置驱动真模块，不碰摄像头、不碰 ffmpeg。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { 建引导, 检查地址, 脱敏, 提示词全文, 记录文件名, 主题表 } from '../lib/引导.js'

/** 测试建的临时目录，跑完统一删掉 */
const 临时目录 = []
process.on('exit', () => {
  for (const d of 临时目录) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {}
  }
})

// ---------------------------------------------------------------- 假宿主
function 造宿主(初始配置 = {}, 选项 = {}) {
  const 根 = mkdtempSync(join(tmpdir(), 'guide-test-'))
  临时目录.push(根)
  const 目录 = join(根, 'camera-bridge')
  const 文档根 = join(根, 'docs')
  mkdirSync(join(文档根, '引导'), { recursive: true })
  if (选项.文档 !== false) {
    writeFileSync(join(文档根, '引导.md'), '# 总览\n（造的总览）', 'utf8')
    for (const t of 主题表) {
      writeFileSync(join(文档根, '引导', t.文件), '# ' + t.id + '\n（造的 ' + t.id + ' 文档）', 'utf8')
    }
  }

  let 配置 = { rtspUrl: '', videoDevice: '', micDevice: '', ttsBase: '/dsh-tts-bridge', ...初始配置 }
  const 日志 = []

  const 引导 = 建引导({
    目录,
    文档根,
    读配置: () => 配置,
    存配置(补丁) {
      配置 = { ...配置, ...补丁 }
      return 配置
    },
    记账: (m) => 日志.push(String(m)),
  })

  return { 引导, 目录, 文档根, 日志, 取配置: () => 配置 }
}

// ---------------------------------------------------------------- ① 三件事都要说
test('刚装完：三个主题都在提示词里，且各说到点子上', () => {
  const { 引导, 日志 } = 造宿主()

  assert.equal(引导.需要引导(), true)
  assert.deepEqual(引导.未完成().map((t) => t.id), ['source', 'vision', 'tts'])

  const 文 = 引导.提示词()
  assert.equal(文, 提示词全文)

  // 视频源：地址从哪拿、找不到怎么扫
  assert.match(文, /rtsp/i)
  assert.match(文, /机身标签/)
  assert.match(文, /search_devices/)
  assert.match(文, /别自己编地址|不要自己编|别猜/)

  // 视觉：YOLO 的能力边界 + 「别每帧发云端」+ 本地多模态
  assert.match(文, /YOLO-World/)
  assert.match(文, /烟|蒸汽/)
  assert.match(文, /本地/)
  assert.match(文, /别|不要/, '必须明确劝阻云端逐帧')
  assert.match(文, /云端/)

  // 朗读：IndexTTS + 两个接口
  assert.match(文, /IndexTTS/)
  assert.match(文, /\/status/)
  assert.match(文, /ttsBase/)

  assert.equal(日志.length, 0, '正常路径不该写日志')
})

test('提示词别太长（每轮都在系统提示词里）', () => {
  const { 引导 } = 造宿主()
  assert.ok(引导.提示词().length < 1400, '实际长度 ' + 引导.提示词().length)
})

// ---------------------------------------------------------------- ② 各自独立完成
test('出画面只结束「视频源」，不碰视觉和朗读', () => {
  const { 引导, 目录 } = 造宿主({ rtspUrl: 'rtsp://admin:secret@192.168.31.202:554/Streaming/Channels/101' })

  assert.equal(引导.需要('source'), true, '只是填了地址，还没证明能出画面')
  assert.equal(引导.出过画面(), true, '第一次出画面要返回 true（宿主用它记一笔）')

  assert.equal(引导.需要('source'), false)
  assert.equal(引导.需要('vision'), true, '视觉那条不该被顺带关掉')
  assert.equal(引导.需要('tts'), true, '朗读那条不该被顺带关掉')
  assert.equal(引导.需要引导(), true)
  assert.equal(引导.出过画面(), false, '幂等：已经结束就不算「刚出画面」')

  const 文 = 引导.提示词()
  assert.equal(文.includes('视频源还没配通'), false, '配通了就别再提视频源')
  assert.match(文, /YOLO-World/)
  assert.match(文, /IndexTTS/)

  // 状态落盘了
  const 记录 = JSON.parse(readFileSync(join(目录, 记录文件名), 'utf8'))
  assert.ok(记录.主题.source.完成于, '完成时间要记下来')
  assert.match(String(记录.主题.source.原因), /画面/, '原因得说清楚是「画面通了」')
})

test('全部处理完：提示词变空；重置能再来一次', () => {
  const { 引导 } = 造宿主()

  引导.完成('人说不用了')
  assert.equal(引导.需要引导(), false)
  assert.equal(引导.提示词(), '')

  引导.重置()
  assert.equal(引导.需要引导(), true)
  assert.deepEqual(引导.未完成().map((t) => t.id), ['source', 'vision', 'tts'])
})

test('重置单个主题只重开那一条', () => {
  const { 引导 } = 造宿主()
  引导.完成('知道了')
  assert.equal(引导.需要引导(), false)

  引导.重置('vision')
  assert.deepEqual(引导.未完成().map((t) => t.id), ['vision'])
  assert.equal(引导.需要('source'), false)
})

test('完成单个主题：只撤那一条，理由记下来', () => {
  const { 引导 } = 造宿主()

  引导.完成主题('tts', '用户说用 edge-tts 就行')
  assert.equal(引导.需要('tts'), false)
  assert.equal(引导.需要('source'), true)
  assert.equal(引导.需要('vision'), true)

  const 条 = (引导.状态().主题 || []).find((t) => t.id === 'tts')
  assert.equal(条.需要, false)
  assert.equal(条.原因, '用户说用 edge-tts 就行')
  assert.equal(引导.提示词().includes('IndexTTS'), false, '撤了就不该再提')
  assert.match(引导.提示词(), /search_devices/, '没撤的还在')

  // 不存在的主题要当场报错
  assert.throws(() => 引导.完成主题('nope', 'x'), /没有这个引导主题/)
})

// ---------------------------------------------------------------- ③ 老状态文件要能升级
test('老格式（只有 完成于）→ 当成「视频源已完成」', () => {
  const { 引导, 目录 } = 造宿主()
  mkdirSync(目录, { recursive: true })
  writeFileSync(
    join(目录, 记录文件名),
    JSON.stringify({ 首次见: '2026-01-01T00:00:00.000Z', 完成于: '2026-01-02T00:00:00.000Z', 原因: '画面通了' }),
    'utf8',
  )

  assert.equal(引导.需要('source'), false, '老的完成状态要认')
  assert.equal(引导.需要('vision'), true, '新主题从「没做」开始')
  assert.equal(引导.需要('tts'), true)
  const 状态 = 引导.状态()
  assert.deepEqual(状态.主题.filter((t) => t.需要).map((t) => t.id), ['vision', 'tts'])
})

// ---------------------------------------------------------------- ④ 视频源校验
test('设置视频源：合法的存下来，不合法的当场抛', () => {
  const { 引导, 取配置 } = 造宿主()

  引导.设置源({ rtspUrl: '  rtsp://u:p@10.0.0.2:554/stream1  ' })
  assert.equal(取配置().rtspUrl, 'rtsp://u:p@10.0.0.2:554/stream1', '前后空格要去掉')

  引导.设置源({ videoDevice: '  HP Wide Vision HD Camera ' })
  assert.equal(取配置().videoDevice, 'HP Wide Vision HD Camera')

  引导.设置源({ rtspUrl: '' })
  assert.equal(取配置().rtspUrl, '')

  assert.throws(() => 引导.设置源({ rtspUrl: 'http://192.168.1.10/stream' }), /rtsp/i)
  assert.throws(() => 引导.设置源({ rtspUrl: '192.168.1.10:554' }), /rtsp/i)
  assert.throws(() => 引导.设置源({ rtspUrl: 'rtsp://admin: pa ss@10.0.0.2:554/x' }), /空格/)

  assert.equal(取配置().rtspUrl, '', '抛了就不能改坏原来的配置')
})

test('检查地址 / 脱敏：纯函数', () => {
  assert.equal(检查地址(''), '')
  assert.equal(检查地址(' rtsps://a:b@h:322/x '), 'rtsps://a:b@h:322/x')
  assert.throws(() => 检查地址('ftp://h/x'))

  assert.equal(脱敏('rtsp://admin:1c3589@192.168.31.202:554/md0_0'), 'rtsp://***@192.168.31.202:554/md0_0')
  assert.equal(脱敏('rtsp://192.168.1.5:554/x'), 'rtsp://192.168.1.5:554/x', '没凭据就原样返回')
  assert.equal(脱敏(''), '')

  const { 引导 } = 造宿主({ rtspUrl: 'rtsp://admin:1c3589@192.168.31.202:554/md0_0' })
  assert.equal(引导.状态().视频源.includes('1c3589'), false, '状态里泄露了密码')
})

// ---------------------------------------------------------------- ⑤ 文档
test('读文档：总览和每篇主题文档各读各的', () => {
  const { 引导 } = 造宿主()
  assert.match(引导.读总览(), /总览/)
  assert.match(引导.读主题文档('source'), /造的 source 文档/)
  assert.match(引导.读主题文档('tts'), /造的 tts 文档/)
  assert.equal(引导.读主题文档('nope'), '', '没有这个主题就给空串')
})

test('文档不在也不抛（调用方自己兜）', () => {
  const { 引导 } = 造宿主({}, { 文档: false })
  assert.equal(引导.读总览(), '')
  assert.equal(引导.读主题文档('vision'), '')
  assert.equal(引导.读文档(), '', '老接口也还在')
})
