// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 帧差 —— 只回答「画面变没变」，不回答「画面里是什么」。
 *
 * 这一层是**代替声音**的廉价传感器：麦克风不保证收得到水开的咕嘟声，
 * 但摄像头一直有帧。所以「有没有事情发生」只能靠画面自己算。
 *
 * 约定（这些数字是契约，改它就要改这条测试）：
 *   · 两帧都是同一尺寸的灰度字节，32×32 是我们的取样尺寸
 *   · 单像素差 ≤ 像素阈 的，当噪声，不算「变了」
 *   · 变了的像素占比 ≥ 变化阈，才算「画面变了」
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  缩略宽,
  缩略高,
  缩略字节,
  默认像素阈,
  默认变化阈,
  帧差,
  判变化,
} from '../lib/帧差.js'

/** 造一帧灰度：底色 100，可选补丁 { 起点, 个数, 值 } */
function 造帧(补丁) {
  const 帧 = new Uint8Array(缩略字节).fill(100)
  if (补丁) 帧.fill(补丁.值, 补丁.起点, 补丁.起点 + 补丁.个数)
  return 帧
}

test('取样尺寸是 32×32', () => {
  assert.equal(缩略宽, 32)
  assert.equal(缩略高, 32)
  assert.equal(缩略字节, 1024)
  assert.equal(缩略宽 * 缩略高, 缩略字节)
})

test('同一帧：差为零，不算变', () => {
  const 甲 = 造帧()
  const 差 = 帧差(甲, 甲)
  assert.equal(差.变像素, 0)
  assert.equal(差.比例, 0)
  assert.equal(差.均值, 0)
  assert.equal(差.最大, 0)
  assert.equal(判变化(差), false)
})

test('传感器噪声（每像素 ±3）当没变', () => {
  const 甲 = new Uint8Array(缩略字节).fill(100)
  const 乙 = new Uint8Array(缩略字节)
  for (let i = 0; i < 缩略字节; i++) 乙[i] = 100 + (i % 7) - 3 // -3 … +3
  const 差 = 帧差(甲, 乙)
  assert.equal(差.变像素, 0)
  assert.equal(判变化(差), false)
  assert.ok(差.均值 > 0, '均值能看出抖，但判定不该被它带跑')
  assert.ok(差.最大 <= 3)
})

test('整幅变亮 20 级：算变', () => {
  const 甲 = new Uint8Array(缩略字节).fill(100)
  const 乙 = new Uint8Array(缩略字节).fill(120)
  const 差 = 帧差(甲, 乙)
  assert.equal(差.变像素, 缩略字节)
  assert.equal(差.比例, 1)
  assert.equal(差.均值, 20)
  assert.equal(判变化(差), true)
})

test('局部动了一块（100 像素 +60）：算变，比例按面积算', () => {
  const 甲 = 造帧()
  const 乙 = 造帧({ 起点: 400, 个数: 100, 值: 160 })
  const 差 = 帧差(甲, 乙)
  assert.equal(差.变像素, 100)
  assert.ok(Math.abs(差.比例 - 100 / 缩略字节) < 1e-12)
  assert.equal(差.最大, 60)
  assert.equal(判变化(差), true)
})

test('只动了几像素：不算变（不然一点抖动就触发看图）', () => {
  const 甲 = 造帧()
  const 乙 = 造帧({ 起点: 0, 个数: 10, 值: 180 })
  const 差 = 帧差(甲, 乙)
  assert.equal(差.变像素, 10)
  assert.equal(判变化(差), false)
})

test('阈值可以自己给', () => {
  const 甲 = 造帧()
  const 乙 = 造帧({ 起点: 0, 个数: 100, 值: 180 })
  const 差 = 帧差(甲, 乙)
  assert.equal(判变化(差, 0.05), true)
  assert.equal(判变化(差, 0.5), false)
})

test('两个默认阈值是正的，且尺度合理', () => {
  assert.ok(默认像素阈 >= 4 && 默认像素阈 <= 32, '像素阈太小=噪声也算变，太大=真动作看不见')
  assert.ok(默认变化阈 > 0 && 默认变化阈 <= 0.2, '变化阈是「多大面积动了」')
})

test('输入不对就抛，不猜', () => {
  assert.throws(() => 帧差(null, 造帧()), /字节/)
  assert.throws(() => 帧差(造帧(), undefined), /字节/)
  assert.throws(() => 帧差(new Uint8Array(0), new Uint8Array(0)), /空/)
  assert.throws(() => 帧差(new Uint8Array(64), new Uint8Array(32)), /长度/)
})

test('不挑容器：Buffer 和 Uint8Array 混着用也行', () => {
  const 甲 = Buffer.from(造帧())
  const 乙 = 造帧({ 起点: 900, 个数: 64, 值: 200 })
  const 差 = 帧差(甲, 乙)
  assert.equal(差.变像素, 64)
})

test('不改输入、结果可重复', () => {
  const 甲 = 造帧({ 起点: 10, 个数: 40, 值: 50 })
  const 乙 = 造帧({ 起点: 20, 个数: 40, 值: 200 })
  const 甲副本 = Uint8Array.from(甲)
  const 乙副本 = Uint8Array.from(乙)
  const 一 = 帧差(甲, 乙)
  const 二 = 帧差(甲, 乙)
  assert.deepEqual(一, 二)
  assert.deepEqual(甲, 甲副本)
  assert.deepEqual(乙, 乙副本)
})
