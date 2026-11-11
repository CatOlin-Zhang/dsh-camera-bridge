// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 帧差 —— 只回答「画面变没变」，不回答「画面里是什么」
 * ==========================================================================
 * 为什么要这一层：
 *
 *   做饭这件事真正需要的信号是「有没有新事情发生」。以前的想法是靠声音
 *   （水开了会咕嘟、油热了会滋啦），但麦克风不保证收得到 —— 抽油烟机一开、
 *   锅离得远一点，就什么都听不见。把判断建在声音上，等于建在运气上。
 *
 *   摄像头不一样：帧一直在。所以「有没有变化」只能从画面上算，而且必须**便宜** ——
 *   每帧只读 32×32 个灰度字节，不跑模型、不解码整张图、不吃 GPU。
 *
 * 这一层只做一件事：把两帧压成几个数，让人能用一个阈值问「算不算变了」。
 * 它不认识锅、不认识人 —— 认东西是 YOLO 的事，这里只报「动了」。
 *
 * 取样为什么是 32×32：
 *   1024 个字节，一帧的差算下来是微秒级；缩到这个尺寸，锅盖掀一下也还盖得住
 *   大半个画面，但相机噪点会被平均掉一部分。
 */

/** 取样宽（像素） */
export const 缩略宽 = 32
/** 取样高（像素） */
export const 缩略高 = 32
/** 一帧取样有多少字节 */
export const 缩略字节 = 缩略宽 * 缩略高

/**
 * 单像素差多少才承认「这个像素变了」。
 * 8 级以下是 CMOS 噪声和自动曝光的正常抖动 —— 常量补光下实测过，同一面墙相邻两帧会飘 2–5 级。
 */
export const 默认像素阈 = 8

/**
 * 变了的像素占到多少比例才算「画面变了」。
 * 2% ≈ 1024 里的 20 个像素：够挡住噪点，又够看见一只手伸进画面。
 */
export const 默认变化阈 = 0.02

function 检查帧(帧, 名) {
  const 像字节 = 帧 && (帧 instanceof Uint8Array || ArrayBuffer.isView(帧)) && typeof 帧.length === 'number'
  if (!像字节) throw new TypeError(名 + ' 不是字节数组（要 Uint8Array / Buffer）')
  if (帧.length === 0) throw new RangeError(名 + ' 是空帧，没法比')
}

/**
 * 比两帧，得出「差多少」。
 * @param {Uint8Array|Buffer} 甲 上一帧
 * @param {Uint8Array|Buffer} 乙 这一帧
 * @param {{像素阈?: number}} [选项]
 * @returns {{变像素: number, 比例: number, 均值: number, 最大: number}}
 */
export function 帧差(甲, 乙, 选项 = {}) {
  检查帧(甲, '甲')
  检查帧(乙, '乙')
  if (甲.length !== 乙.length) {
    throw new RangeError('两帧长度不一样：' + 甲.length + ' vs ' + 乙.length)
  }
  const 像素阈 = Number(选项.像素阈 ?? 默认像素阈)

  let 变像素 = 0
  let 和 = 0
  let 最大 = 0
  for (let i = 0; i < 甲.length; i++) {
    const d = 甲[i] > 乙[i] ? 甲[i] - 乙[i] : 乙[i] - 甲[i]
    和 += d
    if (d > 最大) 最大 = d
    if (d > 像素阈) 变像素++
  }
  return { 变像素, 比例: 变像素 / 甲.length, 均值: 和 / 甲.length, 最大 }
}

/**
 * 差得够不够「算变了」。
 * @param {{比例: number}} 差
 * @param {number} [阈] 变了多大面积才算，默认 {@link 默认变化阈}
 */
export function 判变化(差, 阈 = 默认变化阈) {
  const 比例 = Number(差 && 差.比例)
  if (!Number.isFinite(比例)) throw new TypeError('判变化 要一个 帧差() 的结果')
  const 线 = Number(阈)
  if (!Number.isFinite(线)) throw new TypeError('阈值得是个数')
  return 比例 >= 线
}
