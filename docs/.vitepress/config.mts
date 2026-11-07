import { defineConfig } from 'vitepress'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type NotationBlock = {
  hash: string
  id: string
  language: 'abc' | 'lilypond'
  status: 'published' | 'draft'
  title: string
  location: string
  svg: string[]
  audio: string
  source: string
}

const notationLanguages = new Set(['abc', 'lilypond', 'ly'])

// 谱例产物在本地用 tools/render-notation.mjs 预渲染并随仓库提交，
// CI 只做站点构建，不需要 LilyPond / abc2svg / fluidsynth。
const manifestPath = resolve(
  fileURLToPath(new URL('../public/notation/manifest.json', import.meta.url))
)

function readManifest(): Map<string, NotationBlock> {
  if (!existsSync(manifestPath)) {
    throw new Error(
      '谱例清单缺失（docs/public/notation/manifest.json）。' +
        '请先在本地运行 node tools/render-notation.mjs。'
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    schemaVersion?: number
    blocks: NotationBlock[]
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `谱例清单版本不匹配（期望 1，实际 ${String(manifest.schemaVersion)}），` +
        '请重新运行 node tools/render-notation.mjs。'
    )
  }
  return new Map(manifest.blocks.map((block) => [block.hash, block]))
}

function escapeAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// VitePress 的代码块不认 abc / lilypond 语言，直接交给 Shiki 会退回纯文本并告警。
// 这里借用 text 语言渲染，再把外层语言标记改回真实语言名（标记变化时只是少一个标签，不会崩）。
function renderSourceFence(defaultFence: any, token: any, options: any, env: any, self: any, label: string) {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(token)), token, { info: 'text' })
  return String(defaultFence([clone], 0, options, env, self))
    .replace('class="language-text', `class="language-${label}`)
    .replace('<span class="lang">text</span>', `<span class="lang">${label}</span>`)
}

// 谱例围栏的语义是「先看源码，再听声音」：
// 保留代码块本体，在它下面挂上 ScoreExample 播放器（与 music-wiki 同一个组件）。
function notationMarkdownPlugin(md: any) {
  const manifest = readManifest()
  const defaultFence = md.renderer.rules.fence

  md.renderer.rules.fence = (tokens: any[], index: number, options: any, env: any, self: any) => {
    const token = tokens[index]
    const language = token.info.trim().split(/\s+/, 1)[0].toLowerCase()
    if (!notationLanguages.has(language)) {
      return defaultFence(tokens, index, options, env, self)
    }

    const hash = createHash('sha256').update(token.content).digest('hex')
    const block = manifest.get(hash)
    if (!block) {
      throw new Error(
        `谱例尚未渲染（sha256 ${hash.slice(0, 12)}…）：${token.info.trim()}。` +
          '提交前请运行 node tools/render-notation.mjs。'
      )
    }

    const attributes = {
      id: block.id,
      title: block.title,
      location: block.location,
      language: block.language,
      status: block.status || 'published',
      svg: block.svg.join('|'),
      audio: block.audio,
      source: block.source
    }
    const renderedAttributes = Object.entries(attributes)
      .map(([name, value]) => `${name}="${escapeAttribute(String(value))}"`)
      .join(' ')

    return `${renderSourceFence(defaultFence, token, options, env, self, language)}<ScoreExample ${renderedAttributes} />\n`
  }
}

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "OpenCadenza",
  description: "Docs for OpenCadenza",
  markdown: {
    config: notationMarkdownPlugin
  },
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'I-score', link: '/i-score/introducing-i-score' }
    ],

    sidebar: [
      {
        text: 'I-score 智能乐谱交流平台',
        items: [
          { text: 'I-score 简介', link: '/i-score/introducing-i-score' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/OpenCadenza' }
    ]
  }
})
