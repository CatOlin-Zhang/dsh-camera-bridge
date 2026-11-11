// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 引导的**行为契约** —— 第一次装完，模型凭什么知道「RTSP 地址从哪儿拿」。
 *
 * 要守住的三件事：
 *   ① 没配通之前，提示词里**必须有**那段引导（不然模型只会瞎问或瞎编地址）；
 *   ② 一旦配通（出过画面 / 有人点了不用），提示词里**必须没有**（不白烧上下文）；
 *   ③ 视频源的校验是硬的：不是 rtsp:// 开头、带空格、地址里的密码要能盖掉。
 *
 * 全部用临时目录 + 假配置驱动真模块，不碰摄像头、不碰 ffmpeg。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { 建引导, 检查地址, 脱敏, 提示词全文, 记录文件名 } from '../lib/引导.js'

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
function 造宿主(初始配置 = {}) {
  const 目录 = mkdtempSync(join(tmpdir(), 'guide-test-'))
  临时目录.push(目录)

  let 配置 = { rtspUrl: '', videoDevice: '', micDevice: '', ...初始配置 }
  const 日志 = []

  const 引导 = 建引导({
    目录,
    文档路径: join(目录, '不存在的文档.md'),
    读配置: () => 配置,
    存配置(补丁) {
      配置 = { ...配置, ...补丁 }
      return 配置
    },
    记账: (m) => 日志.push(String(m)),
  })

  return { 引导, 目录, 日志, 取配置: () => 配置 }
}

// ---------------------------------------------------------------- ① 全新的插件
test('刚装完：需要引导，提示词里写着「地址从哪儿拿 / 没地址怎么找」', () => {
  const { 引导, 日志 } = 造宿主()

  assert.equal(引导.需要引导(), true)
  const 文 = 引导.提示词()
  assert.equal(文, 提示词全文)
  assert.match(文, /rtsp/i, '得说清要的是 RTSP 地址')
  assert.match(文, /Web 后台/, '得说地址从摄像头自己的后台拿')
  assert.match(文, /机身标签/, '得提机身标签（密码往往也在那儿）')
  assert.match(文, /search_devices|扫局域网/, '连 IP 都不知道时得说怎么找摄像头')
  assert.match(文, /不要在?自己编|不要自己编|别猜/, '得明确禁止编地址')
  assert.match(文, /camera_setup/, '得指向真正能干活的工具')

  // 下一步是按「现在什么都没填」推的
  assert.match(引导.状态().下一步, /电脑自带|本机/)
  assert.equal(日志.length, 0, '正常路径不该写日志')
})

// ---------------------------------------------------------------- ② 配通了就该消失
test('出过画面 = 配通了：引导自动结束，提示词变空', () => {
  const { 引导, 目录 } = 造宿主({ rtspUrl: 'rtsp://admin:secret@192.168.31.202:554/Streaming/Channels/101' })

  assert.equal(引导.需要引导(), true, '只是填了地址，还没证明能出画面')
  assert.equal(引导.出过画面(), true, '第一次出画面要返回 true（宿主用它记一笔）')
  assert.equal(引导.需要引导(), false)
  assert.equal(引导.提示词(), '', '配通之后不许再占提示词')
  assert.equal(引导.出过画面(), false, '幂等：已经结束就不算「刚出画面」')

  // 状态落盘了
  const 文件 = join(目录, 记录文件名)
  assert.ok(existsSync(文件), '状态得写进 引导.json')
  const 记录 = JSON.parse(readFileSync(文件, 'utf8'))
  assert.ok(记录.完成于, '完成时间要记下来')
  assert.match(String(记录.原因), /画面/, '原因得说清楚是「画面通了」')

  // 完成时间不会被后来的完成覆盖
  const 第一次 = 记录.完成于
  引导.完成('别的原因')
  assert.equal(JSON.parse(readFileSync(文件, 'utf8')).完成于, 第一次)
})

test('人说「不用了」也能结束；重置可以再来一次', () => {
  const { 引导 } = 造宿主()

  引导.完成('用户点了不用了')
  assert.equal(引导.需要引导(), false)
  assert.equal(引导.提示词(), '')
  assert.equal(引导.状态().完成原因, '用户点了不用了')

  引导.重置()
  assert.equal(引导.需要引导(), true)
  assert.equal(引导.提示词(), 提示词全文)
})

// ---------------------------------------------------------------- ③ 视频源校验
test('设置视频源：合法的存下来，不合法的当场抛', () => {
  const { 引导, 取配置 } = 造宿主()

  // 合法的 rtsp / rtsps 都收
  引导.设置源({ rtspUrl: '  rtsp://u:p@10.0.0.2:554/stream1  ' })
  assert.equal(取配置().rtspUrl, 'rtsp://u:p@10.0.0.2:554/stream1', '前后空格要去掉')

  // 本机设备名
  引导.设置源({ videoDevice: '  HP Wide Vision HD Camera ' })
  assert.equal(取配置().videoDevice, 'HP Wide Vision HD Camera')

  // 空串 = 清掉（回到「用本机摄像头」）
  引导.设置源({ rtspUrl: '' })
  assert.equal(取配置().rtspUrl, '')

  // 给的不是地址
  assert.throws(() => 引导.设置源({ rtspUrl: 'http://192.168.1.10/stream' }), /rtsp/i)
  assert.throws(() => 引导.设置源({ rtspUrl: '192.168.1.10:554' }), /rtsp/i)
  // 带空格（密码没转义 / 复制时带了空格）
  assert.throws(() => 引导.设置源({ rtspUrl: 'rtsp://admin: pa ss@10.0.0.2:554/x' }), /空格/)

  // 抛了就不能改坏原来的配置
  assert.equal(取配置().rtspUrl, '')
})

test('检查地址 / 脱敏：纯函数', () => {
  assert.equal(检查地址(''), '')
  assert.equal(检查地址(' rtsps://a:b@h:322/x '), 'rtsps://a:b@h:322/x')
  assert.throws(() => 检查地址('ftp://h/x'))

  // 面板和日志上不能出现密码
  assert.equal(脱敏('rtsp://admin:1c3589@192.168.31.202:554/md0_0'), 'rtsp://***@192.168.31.202:554/md0_0')
  assert.equal(脱敏('rtsp://192.168.1.5:554/x'), 'rtsp://192.168.1.5:554/x', '没凭据就原样返回')
  assert.equal(脱敏(''), '')

  // 状态里的「视频源」也不能带密码
  const { 引导 } = 造宿主({ rtspUrl: 'rtsp://admin:1c3589@192.168.31.202:554/md0_0' })
  assert.equal(引导.状态().视频源.includes('1c3589'), false, '状态里泄露了密码')
})

// ---------------------------------------------------------------- ④ 文档
test('读文档：文件不在就空串（调用方自己兜），别抛', () => {
  const { 引导 } = 造宿主()
  assert.equal(引导.读文档(), '', '文档不在不能抛异常把宿主带走')
})
