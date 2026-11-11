// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 阿根达斯 · dsh-camera-bridge

/**
 * 摄像头桥 · 网页半边（右下角那张小卡片）
 * ==========================================================================
 * 只做三件事：把「听没在听 / 听到了什么 / 这一轮各段花了多久」摆出来，
 * 外加开始、停止、选会话。真正的活都在宿主那边。
 */
window.__ModuleLoader__.load({
  id: 'dsh-camera-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const API = '/api/camera-bridge'
    const POS_KEY = 'camera-bridge-card-pos'

    const C = {
      panel: 'var(--dsw-alias-bg-overlay)',
      line: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      bad: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    async function 取(路径, 选项) {
      const r = await fetch(API + 路径, 选项)
      return r.json()
    }

    function 毫秒(n) {
      if (n === undefined || n === null) return '—'
      return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms'
    }

    function 时刻(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }

    /** 出错兜底：组件崩了也要留一块能看见的牌子，而不是整块消失 */
    class 兜底 extends React.Component {
      constructor(props) {
        super(props)
        this.state = { 错: null }
      }
      static getDerivedStateFromError(error) {
        return { 错: String((error && error.message) || error) }
      }
      render() {
        if (this.state.错) {
          return h('div', {
            style: {
              position: 'fixed', right: 16, bottom: 16, zIndex: 9999, maxWidth: 320,
              padding: '8px 12px', borderRadius: 10, font: '12px/1.5 system-ui, sans-serif',
              background: C.panel, color: C.bad, border: '1px solid ' + C.bad,
            },
          }, '🐟 摄像头桥出错了：' + this.state.错)
        }
        return this.props.children
      }
    }

    function 卡片() {
      const [快照, 设快照] = useState(null)
      const [错, 设错] = useState('')
      const [忙, 设忙] = useState('')
      const [展, 设展] = useState(false)
      const [流地址, 设流地址] = useState('')
      const 视频在 = !!(快照 && 快照.video && 快照.video.on)
      const 眼睛在 = !!(快照 && 快照.look && 快照.look.on)
      const 盯着在 = !!(快照 && 快照.watch && 快照.watch.on)
      const 阶段 = (快照 && 快照.watch && 快照.watch.阶段) || ''
      const 认出 = (快照 && 快照.look && 快照.look.摘要) || ''

      // 流地址只在「开画面」那一下生成一次 —— 每次轮询都换 src 会把 MJPEG 连接反复掐断
      useEffect(() => {
        if (视频在) {
          if (!流地址) 设流地址(API + '/mjpeg?t=' + Date.now())
        } else if (流地址) 设流地址('')
      }, [视频在])
      const [位置, 设位置] = useState(() => {
        try {
          const s = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
          // ⚠ 位置记在浏览器里。窗口变小、或卡片被拖到屏幕外之后再打开，
          //   它会「存在但看不见」—— 所以记下来的位置必须夹回可视区。
          if (s && typeof s.x === 'number' && typeof s.y === 'number') {
            const x = Math.max(8, Math.min(Math.max(8, window.innerWidth - 330), s.x))
            const y = Math.max(8, Math.min(Math.max(8, window.innerHeight - 90), s.y))
            return { x, y }
          }
        } catch {}
        return null
      })
      const 拖 = useRef(null)
      const 位置引用 = useRef(位置)
      位置引用.current = 位置

      // 轮询状态
      useEffect(() => {
        let 活 = true
        let 定时 = null
        const 拉 = async () => {
          try {
            const j = await 取('/state')
            if (!活) return
            if (j && j.ok) {
              设快照(j)
              设错('')
            } else 设错(String((j && j.error) || '宿主没回话'))
          } catch (e) {
            if (活) 设错('连不上宿主：' + String((e && e.message) || e))
          }
        }
        拉()
        定时 = setInterval(拉, 700)
        return () => {
          活 = false
          if (定时) clearInterval(定时)
        }
      }, [])

      const 开始 = useCallback(async () => {
        设忙('start')
        try {
          const j = await 取('/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (!j.ok) 设错(String(j.原因 || '起不来'))
        } catch (e) {
          设错(String((e && e.message) || e))
        } finally {
          设忙('')
        }
      }, [])

      const 停 = useCallback(async () => {
        设忙('stop')
        try {
          await 取('/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        } catch (e) {
          设错(String((e && e.message) || e))
        } finally {
          设忙('')
        }
      }, [])

      const 换会话 = useCallback(async (id) => {
        try {
          await 取('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targetSession: id }),
          })
        } catch (e) {
          设错(String((e && e.message) || e))
        }
      }, [])

      const 画面开关 = useCallback(async () => {
        设忙('video')
        try {
          const 路 = 视频在 ? '/video/stop' : '/video/start'
          const j = await 取(路, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (j && j.ok === false) 设错(String(j.原因 || '画面起不来'))
        } catch (e) {
          设错(String((e && e.message) || e))
        } finally {
          设忙('')
        }
      }, [视频在])

      const 眼睛开关 = useCallback(async () => {
        设忙('look')
        try {
          const 路 = 眼睛在 ? '/look/stop' : '/look/start'
          const j = await 取(路, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (j && j.ok === false) 设错(String(j.原因 || '眼睛起不来'))
        } catch (e) {
          设错(String((e && e.message) || e))
        } finally {
          设忙('')
        }
      }, [眼睛在])

      const 盯着开关 = useCallback(async () => {
        设忙('watch')
        try {
          const 路 = 盯着在 ? '/watch/stop' : '/watch/start'
          const j = await 取(路, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          if (j && j.ok === false) 设错(String(j.原因 || '盯不住'))
        } catch (e) {
          设错(String((e && e.message) || e))
        } finally {
          设忙('')
        }
      }, [盯着在])

      // 设置页那个「把小窗叫回来」按的
      useEffect(() => {
        const 回 = () => {
          try {
            localStorage.removeItem(POS_KEY)
          } catch {}
          设位置(null)
        }
        window.addEventListener('camera-bridge-reset', 回)
        return () => window.removeEventListener('camera-bridge-reset', 回)
      }, [])

      // 拖动
      useEffect(() => {
        const 动 = (e) => {
          const d = 拖.current
          if (!d) return
          const 宽 = 320
          const x = Math.max(8, Math.min(window.innerWidth - 宽 - 8, e.clientX - d.dx))
          const y = Math.max(8, Math.min(window.innerHeight - 60, e.clientY - d.dy))
          设位置({ x, y })
        }
        const 放 = () => {
          if (!拖.current) return
          拖.current = null
          document.body.style.userSelect = ''
          try {
            const p = 位置引用.current
            if (p) localStorage.setItem(POS_KEY, JSON.stringify(p))
          } catch {}
        }
        window.addEventListener('pointermove', 动)
        window.addEventListener('pointerup', 放)
        return () => {
          window.removeEventListener('pointermove', 动)
          window.removeEventListener('pointerup', 放)
        }
      }, [])

      const 按 = (e) => {
        if (e.target && e.target.closest && e.target.closest('button,select')) return
        const r = e.currentTarget.getBoundingClientRect()
        拖.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
        try {
          document.body.style.userSelect = 'none'
        } catch {}
        if (!位置) 设位置({ x: r.left, y: r.top })
        e.preventDefault()
      }

      const 听 = !!(快照 && 快照.listening)
      const vad = (快照 && 快照.vad) || 'idle'
      const 电平 = (快照 && 快照.level) || 0
      const 上一轮 = 快照 && 快照.timing && 快照.timing[0]
      const 会话们 = (快照 && 快照.sessions) || []
      const 当前会话 = (快照 && 快照.config && 快照.config.targetSession) || ''

      const 状态文 = !听
        ? '待命'
        : vad === 'suppress'
          ? '它在念，先不听'
          : vad === 'speech'
            ? '正在听你说…'
            : '在听'

      const 状态色 = !听 ? C.idle : vad === 'suppress' ? C.warn : C.ok

      const 底 = 位置 ? { left: 位置.x, top: 位置.y } : { right: 16, bottom: 16 }

      return h('div', {
        style: {
          position: 'fixed',
          ...底,
          width: 316,
          zIndex: 999999,
          borderRadius: 14,
          border: '1px solid ' + C.line,
          background: C.panel,
          boxShadow: '0 10px 30px rgba(0,0,0,.18)',
          color: C.text,
          font: '12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          overflow: 'hidden',
          backdropFilter: 'blur(8px)',
        },
      },
        // 头（可拖）
        h('div', {
          onPointerDown: 按,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'grab', borderBottom: '1px solid ' + C.line },
        },
          h('span', { style: { fontSize: 14 } }, '🎥'),
          h('span', { style: { fontWeight: 600, letterSpacing: 0.2 } }, '摄像头桥'),
          h('span', { style: { flex: 1 } }),
          h('span', {
            title: 状态文,
            style: { width: 8, height: 8, borderRadius: 999, background: 状态色, boxShadow: '0 0 0 3px ' + 状态色 + '22' },
          }),
          h('button', {
            onClick: 盯着开关,
            disabled: 忙 !== '',
            title: 盯着在 ? '不看了' : '盯着看：自己判阶段，出事才开口',
            style: { border: 'none', background: 'transparent', color: 盯着在 ? C.brand : C.dim, cursor: 'pointer', fontSize: 12, padding: '0 2px', fontWeight: 盯着在 ? 600 : 400 },
          }, 盯着在 ? '👀 盯着' : '👀'),
          h('button', {
            onClick: 眼睛开关,
            disabled: 忙 !== '',
            title: 眼睛在 ? '关掉持续识别' : '一直盯着认东西（YOLO-World）',
            style: { border: 'none', background: 'transparent', color: 眼睛在 ? C.brand : C.dim, cursor: 'pointer', fontSize: 12, padding: '0 2px' },
          }, 眼睛在 ? '👁 开' : '👁 关'),
          h('button', {
            onClick: 画面开关,
            disabled: 忙 !== '',
            title: 视频在 ? '关掉画面' : '打开摄像头画面',
            style: { border: 'none', background: 'transparent', color: 视频在 ? C.brand : C.dim, cursor: 'pointer', fontSize: 12, padding: '0 2px' },
          }, 视频在 ? '📷 开' : '📷 关'),
          h('button', {
            onClick: () => 设展(!展),
            title: 展 ? '收起' : '详情',
            style: { border: 'none', background: 'transparent', color: C.dim, cursor: 'pointer', fontSize: 12, padding: '0 2px' },
          }, 展 ? '收起' : '详情'),
        ),

        // 身体
        h('div', { style: { padding: '9px 10px 10px' } },
          // 画面（开着才显示）
          视频在 && 流地址
            ? h('div', {
                style: {
                  marginBottom: 8,
                  borderRadius: 8,
                  overflow: 'hidden',
                  background: '#000',
                  border: '1px solid ' + C.line,
                  lineHeight: 0,
                },
              },
                h('img', {
                  src: 流地址,
                  alt: '摄像头画面',
                  style: { width: '100%', maxHeight: 展 ? 240 : 150, objectFit: 'cover', display: 'block' },
                }),
              )
            : null,
          (快照 && 快照.video && 快照.video.error)
            ? h('div', { style: { marginBottom: 6, color: C.bad, fontSize: 11, wordBreak: 'break-all' } }, 快照.video.error)
            : null,
          (眼睛在 && 认出)
            ? h('div', { style: { marginBottom: 6, color: C.dim, fontSize: 11 } },
                '认出来：' + 认出 + (快照.look.毫秒 ? '（' + 快照.look.毫秒 + 'ms）' : ''),
              )
            : null,
          (盯着在 && 阶段)
            ? h('div', { style: { marginBottom: 6, fontSize: 11 } },
                h('span', { style: { color: C.dim } }, '阶段：'),
                h('b', { style: { color: 阶段 === '冒烟' ? C.warn : C.text } }, 阶段),
                h('span', { style: { color: C.dim } }, 快照.watch.依据 ? '（' + 快照.watch.依据 + '）' : ''),
                h('span', { style: { color: C.dim } }, 快照.watch.开口数 ? '　已开口 ' + 快照.watch.开口数 + ' 次' : ''),
              )
            : null,
          (快照 && 快照.look && 快照.look.准备)
            ? h('div', { style: { marginBottom: 6, color: C.warn, fontSize: 11, wordBreak: 'break-all' } }, 快照.look.准备)
            : null,
          (快照 && 快照.look && 快照.look.错误)
            ? h('div', { style: { marginBottom: 6, color: C.bad, fontSize: 11, wordBreak: 'break-all' } }, 快照.look.错误)
            : null,
          // 电平
          h('div', {
            style: { height: 4, borderRadius: 999, background: C.line, overflow: 'hidden', marginBottom: 8 },
          }, h('div', {
            style: {
              height: '100%',
              width: Math.min(100, Math.round(电平 * 100)) + '%',
              background: vad === 'speech' ? C.ok : C.brand,
              transition: 'width .08s linear',
            },
          })),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', { style: { color: 状态色, fontWeight: 600 } }, 状态文),
            h('span', { style: { flex: 1 } }),
            h('button', {
              onClick: 听 ? 停 : 开始,
              disabled: 忙 !== '',
              style: {
                border: '1px solid ' + C.line,
                background: 听 ? 'transparent' : C.brand,
                color: 听 ? C.text : '#fff',
                borderRadius: 8,
                padding: '3px 10px',
                cursor: 'pointer',
                font: 'inherit',
              },
            }, 忙 === 'start' ? '启动中…' : 听 ? '停止' : '开始听'),
          ),

          // 上一句
          h('div', { style: { marginTop: 8, minHeight: 34 } },
            h('div', { style: { color: C.dim, fontSize: 11 } }, 快照 && 快照.lastAt ? '刚才听到（' + 时刻(快照.lastAt) + '）' : '还没听到话'),
            h('div', { style: { fontWeight: 500, wordBreak: 'break-all' } }, (快照 && 快照.lastText) || '——'),
          ),

          // 上一轮耗时
          h('div', {
            style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed ' + C.line, color: C.dim, fontSize: 11 },
          },
            上一轮
              ? h('span', null,
                  '上一轮 ',
                  h('b', { style: { color: C.text } }, 毫秒(上一轮.总毫秒)),
                  ' ＝ 判停 ' + 毫秒(上一轮.判停毫秒) + ' ＋ 转写 ' + 毫秒(上一轮.转写毫秒) + ' ＋ 送达 ' + 毫秒(上一轮.送达毫秒),
                )
              : '还没有一轮记录',
          ),

          // 错误
          (错 || (快照 && 快照.error))
            ? h('div', { style: { marginTop: 6, color: C.bad, fontSize: 11, wordBreak: 'break-all' } }, 错 || 快照.error)
            : null,

          // 详情
          展
            ? h('div', { style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid ' + C.line } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
                  h('span', { style: { color: C.dim } }, '送到'),
                  h('select', {
                    value: 当前会话,
                    onChange: (e) => 换会话(e.target.value),
                    style: {
                      flex: 1,
                      minWidth: 0,
                      background: 'transparent',
                      color: C.text,
                      border: '1px solid ' + C.line,
                      borderRadius: 6,
                      padding: '2px 4px',
                      font: 'inherit',
                    },
                  },
                    h('option', { value: '' }, '（还没选会话）'),
                    会话们.map((s) => h('option', { key: s.id, value: s.id }, s.标题)),
                  ),
                ),
                h('div', { style: { color: C.dim, fontSize: 11, marginBottom: 4 } },
                  '麦克风：' + ((快照 && 快照.device) || '—') + (快照 && 快照.asrReady ? '　·　转写就绪' : '　·　转写未就绪'),
                ),
                h('div', { style: { color: C.dim, fontSize: 11, marginBottom: 6 } },
                  '模型：' + ((快照 && 快照.modelDir) || '—'),
                ),
                // 挂在这个摄像头下面的模块（做饭…）—— 点得进设置页配
                (快照 && 快照.modules && 快照.modules.length)
                  ? h('div', {
                      style: { color: C.dim, fontSize: 11, marginBottom: 6, wordBreak: 'break-all' },
                      title: '在「设置 → 摄像头桥 → 挂载的服务」里配置',
                    },
                      '挂载：' + 快照.modules
                        .map((m) => String(m.名 || m.id) + (m.状态 && m.状态.已启用 ? ' ●' : ' ○'))
                        .join('　'),
                    )
                  : null,
                (快照 && 快照.timing && 快照.timing.length)
                  ? h('div', null,
                      h('div', { style: { color: C.dim, fontSize: 11, marginBottom: 4 } }, '最近几轮'),
                      h('div', { style: { maxHeight: 150, overflow: 'auto' } },
                        快照.timing.slice(0, 6).map((t, i) => h('div', {
                          key: i,
                          style: { display: 'flex', gap: 6, padding: '2px 0', borderBottom: '1px solid ' + C.line },
                        },
                          h('span', { style: { color: t.结果 && t.结果 !== '已送出' ? C.warn : C.ok, width: 14 } }, t.结果 === '已送出' ? '✓' : '!'),
                          h('span', {
                            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                            title: t.文本 || '',
                          }, t.文本 || '（空）'),
                          h('span', { style: { color: C.dim } }, 毫秒(t.总毫秒)),
                        )),
                      ),
                    )
                  : null,
                (快照 && 快照.diag && 快照.diag.length)
                  ? h('details', { style: { marginTop: 8 } },
                      h('summary', { style: { color: C.dim, fontSize: 11, cursor: 'pointer' } }, '日志'),
                      h('div', { style: { maxHeight: 120, overflow: 'auto', color: C.dim, fontSize: 11, marginTop: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
                        快照.diag.map((d, i) => h('div', { key: i }, 时刻(d.at) + ' ' + d.message)),
                      ),
                    )
                  : null,
              )
            : null,
        ),
      )
    }

    /** 设置 → 摄像头桥：卡片找不到的时候从这里进 */
    function 设置页() {
      const [快照, 设快照] = useState(null)
      const [设备, 设设备] = useState([])
      const [视频设备, 设视频设备] = useState([])
      const [表, 设表] = useState(null)
      const [存状, 设存状] = useState('')
      // 挂载模块那块的临时状态
      const [模块忙, 设模块忙] = useState('')
      const [模块说, 设模块说] = useState(null)
      // 自检结果
      const [自检, 设自检] = useState(null)
      const [自检忙, 设自检忙] = useState(false)

      useEffect(() => {
        let 活 = true
        const 拉 = async () => {
          try {
            const j = await 取('/state')
            if (!活 || !j || !j.ok) return
            设快照(j)
            设表((前) => 前 || { ...j.config })
          } catch {}
        }
        拉()
        const 时 = setInterval(拉, 1500)
        return () => {
          活 = false
          clearInterval(时)
        }
      }, [])

      useEffect(() => {
        let 活 = true
        取('/devices')
          .then((j) => {
            if (活 && j && j.ok) {
              设设备(j.audio || [])
              设视频设备(j.video || [])
            }
          })
          .catch(() => {})
        return () => {
          活 = false
        }
      }, [])

      const 改 = (k) => (e) => {
        const v = e && e.target ? e.target.value : e
        设表((前) => ({ ...(前 || {}), [k]: v }))
      }

      const 动作 = async (路) => {
        try {
          await 取(路, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        } catch (e) {
          设存状(String((e && e.message) || e))
        }
      }

      const 存 = async () => {
        if (!表) return
        设存状('保存中…')
        try {
          const j = await 取('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(表),
          })
          设存状(j && j.ok ? '已保存 ✓' : '保存失败')
        } catch (e) {
          设存状('保存失败：' + String((e && e.message) || e))
        }
        setTimeout(() => 设存状(''), 2500)
      }

      /** 改一个配置字段：立刻进本地表 + 立刻存盘（模块的开关/数字不需要再点「保存」） */
      const 存字段 = async (键, 值) => {
        设表((前) => ({ ...(前 || {}), [键]: 值 }))
        try {
          await 取('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [键]: 值 }),
          })
        } catch (e) {
          设存状('保存失败：' + String((e && e.message) || e))
        }
      }

      /** 引导：结束（不用了）/ 重开（再看一次）。topic 不传 = 全部主题 */
      const 引导动作 = async (动作, 说明, topic) => {
        try {
          await 取('/guide', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 动作, 说明: 说明 || '', topic: topic || '' }),
          })
        } catch (e) {
          设存状('引导操作失败：' + String((e && e.message) || e))
        }
      }

      /** 跑一次自检：缺什么、能不能跑 */
      const 跑自检 = async () => {        设自检忙(true)
        try {
          const j = await 取('/selfcheck')
          设自检(j && j.ok ? j : { ok: false, 缺: [{ 项: '自检失败', 说明: '宿主没回话' }] })
        } catch (e) {
          设自检({ ok: false, 缺: [{ 项: '连不上宿主', 说明: String((e && e.message) || e) }] })
        } finally {
          设自检忙(false)
        }
      }

      /** 模块上的按钮（目前只有「做饭 · 开始做」这一种） */
      const 模块动作 = async (m, 动作) => {
        设模块忙(m.id)
        设模块说(null)
        try {
          if (m.id === 'cook' && 动作 === '开始做') {
            const 菜 = String((表 && 表.cookDish) || '').trim()
            const j = await 取('/modules/cook/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ 菜 }),
            })
            if (j && j.ok) {
              设模块说({ id: m.id, 文本: '「' + 菜 + '」交给会话了，等它把菜谱导进来。', 错: false })
            } else {
              设模块说({ id: m.id, 文本: String((j && (j.原因 || j.error)) || '没成'), 错: true })
            }
          }
        } catch (e) {
          设模块说({ id: m.id, 文本: '出错：' + String((e && e.message) || e), 错: true })
        } finally {
          设模块忙('')
        }
      }

      const 听 = !!(快照 && 快照.listening)
      const 画面 = !!(快照 && 快照.video && 快照.video.on)
      const 盯 = !!(快照 && 快照.watch && 快照.watch.on)
      const 阶段 = (快照 && 快照.watch && 快照.watch.阶段) || '—'
      const 认出 = (快照 && 快照.look && 快照.look.摘要) || '—'
      const 上一轮 = 快照 && 快照.timing && 快照.timing[0]
      const 模块们 = (快照 && 快照.modules) || []

      const 框 = {
        width: '100%',
        boxSizing: 'border-box',
        background: 'transparent',
        color: C.text,
        border: '1px solid ' + C.line,
        borderRadius: 8,
        padding: '6px 8px',
        font: 'inherit',
      }
      const 键 = {
        border: '1px solid ' + C.line,
        background: 'transparent',
        color: C.text,
        borderRadius: 8,
        padding: '5px 12px',
        cursor: 'pointer',
        font: 'inherit',
      }
      const 行 = (标签, 控件, 说明) =>
        h('div', {
          style: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid ' + C.line },
        },
          h('div', { style: { width: 104, flexShrink: 0, color: C.dim, paddingTop: 6 } }, 标签),
          h('div', { style: { flex: 1, minWidth: 0 } },
            控件,
            说明 ? h('div', { style: { color: C.dim, fontSize: 11, marginTop: 4 } }, 说明) : null,
          ),
        )

      return h('div', {
        style: {
          padding: '18px 20px',
          maxWidth: 720,
          color: C.text,
          font: '13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        },
      },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } },
          '🎥 摄像头桥',
          (快照 && 快照.release && 快照.release.stage === 'pre')
            ? h('span', {
                style: {
                  marginLeft: 8,
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '1px 7px',
                  borderRadius: 999,
                  color: C.warn,
                  border: '1px solid ' + C.warn,
                  verticalAlign: 'middle',
                },
                title: '预发布版：能用，但功能、配置键、接口都可能随版本变化',
              }, '预发布 ' + String(快照.release.version || ''))
            : null,
        ),
        h('div', { style: { color: C.dim, fontSize: 12, marginBottom: 14 } },
          '麦克风当耳朵、摄像头当眼睛。说完自动送进会话，回话由朗读桥念。'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
          h('span', { style: { color: 听 ? C.ok : C.idle } }, 听 ? '● 在听' : '○ 没在听'),
          h('span', { style: { color: 画面 ? C.ok : C.idle } }, 画面 ? '● 画面开着' : '○ 画面关着'),
          h('span', { style: { color: 盯 ? C.brand : C.idle } }, 盯 ? '● 盯着（' + 阶段 + '）' : '○ 没盯着'),
          h('span', { style: { color: C.dim } }, '认出：' + 认出),
        ),
        (快照 && 快照.error) ? h('div', { style: { color: C.bad, fontSize: 12, marginBottom: 8 } }, 快照.error) : null,

        // ---------------------------------------------------------- 第一次的引导
        // 三个主题各自独立：视频源 / 视觉方案 / 朗读。做完一个撤一个，全撤完这块就消失。
        (快照 && 快照.引导 && 快照.引导.需要引导)
          ? h('div', {
              style: {
                border: '1px solid ' + C.warn,
                borderRadius: 10,
                padding: '10px 12px',
                margin: '4px 0 12px',
                fontSize: 12,
                lineHeight: 1.7,
              },
            },
              h('div', { style: { color: C.warn, fontWeight: 600, marginBottom: 4 } },
                '👋 第一次用，先把这几件事定下来'),
              ((快照.引导.主题 || []).filter((t) => t.需要)).map((t) =>
                h('div', { key: t.id, style: { padding: '6px 0', borderTop: '1px solid ' + C.line } },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
                    h('span', { style: { fontWeight: 600, flex: 1, minWidth: 0 } }, String(t.标题 || t.id)),
                    h('button', {
                      style: { ...键, padding: '2px 8px', fontSize: 11 },
                      title: '这件事清楚了，把这段从提示词里撤掉',
                      onClick: () => 引导动作('done', '用户在设置页点了「了解了」', t.id),
                    }, '了解了'),
                  ),
                  h('div', { style: { color: C.dim, marginTop: 2 } }, String(t.摘要 || '')),
                  h('div', {
                    style: { color: C.dim, fontSize: 11, marginTop: 2, wordBreak: 'break-all' },
                  }, '说明：' + String(t.文档 || '')),
                ),
              ),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
                h('button', {
                  style: 键,
                  title: '三条都不看了（随时可以点「再看一次引导」回来）',
                  onClick: () => 引导动作('done', '用户在设置页点了「全部不用引导」'),
                }, '全部不用了'),
                h('span', { style: { color: C.dim, fontSize: 11 } },
                  '只影响提示词，不影响功能；能出画面时「视频源」那条会自动结束'),
              ),
            )
          : null,

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 16px' } },
          h('button', { style: 键, onClick: () => 动作(听 ? '/stop' : '/start') }, 听 ? '停止听' : '开始听'),
          h('button', { style: 键, onClick: () => 动作(画面 ? '/video/stop' : '/video/start') }, 画面 ? '关画面' : '开画面'),
          h('button', { style: 键, onClick: () => 动作(盯 ? '/watch/stop' : '/watch/start') }, 盯 ? '不看了' : '盯着看'),
          h('button', { style: 键, onClick: () => window.open(API + '/snapshot?t=' + Date.now(), '_blank') }, '拍一张'),
          h('button', {
            style: 键,
            title: '把右下角那张卡片叫回默认位置',
            onClick: () => {
              try {
                localStorage.removeItem('camera-bridge-card-pos')
              } catch {}
              window.dispatchEvent(new Event('camera-bridge-reset'))
            },
          }, '把小窗叫回来'),
        ),

        h('div', { style: { fontSize: 13, fontWeight: 600, margin: '6px 0 2px' } }, '配置'),
        行('送到', h('select', { style: 框, value: (表 && 表.targetSession) || '', onChange: 改('targetSession') },
          h('option', { value: '' }, '（还没选）'),
          ((快照 && 快照.sessions) || []).map((s) => h('option', { key: s.id, value: s.id }, s.标题)),
        ), '语音识别出来的话，当作你说的送进这个会话'),
        行('麦克风', h('select', { style: 框, value: (表 && 表.micDevice) || '', onChange: 改('micDevice') },
          h('option', { value: '' }, '自动挑'),
          设备.map((d) => h('option', { key: d, value: d }, d)),
        ), '留空 = 自动挑一个像真麦克风的（会跳过虚拟声卡）'),
        行('摄像头', h('select', { style: 框, value: (表 && 表.videoDevice) || '', onChange: 改('videoDevice') },
          h('option', { value: '' }, '自动挑'),
          视频设备.map((d) => h('option', { key: d, value: d }, d)),
        ), '留空 = 自动挑名字里带「摄像头 / camera / webcam」的；填了 RTSP 地址时这里不生效'),
        行('ffmpeg 路径', h('input', {
          style: 框,
          value: (表 && 表.ffmpegPath) || '',
          placeholder: '留空 = 自动找，找不到就用 PATH 里的 ffmpeg',
          onChange: 改('ffmpegPath'),
        }), '用来抓麦克风和解视频流。装了 ffmpeg 并加进 PATH 的话可以留空'),
        行('python 路径', h('input', {
          style: 框,
          value: (表 && 表.pythonPath) || '',
          placeholder: '留空 = 自动找，找不到就用 PATH 里的 python/python3',
          onChange: 改('pythonPath'),
        }), '是「眼睛」和「耳朵」用的解释器，需装 sherpa-onnx / ultralytics'),
        行('RTSP 地址', h('input', {
          style: 框,
          value: (表 && 表.rtspUrl) || '',
          placeholder: 'rtsp://user:pass@192.168.1.x:554/...（留空 = 用本机摄像头）',
          onChange: 改('rtspUrl'),
        }), '只有网络摄像头才要：从摄像头 Web 后台、厂商 App 或机身标签上抄。拿不到就问会话里的模型「帮我配摄像头」'),
        行('静音判停', h('input', {
          style: 框,
          type: 'number',
          value: (表 && 表.silenceMs) || 600,
          onChange: 改('silenceMs'),
        }), '毫秒。调小更快，但容易被停顿切断'),
        行('识别词表', h('textarea', {
          style: { ...框, minHeight: 62, resize: 'vertical' },
          value: (表 && 表.lookClasses) || '',
          onChange: 改('lookClasses'),
        }), '英文逗号分隔，写英文（CLIP 对中文会飘）'),

        // ---------------------------------------------------------- 挂载的服务
        h('div', { style: { fontSize: 14, fontWeight: 600, margin: '22px 0 4px' } }, '挂载的服务'),
        h('div', { style: { color: C.dim, fontSize: 11.5, marginBottom: 10 } },
          '这些模块长在摄像头桥下面：共用同一个摄像头和识别结果，各自决定「认出来之后干什么」。' +
          '以后加新模块（比如盯着猫），这里会自动多一张卡片。'),
        模块们.length === 0
          ? h('div', { style: { color: C.dim, fontSize: 12, padding: '8px 0' } }, '（还没有模块挂上来）')
          : 模块们.map((m) => {
              const 态 = m.状态 || {}
              const 忙这个 = 模块忙 === m.id
              return h('div', {
                key: m.id,
                style: {
                  border: '1px solid ' + C.line,
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 10,
                },
              },
                // 标题行
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
                  h('span', { style: { fontSize: 13, fontWeight: 600 } }, String(m.名 || m.id)),
                  h('span', {
                    style: { color: 态.已启用 ? C.ok : C.idle, fontSize: 11.5 },
                  }, 态.已启用 ? '● 在盯着' : '○ 没盯'),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: { color: C.dim, fontSize: 11 } }, 'id: ' + String(m.id)),
                ),
                m.说明 ? h('div', { style: { color: C.dim, fontSize: 11.5, marginBottom: 8 } }, String(m.说明)) : null,

                // 当前进度（有就显示）
                (态.进度 || 态.阶段)
                  ? h('div', {
                      style: {
                        fontSize: 12,
                        marginBottom: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        background: 'rgba(127,127,127,.08)',
                        wordBreak: 'break-all',
                      },
                    },
                      h('div', null, String(态.进度 || ('阶段：' + 态.阶段))),
                      h('div', { style: { color: C.dim, fontSize: 11, marginTop: 2 } },
                        '阶段：' + (态.阶段 || '—') +
                        '　画面：' + (态.认出 || '没认出来什么') +
                        (态.开口数 ? '　已开口 ' + 态.开口数 + ' 次' : '')),
                    )
                  : null,

                // 配置字段
                (m.配置 || []).map((f) => {
                  const 值 = 表 ? 表[f.键] : ''
                  if (f.类型 === '开关') {
                    return h('label', {
                      key: f.键,
                      style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', cursor: 'pointer' },
                    },
                      h('input', {
                        type: 'checkbox',
                        checked: !!值,
                        onChange: (e) => 存字段(f.键, e.target.checked),
                      }),
                      h('span', null, String(f.标签 || f.键)),
                      f.说明 ? h('span', { style: { color: C.dim, fontSize: 11 } }, '（' + String(f.说明) + '）') : null,
                    )
                  }
                  const 是数字 = f.类型 === '数字'
                  return h('div', { key: f.键, style: { padding: '5px 0' } },
                    h('div', { style: { color: C.dim, fontSize: 11.5, marginBottom: 3 } }, String(f.标签 || f.键)),
                    h('input', {
                      style: 框,
                      type: 是数字 ? 'number' : 'text',
                      value: 值 === undefined || 值 === null ? '' : 值,
                      placeholder: f.占位 ? String(f.占位) : '',
                      onChange: (e) => 设表((前) => ({ ...(前 || {}), [f.键]: e.target.value })),
                      onBlur: (e) => 存字段(f.键, 是数字 ? Number(e.target.value) || 0 : e.target.value),
                    }),
                    f.说明 ? h('div', { style: { color: C.dim, fontSize: 11, marginTop: 3 } }, String(f.说明)) : null,
                  )
                }),

                // 操作按钮
                (m.操作 || []).length
                  ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 } },
                      (m.操作 || []).map((op) => {
                        const 缺 = op.需要 && !(表 && String(表[op.需要] || '').trim())
                        return h('button', {
                          key: op.键,
                          style: {
                            ...键,
                            background: 缺 ? 'transparent' : C.brand,
                            color: 缺 ? C.dim : '#fff',
                            borderColor: 缺 ? C.line : C.brand,
                            opacity: 缺 ? 0.6 : 1,
                            cursor: 缺 ? 'not-allowed' : 'pointer',
                          },
                          disabled: 忙这个 || 缺,
                          title: 缺 ? '先把上面的「想做什么菜」填上' : '',
                          onClick: () => 模块动作(m, String(op.标签 || op.键)),
                        }, 忙这个 ? '处理中…' : String(op.标签 || op.键))
                      }),
                    )
                  : null,

                (模块说 && 模块说.id === m.id)
                  ? h('div', {
                      style: {
                        marginTop: 8,
                        fontSize: 11.5,
                        color: 模块说.错 ? C.bad : C.ok,
                        wordBreak: 'break-all',
                      },
                    }, String(模块说.文本))
                  : null,
              )
            }),

        // ---------------------------------------------------------- 自检
        h('div', { style: { fontSize: 14, fontWeight: 600, margin: '22px 0 4px' } }, '自检'),
        h('div', { style: { color: C.dim, fontSize: 11.5, marginBottom: 8 } },
          '看看 ffmpeg / python / 模型 / 摄像头是不是都齐了。第一次装完点一下这个。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
          h('button', { style: 键, onClick: 跑自检, disabled: 自检忙 }, 自检忙 ? '检查中…' : '跑一次自检'),
          h('button', {
            style: 键,
            title: '把「第一次装完该怎么配摄像头」的引导重新放回系统提示词',
            onClick: () => 引导动作('reset', ''),
          }, '再看一次引导'),
        ),
        自检
          ? h('div', {
              style: {
                border: '1px solid ' + C.line,
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 11.5,
                lineHeight: 1.7,
              },
            },
              h('div', { style: { color: 自检.可以跑 ? C.ok : C.warn, fontWeight: 600, marginBottom: 6 } },
                自检.可以跑 ? '✓ 都齐了，可以跑' : '⚠ 还差点东西'),
              (自检.缺 || []).length
                ? h('div', null,
                    (自检.缺 || []).map((x, i) => h('div', { key: i, style: { marginBottom: 4 } },
                      h('b', null, String(x.项) + '：'),
                      String(x.说明),
                    )),
                  )
                : null,
              h('div', { style: { color: C.dim, marginTop: 6 } },
                'ffmpeg：' + String((自检.ffmpeg && 自检.ffmpeg.path) || '—') +
                (自检.ffmpeg && 自检.ffmpeg.exists ? ' ✓' : ' ✗') +
                '（' + String((自检.ffmpeg && 自检.ffmpeg.来源) || '') + '）'),
              h('div', { style: { color: C.dim } },
                'python：' + String((自检.python && 自检.python.path) || '—') +
                (自检.python && 自检.python.exists ? ' ✓' : ' ✗') +
                '（' + String((自检.python && 自检.python.来源) || '') + '）'),
              h('div', { style: { color: C.dim } },
                '模型：' + String((自检.model && 自检.model.dir) || '—') + (自检.model && 自检.model.exists ? ' ✓' : ' ✗')),
              h('div', { style: { color: C.dim } },
                '权重：' + String((自检.yolo && 自检.yolo.path) || '—') + (自检.yolo && 自检.yolo.exists ? ' ✓' : ' ✗')),
              h('div', { style: { color: C.dim } },
                '麦克风 ' + ((自检.audio || []).length) + ' 个　摄像头 ' + ((自检.video || []).length) + ' 个'),
              h('div', { style: { color: C.dim, marginTop: 4 } }, 'CLIP：' + String((自检.clip && 自检.clip.note) || '')),
            )
          : null,

        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 },
        },
          h('button', {
            style: { ...键, background: C.brand, color: '#fff', borderColor: C.brand, padding: '6px 16px' },
            onClick: 存,
          }, '保存'),
          h('span', { style: { color: C.dim, fontSize: 12 } }, 存状),
        ),

        上一轮
          ? h('div', { style: { marginTop: 16, color: C.dim, fontSize: 12 } },
              '上一轮 ' + 毫秒(上一轮.总毫秒) + ' ＝ 判停 ' + 毫秒(上一轮.判停毫秒) + ' ＋ 转写 ' + 毫秒(上一轮.转写毫秒) + ' ＋ 送达 ' + 毫秒(上一轮.送达毫秒),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'camera-bridge-card',
          order: 70,
        }, () => h(兜底, null, h(卡片))))

        // 设置里也放一页：卡片被挡住 / 找不到的时候，从这里进
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'camera-bridge',
          order: 60,
          label: '摄像头桥',
        }, () => h(兜底, null, h(设置页))))
      },
    }
  },
})
