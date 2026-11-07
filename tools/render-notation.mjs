#!/usr/bin/env node
/**
 * render-notation.mjs —— 本地谱例预渲染脚本（ABC / LilyPond → SVG + MP3 + manifest）
 *
 * 站点展示的谱例全部是**预渲染产物**，GitHub Actions 只做 VitePress 构建，不跑本脚本。
 * 维护者在本地改完谱例源码后手动执行一次，把 docs/public/notation 下的产物一起提交。
 *
 * 用法：
 *   node tools/render-notation.mjs [--docs <dir>] [--public <dir>] [--check] [--force] [--skip-audio]
 *
 *   --docs <dir>     Markdown 根目录，默认 <仓库根>/docs
 *   --public <dir>   静态资源目录，默认 <docs>/public（产物写到 <public>/notation）
 *   --check          只校验：重算文档里的谱例 hash 并与 manifest、产物比对
 *   --force          忽略缓存，全部重新渲染
 *   --skip-audio     只渲染 SVG（本地预览用；manifest 里 audio 为 null，不要提交）
 *   -h, --help       显示帮助
 *
 * 依赖的本地工具（都不是 npm 依赖，通过环境变量覆盖路径）：
 *   LILYPOND_PATH / ABC2MIDI_PATH / FLUIDSYNTH_PATH / FFMPEG_PATH / FFPROBE_PATH
 *   SOUNDFONT_PATH / ABC2SVG_PATH，以及可替换 ABC→MIDI 的 ABC2MIDI_CMD
 *
 * 本文件只用 Node 内置模块，不引入任何 npm 包。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MANIFEST_GENERATOR = 'tools/render-notation.mjs'
const MANIFEST_SCHEMA_VERSION = 1
// 渲染逻辑的版本号：改动 SVG / 音频的产生方式时提升，让旧缓存自然失效
const GENERATOR_VERSION = '1'
// 与站点端一致：只有这三种语言围栏会被预渲染，ly 归一成 lilypond
const NOTATION_LANGUAGES = new Set(['abc', 'lilypond', 'ly'])
const SKIP_DIRECTORIES = new Set([
  '.vitepress',
  'public',
  'node_modules',
  'dist',
  '.git',
  '.notation-work'
])
const DEFAULT_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 300_000)
// 版本探测用更短的超时：工具不可用时要尽快给出提示，而不是干等 5 分钟
const PROBE_TIMEOUT_MS = Number(process.env.RENDER_PROBE_TIMEOUT_MS || 30_000)
const STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SUPPORTED_ATTRIBUTES = new Set(['title', 'location', 'id'])
// LilyPond 未裁剪时的整页尺寸，用来过滤掉非裁剪出的页面
const FULL_PAGE_SIZE = /width="210\.00mm"\s+height="297\.00mm"/

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')

// 运行期全局（main 里赋值）
let workRoot = null
let logDirectory = null
let commandCounter = 0

// ---------------------------------------------------------------------------
// 命令行参数
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(
    [
      '本地谱例预渲染：把 Markdown 里的 ```abc / ```lilypond 围栏渲染成 SVG 与 MP3。',
      '',
      '用法：node tools/render-notation.mjs [--docs <dir>] [--public <dir>] [--check] [--force]',
      '',
      '  --docs <dir>     Markdown 根目录，默认 <仓库根>/docs',
      '  --public <dir>   静态资源目录，默认 <docs>/public',
      '  --check          只校验 manifest 与产物（不调用任何渲染工具）',
      '  --force          忽略缓存全部重渲染',
      '  --skip-audio     只渲染 SVG（本地预览用，产物不完整，不要提交）',
      '',
      '环境变量覆盖工具路径：LILYPOND_PATH、ABC2MIDI_PATH、FLUIDSYNTH_PATH、FFMPEG_PATH、',
      'FFPROBE_PATH、SOUNDFONT_PATH、ABC2SVG_PATH；RENDER_TIMEOUT_MS 可调单条命令超时。',
      '',
      'ABC→MIDI 可以换成别的转换器：设置 ABC2MIDI_CMD，例如',
      '  ABC2MIDI_CMD="E:/tools/abc2midi.exe"',
      '  ABC2MIDI_CMD="python E:/tools/abc2midi.py"',
      '  ABC2MIDI_CMD="node E:/tools/abc2midi.mjs"',
      '它必须接受 `<_source.abc> -o <_output.mid>` 这种调用形式。'
    ].join('\n')
  )
}

function parseArguments(argv) {
  const options = {
    docs: null,
    public: null,
    check: false,
    force: false,
    skipAudio: process.env.RENDER_SKIP_AUDIO === '1',
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const nextValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} 需要一个目录参数`)
      }
      index += 1
      return value
    }
    if (argument === '--docs') options.docs = nextValue('--docs')
    else if (argument === '--public') options.public = nextValue('--public')
    else if (argument === '--check') options.check = true
    else if (argument === '--force') options.force = true
    else if (argument === '--skip-audio') options.skipAudio = true
    else if (argument === '-h' || argument === '--help') options.help = true
    else throw new Error(`未知参数：${argument}（用 --help 查看用法）`)
  }
  return options
}

const options = parseArguments(process.argv.slice(2))
// 显式给出的目录按当前工作目录解析（方便 `--docs .work/xxx/docs` 这种调用）；
// 不给参数时回落到仓库内的默认位置。
const docsDirectory = options.docs
  ? resolve(process.cwd(), options.docs)
  : join(repoRoot, 'docs')
const publicDirectory = options.public
  ? resolve(process.cwd(), options.public)
  : join(docsDirectory, 'public')
const notationDirectory = join(publicDirectory, 'notation')

// ---------------------------------------------------------------------------
// 子进程执行
// ---------------------------------------------------------------------------
// 注意：这里用「文件描述符重定向」而不是管道（stdio: 'pipe'）。
// 受限环境（沙箱）禁止通过管道捕获子进程输出，而且文件重定向在 Windows 上更稳，
// 不会因为管道缓冲写满而卡死。fd 必须等子进程退出后才能关闭。

function createTool(key, label, command, envName, prefixArgs = [], hints = []) {
  return { key, label, command, envName, prefixArgs, hints }
}

function describeCommand(tool, args) {
  const all = [...tool.prefixArgs, ...args]
  return `${tool.command} ${all.join(' ')}`
}

function waitForChild(child, timeout) {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 忽略：进程可能已经退出
      }
      finish({ timedOut: true })
    }, timeout)
    child.once('error', (error) => finish({ error }))
    child.once('close', (code) => finish({ code }))
  })
}

async function runCommand(tool, args, runOptions = {}) {
  const {
    cwd = repoRoot,
    timeout = DEFAULT_TIMEOUT_MS,
    // abc2midi 这类工具会在「小节时值不匹配拍号」等可恢复的问题上返回非零码，
    // 但 MIDI 其实已经完整写出；这类步骤由调用方自己判断产物，不要因为退出码直接失败
    allowNonZeroExit = false
  } = runOptions
  if (!workRoot) throw new Error('内部错误：工作目录尚未初始化')
  commandCounter += 1
  const tag = `${tool.key}-${commandCounter}`
  const stdoutPath = join(logDirectory, `${tag}.stdout.log`)
  const stderrPath = join(logDirectory, `${tag}.stderr.log`)
  const stdoutHandle = await open(stdoutPath, 'w')
  const stderrHandle = await open(stderrPath, 'w')

  let outcome
  try {
    const child = spawn(tool.command, [...tool.prefixArgs, ...args], {
      cwd,
      // 固定时间戳，让 LilyPond 等工具的输出可复现
      env: { ...process.env, SOURCE_DATE_EPOCH: '946684800' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd]
    })
    outcome = await waitForChild(child, timeout)
  } catch (error) {
    outcome = { error }
  } finally {
    // 子进程已经退出，可以安全关闭父进程这边的 fd
    await stdoutHandle.close().catch(() => {})
    await stderrHandle.close().catch(() => {})
  }

  const stdout = await readFile(stdoutPath, 'utf8').catch(() => '')
  const stderr = await readFile(stderrPath, 'utf8').catch(() => '')
  const tail = (text) => tailOf(text, 8)
  const hintLines = tool.hints.length > 0 ? ['', ...tool.hints] : []

  if (outcome.timedOut) {
    throw new Error(
      [
        `${tool.label} 执行超时（${timeout}ms 没有任何响应），命令：`,
        `  ${describeCommand(tool, args)}`,
        stderr.trim() ? `已捕获的错误输出：\n${tail(stderr)}` : '',
        '如果是可执行文件本身的问题（版本损坏、被杀毒软件拦截、不是本平台的可执行格式），',
        '请换一个可用版本并用环境变量指向它。',
        ...hintLines
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  if (outcome.error) {
    if (outcome.error.code === 'ENOENT') throw missingToolError(tool)
    throw new Error(`${tool.label} 无法启动：${outcome.error.message}${hintLines.join('\n')}`)
  }
  if (outcome.code !== 0 && !allowNonZeroExit) {
    throw new Error(
      [
        `${tool.label} 退出码 ${outcome.code}，命令：`,
        `  ${describeCommand(tool, args)}`,
        tail(stderr || stdout) ? `输出：\n${tail(stderr || stdout)}` : '',
        ...hintLines
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  return { stdout, stderr, code: outcome.code }
}

function missingToolError(tool) {
  return new Error(
    [
      `找不到本地渲染工具 ${tool.label}（命令：${tool.command}）。`,
      '这个脚本只在维护者本地运行，GitHub Actions 不会执行它；渲染产物是提交进仓库的。',
      `请安装该工具后用环境变量 ${tool.envName} 指向可执行文件，或放到本脚本默认查找的位置。`,
      '需要的工具：lilypond、abc2midi（或等价 ABC→MIDI 转换器）、abc2svg（node 运行）、',
      'fluidsynth、ffmpeg、ffprobe、一个 GM 音色库（.sf2）。',
      ...tool.hints
    ].join('\n')
  )
}

// ---------------------------------------------------------------------------
// 工具链定位
// ---------------------------------------------------------------------------

function firstExisting(environmentName, candidates, fallbackName) {
  const fromEnvironment = process.env[environmentName]
  if (fromEnvironment) return fromEnvironment
  const found = candidates.find((candidate) => existsSync(candidate))
  return found || fallbackName
}

/** 把 "python x.py --flag" 这种命令行拆成 token，支持双引号/单引号 */
function splitCommandLine(text) {
  const tokens = []
  let current = ''
  let quote = null
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current) tokens.push(current)
  return tokens
}

const ABC_MIDI_HINTS = [
  'ABC 音频需要 abc2midi 或等价的 ABC→MIDI 转换器（要求支持 `<_source.abc> -o <_output.mid>`）。',
  '可以用 ABC2MIDI_CMD 指定它，例如：ABC2MIDI_CMD="python E:/tools/abc2midi.py"；',
  '只想先看排版效果时用 --skip-audio（只出 SVG，不生成 MP3）。'
]

/**
 * ABC→MIDI 这一步是可替换的：
 *   1. ABC2MIDI_CMD 优先（支持 .js/.mjs/.cjs/.py 脚本，或直接给可执行文件 + 参数）
 *   2. 其次 ABC2MIDI_PATH
 *   3. 最后回落仓库 .tools 下的 abc2midi，再回落 PATH 上的 abc2midi
 */
function resolveAbc2MidiTool() {
  const explicit = process.env.ABC2MIDI_CMD
  if (explicit && explicit.trim()) {
    const [program, ...rest] = splitCommandLine(explicit)
    if (!program) throw new Error('ABC2MIDI_CMD 是空的')
    const lower = program.toLowerCase()
    if (/\.(?:mjs|cjs|js)$/.test(lower)) {
      return createTool(
        'abc2midi',
        'ABC→MIDI 转换器（ABC2MIDI_CMD）',
        process.execPath,
        'ABC2MIDI_CMD',
        [program, ...rest],
        ABC_MIDI_HINTS
      )
    }
    if (lower.endsWith('.py')) {
      return createTool(
        'abc2midi',
        'ABC→MIDI 转换器（ABC2MIDI_CMD）',
        process.env.PYTHON_PATH || 'python',
        'ABC2MIDI_CMD',
        [program, ...rest],
        ABC_MIDI_HINTS
      )
    }
    return createTool(
      'abc2midi',
      'ABC→MIDI 转换器（ABC2MIDI_CMD）',
      program,
      'ABC2MIDI_CMD',
      rest,
      ABC_MIDI_HINTS
    )
  }

  return createTool(
    'abc2midi',
    'abc2midi',
    firstExisting(
      'ABC2MIDI_PATH',
      [
        join(repoRoot, '.tools', 'abcmidi-20261016', 'abc2midi.exe'),
        join(repoRoot, '.tools', 'abcmidi-20261016', 'abc2midi')
      ],
      'abc2midi'
    ),
    'ABC2MIDI_PATH',
    [],
    ABC_MIDI_HINTS
  )
}

function resolveToolchain() {
  const lilypond = createTool(
    'lilypond',
    'LilyPond',
    firstExisting(
      'LILYPOND_PATH',
      [
        join(repoRoot, '.tools', 'lilypond-2.26.0', 'bin', 'lilypond.exe'),
        join(repoRoot, '.tools', 'lilypond-2.26.0', 'bin', 'lilypond'),
        join(repoRoot, '.tools', 'lilypond', 'bin', 'lilypond.exe')
      ],
      'lilypond'
    ),
    'LILYPOND_PATH'
  )

  const fluidsynth = createTool(
    'fluidsynth',
    'FluidSynth',
    firstExisting(
      'FLUIDSYNTH_PATH',
      [
        join(
          repoRoot,
          '.tools',
          'fluidsynth-v2.6.1-win10-x64-cpp11',
          'bin',
          'fluidsynth.exe'
        )
      ],
      'fluidsynth'
    ),
    'FLUIDSYNTH_PATH'
  )

  const ffmpeg = createTool(
    'ffmpeg',
    'ffmpeg',
    firstExisting('FFMPEG_PATH', [], 'ffmpeg'),
    'FFMPEG_PATH'
  )

  const ffprobe = createTool(
    'ffprobe',
    'ffprobe',
    firstExisting(
      'FFPROBE_PATH',
      process.env.FFMPEG_PATH
        ? [
            process.env.FFMPEG_PATH.replace(
              /ffmpeg(?:\.exe)?$/i,
              (match) => match.replace(/ffmpeg/i, 'ffprobe')
            )
          ]
        : [],
      'ffprobe'
    ),
    'FFPROBE_PATH'
  )

  // abc2svg 是一个 .js 命令行程序，用当前 node 运行
  const abc2svgScript =
    process.env.ABC2SVG_PATH ||
    join(repoRoot, 'node_modules', 'abc2svg', 'abc2svg')
  const abc2svg = createTool(
    'abc2svg',
    'abc2svg',
    process.execPath,
    'ABC2SVG_PATH',
    [abc2svgScript]
  )

  const soundfontCandidates = [
    process.env.SOUNDFONT_PATH,
    join(repoRoot, '.tools', 'soundfonts', 'FluidR3_GM.sf2'),
    join(repoRoot, 'soundfonts', 'FluidR3_GM.sf2'),
    join(repoRoot, 'public', 'soundfonts', 'FluidR3_GM.sf2')
  ].filter(Boolean)
  const soundfont = soundfontCandidates.find((candidate) => existsSync(candidate))

  return {
    lilypond,
    abc2midi: resolveAbc2MidiTool(),
    fluidsynth,
    ffmpeg,
    ffprobe,
    abc2svg,
    soundfont,
    customAbc2Midi: Boolean(process.env.ABC2MIDI_CMD && process.env.ABC2MIDI_CMD.trim())
  }
}

function firstLine(text) {
  return (text || '').trim().split(/\r?\n/, 1)[0].trim()
}

async function probeToolchain(toolchain, { audio }) {
  log(`检查本地渲染工具…${audio ? '' : '（--skip-audio：跳过音频相关工具）'}`)

  if (!existsSync(toolchain.abc2svg.prefixArgs[0])) {
    throw new Error(
      [
        '找不到 abc2svg 命令行脚本（ABC 排版需要它）。',
        '它来自 npm 包 abc2svg（仅本地渲染用，不进 CI），请在仓库根执行：',
        '  npm install --no-save abc2svg',
        '或用环境变量 ABC2SVG_PATH 指向 node_modules/abc2svg/abc2svg。',
        `当前查找位置：${toolchain.abc2svg.prefixArgs[0]}`
      ].join('\n')
    )
  }

  const versions = {}
  const [lilypondVersion] = await Promise.all([
    runCommand(toolchain.lilypond, ['--version'], { timeout: PROBE_TIMEOUT_MS })
  ])
  versions.lilypond = firstLine(lilypondVersion.stdout) || firstLine(lilypondVersion.stderr)

  versions.abc2svg = await detectAbc2svgVersion(toolchain.abc2svg.prefixArgs[0])

  if (audio) {
    if (!toolchain.soundfont) {
      throw new Error(
        [
          '找不到 General MIDI 音色库（.sf2），渲染音频需要它。',
          '请用环境变量 SOUNDFONT_PATH 指定，例如：',
          '  SOUNDFONT_PATH=E:/soundfonts/FluidR3_GM.sf2',
          '默认查找位置：<仓库根>/.tools/soundfonts/FluidR3_GM.sf2',
          '只想先看排版效果可以加 --skip-audio。'
        ].join('\n')
      )
    }
    const [fluidsynthVersion, ffmpegVersion, ffprobeVersion] = await Promise.all([
      runCommand(toolchain.fluidsynth, ['--version'], { timeout: PROBE_TIMEOUT_MS }),
      runCommand(toolchain.ffmpeg, ['-version'], { timeout: PROBE_TIMEOUT_MS }),
      runCommand(toolchain.ffprobe, ['-version'], { timeout: PROBE_TIMEOUT_MS })
    ])
    versions.fluidsynth = firstLine(fluidsynthVersion.stdout)
    versions.ffmpeg = firstLine(ffmpegVersion.stdout)
    versions.ffprobe = firstLine(ffprobeVersion.stdout)

    if (toolchain.customAbc2Midi) {
      // 自定义转换器不一定支持 -ver，用命令串本身作为版本标记（缓存键也会随之变化）
      versions.abc2midi = `custom:${process.env.ABC2MIDI_CMD.trim()}`
    } else {
      const abc2midiVersion = await runCommand(toolchain.abc2midi, ['-ver'], {
        timeout: PROBE_TIMEOUT_MS
      })
      versions.abc2midi =
        firstLine(abc2midiVersion.stdout) || firstLine(abc2midiVersion.stderr)
    }
  }

  for (const [name, value] of Object.entries(versions)) {
    if (!value) throw new Error(`无法识别 ${name} 的版本号，请检查该工具是否可用`)
  }
  const soundfontSha256 =
    toolchain.soundfont && audio ? sha256(await readFile(toolchain.soundfont)) : null

  for (const [name, value] of Object.entries(versions)) log(`  ${name} ${value}`)
  if (audio) log(`  音色库 ${toolchain.soundfont}`)

  return { versions, soundfontSha256 }
}

async function detectAbc2svgVersion(abc2svgScript) {
  // abc2svg 没有稳定的 --version，直接读它所在 npm 包的 package.json
  const packagePath = join(dirname(abc2svgScript), 'package.json')
  if (existsSync(packagePath)) {
    try {
      return JSON.parse(await readFile(packagePath, 'utf8')).version || 'unknown'
    } catch {
      return 'unknown'
    }
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

function toPosix(path) {
  return path.split(sep).join('/')
}

function compareNames(left, right) {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

function log(message) {
  console.log(message)
}

function tailOf(text, lines = 6) {
  return (text || '').trim().split(/\r?\n/).slice(-lines).join('\n')
}

/** 把任意字符串安全化成可以直接做目录名 / URL 段的 id */
function safeAssetId(value, hashSeed) {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return safe || `notation-${hashSeed.slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Markdown 围栏扫描
// ---------------------------------------------------------------------------
// 这里不能用 markdown-it（脚本必须零 npm 依赖），所以要自己复刻它的行为：
//   * 围栏缩进 0–3 个空格；``` 和 ~~~ 都支持
//   * 围栏正文 = 开围栏行之后到闭围栏行之前的原文，**每行去掉最多「开围栏行的缩进」个前导空格**
//     （markdown-it 的 fence 规则里 len = state.sCount[startLine]，不是反引号的个数！），
//     行之间用 \n 连接，最后再补一个 \n —— 这正是 markdown-it 的 token.content
//   * 这条规则决定了站点端算出来的 sha256 和脚本是否一致，改动前务必用 markdown-it 回归校验

function stripFenceIndent(line, indent) {
  let index = 0
  while (index < line.length && index < indent && line[index] === ' ') index += 1
  return line.slice(index)
}

/**
 * 扫出一份 Markdown 里的围栏，返回 { opening, closing, markerLength, indent, info }。
 * 围栏未闭合时直接报错（文档里不应该出现），避免静默吞掉内容。
 */
function scanFences(lines, relativePath) {
  const fences = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const openingMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    if (!openingMatch) continue
    const indent = openingMatch[1].length
    const marker = openingMatch[2][0]
    const markerLength = openingMatch[2].length
    const info = openingMatch[3]
    // markdown-it：信息串里出现同种围栏字符时不算开围栏
    if (info.includes(marker)) continue

    let closing = -1
    for (let next = index + 1; next < lines.length; next += 1) {
      const closingMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[next])
      if (!closingMatch) continue
      if (closingMatch[1][0] !== marker) continue
      if (closingMatch[1].length < markerLength) continue
      closing = next
      break
    }
    if (closing < 0) {
      throw new Error(
        `${relativePath}:${index + 1}: 围栏没有闭合（缺少 ${marker.repeat(markerLength)} 结尾行）`
      )
    }
    fences.push({ opening: index, closing, markerLength, indent, info })
    index = closing
  }
  return fences
}

function fenceContent(lines, fence) {
  const opening = fence.opening
  const closing = fence.closing
  if (closing <= opening + 1) return ''
  const contentLines = lines
    .slice(opening + 1, closing)
    .map((line) => stripFenceIndent(line, fence.indent))
  // markdown-it 的 getLines(..., keepLastLF = true)：每行都带换行
  return `${contentLines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 围栏属性解析（规则与站点端解析器一致）
// ---------------------------------------------------------------------------

function parseNotationFenceInfo(info) {
  const source = (info || '').trim()
  const languageMatch = source.match(/^([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!languageMatch) {
    return { language: '', attributes: {}, hasMetadata: false, error: '谱例围栏缺少语言标记' }
  }
  const language = languageMatch[1].toLowerCase()
  const attributes = {}
  let rest = (languageMatch[2] || '').trim()
  const hasMetadata = rest.length > 0

  while (rest) {
    const match = rest.match(/^([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"(?=\s|$)/)
    if (!match) {
      return { language, attributes, hasMetadata, error: `无法识别的谱例属性：${rest}` }
    }
    const [, name, rawValue] = match
    if (!SUPPORTED_ATTRIBUTES.has(name)) {
      return { language, attributes, hasMetadata, error: `不支持的谱例属性：${name}` }
    }
    if (Object.hasOwn(attributes, name)) {
      return { language, attributes, hasMetadata, error: `重复的谱例属性：${name}` }
    }
    attributes[name] = rawValue.trim()
    rest = rest.slice(match[0].length).trimStart()
  }

  if (hasMetadata && !attributes.title) {
    return { language, attributes, hasMetadata, error: '谱例属性里缺少 title' }
  }
  if (hasMetadata && !attributes.location) {
    return { language, attributes, hasMetadata, error: '谱例属性里缺少 location' }
  }
  if (attributes.id && !STABLE_ID_PATTERN.test(attributes.id)) {
    return {
      language,
      attributes,
      hasMetadata,
      error: '谱例 id 必须匹配 [a-z0-9][a-z0-9._-]*'
    }
  }
  return { language, attributes, hasMetadata, error: null }
}

// ---------------------------------------------------------------------------
// 收集文档里的谱例块
// ---------------------------------------------------------------------------

async function walkMarkdownFiles(directory) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => compareNames(left.name, right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      files.push(...(await walkMarkdownFiles(path)))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(path)
    }
  }
  return files
}

function pageHeading(source) {
  const match = source.match(/^#\s+(.+)$/m)
  return match ? match[1].replaceAll(/[*_`]/g, '').trim() : ''
}

async function collectBlocks() {
  if (!existsSync(docsDirectory)) {
    throw new Error(`文档目录不存在：${docsDirectory}（用 --docs 指定 Markdown 根目录）`)
  }
  const files = await walkMarkdownFiles(docsDirectory)
  const blocks = []
  const hashes = new Map()
  const ids = new Map()

  for (const path of files) {
    const source = await readFile(path, 'utf8')
    // markdown-it 读文件时会把 \r\n 归一成 \n，这里保持一致
    const lines = source.replaceAll('\r\n', '\n').split('\n')
    const relativePath = toPosix(relative(docsDirectory, path))
    const heading = pageHeading(source)
    let notationIndex = 0

    for (const fence of scanFences(lines, relativePath)) {
      const fenceInfo = parseNotationFenceInfo(fence.info)
      if (!NOTATION_LANGUAGES.has(fenceInfo.language)) continue
      notationIndex += 1
      const line = fence.opening + 1
      if (fenceInfo.error) {
        throw new Error(`${relativePath}:${line}: ${fenceInfo.error}`)
      }
      const language = fenceInfo.language === 'ly' ? 'lilypond' : fenceInfo.language
      const code = fenceContent(lines, fence)
      if (!code.trim()) {
        throw new Error(`${relativePath}:${line}: 谱例内容为空`)
      }
      const hash = sha256(code)
      const previousLocation = hashes.get(hash)
      if (previousLocation) {
        throw new Error(
          `出现了两份内容完全相同的谱例，无法区分：${relativePath}:${line} 与 ${previousLocation}`
        )
      }
      hashes.set(hash, `${relativePath}:${line}`)

      const rawId =
        fenceInfo.attributes.id ||
        `notation.${relativePath.replace(/\.md$/i, '').replaceAll('/', '.')}.${notationIndex}`
      const id = safeAssetId(rawId, hash)
      if (ids.has(id)) {
        throw new Error(
          `谱例 id 重复：${id}（${relativePath}:${line} 与 ${ids.get(id)}），请用 id="..." 显式区分`
        )
      }
      ids.set(id, `${relativePath}:${line}`)

      blocks.push({
        id,
        hash,
        language,
        code,
        sourcePath: relativePath,
        line,
        status: 'published',
        title: fenceInfo.attributes.title || heading || relativePath.replace(/\.md$/i, ''),
        location: fenceInfo.attributes.location || ''
      })
    }
  }

  return blocks
}

// ---------------------------------------------------------------------------
// LilyPond 源码改写
// ---------------------------------------------------------------------------

/** 去掉顶层的 \version / \include / \language 指令，返回 { directives, music } */
function splitTopLevelDirectives(code) {
  const directives = []
  const music = []
  for (const line of code.replaceAll('\r\n', '\n').split('\n')) {
    if (/^\s*\\(?:version|include|language)\b/.test(line)) directives.push(line.trim())
    else music.push(line)
  }
  return { directives, music: music.join('\n').trim() }
}

function lilypondTargetVersion(versions) {
  const match = String(versions.lilypond || '').match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : '2.26.0'
}

/** 片段（没有 \score）包一层，变成可以直接排版的完整文件 */
function wrappedFragment(code, { targetVersion, midi }) {
  const { directives, music } = splitTopLevelDirectives(code)
  const hasVersion = directives.some((line) => /^\\version\b/.test(line))
  const header = hasVersion ? directives : [`\\version "${targetVersion}"`, ...directives]
  return [
    ...header,
    '\\score {',
    `  \\new Staff { ${music} }`,
    '  \\layout { }',
    ...(midi ? ['  \\midi { }'] : []),
    '}',
    ''
  ].join('\n')
}

function withLayoutOutput(code, targetVersion) {
  return /\\score\b/.test(code) ? code : wrappedFragment(code, { targetVersion, midi: false })
}

/** 跳过 LilyPond 里的字符串与注释（%{ %} 与 % 行注释） */
function skipQuotedAndComments(source, index) {
  const character = source[index]
  if (character === '"') {
    index += 1
    while (index < source.length) {
      if (source[index] === '\\') index += 2
      else if (source[index] === '"') return index + 1
      else index += 1
    }
    return index
  }
  if (character === '%' && source[index + 1] === '{') {
    const end = source.indexOf('%}', index + 2)
    return end < 0 ? source.length : end + 2
  }
  if (character === '%') {
    const end = source.indexOf('\n', index + 1)
    return end < 0 ? source.length : end + 1
  }
  return index
}

function matchingBrace(source, opening) {
  let depth = 0
  for (let index = opening; index < source.length; index += 1) {
    const skipped = skipQuotedAndComments(source, index)
    if (skipped !== index) {
      index = skipped - 1
      continue
    }
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error('LilyPond 花括号不配对，无法补 \\midi 输出')
}

/** 给每个缺少 \midi 的 \score 补一个 \midi { } */
function withMidiOutput(code, targetVersion) {
  if (!/\\score\b/.test(code)) {
    return wrappedFragment(code, { targetVersion, midi: true })
  }
  const scoreEnds = []
  const scorePattern = /\\score\b/g
  let match
  while ((match = scorePattern.exec(code))) {
    let opening = match.index + match[0].length
    while (opening < code.length && /\s/.test(code[opening])) opening += 1
    if (code[opening] !== '{') {
      throw new Error('\\score 之后应当是 {，无法补 \\midi 输出')
    }
    const closing = matchingBrace(code, opening)
    const block = code.slice(opening, closing + 1)
    if (!/\\midi\b/.test(block)) scoreEnds.push(closing)
    scorePattern.lastIndex = closing + 1
  }
  let rendered = code
  for (const position of scoreEnds.sort((left, right) => right - left)) {
    rendered = `${rendered.slice(0, position)}\n  \\midi { }\n${rendered.slice(position)}`
  }
  return rendered
}

// ---------------------------------------------------------------------------
// 渲染：ABC（排版与音频拆成两步）
// ---------------------------------------------------------------------------

async function renderAbcSvg(block, blockWorkDirectory, outputDirectory, toolchain) {
  const sourcePath = join(blockWorkDirectory, 'source.abc')
  await writeFile(sourcePath, block.code, 'utf8')

  // 渲染副本：加 %%fullsvg 让 abc2svg 分页输出整页 SVG
  const renderPath = join(blockWorkDirectory, 'render.abc')
  const renderSource = /^%%fullsvg\b/m.test(block.code)
    ? block.code
    : `%%fullsvg 1\n${block.code}`
  await writeFile(renderPath, renderSource, 'utf8')

  const rendered = await runCommand(toolchain.abc2svg, [renderPath], {
    cwd: blockWorkDirectory
  })
  const pages = [...rendered.stdout.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].map(
    (match) => match[0]
  )
  if (pages.length === 0) {
    throw new Error(
      `${block.id}: abc2svg 没有输出 SVG\n${tailOf(rendered.stderr || rendered.stdout)}`
    )
  }
  const svg = []
  for (const [index, page] of pages.entries()) {
    const name = `page-${index + 1}.svg`
    await writeFile(join(outputDirectory, name), `${page}\n`, 'utf8')
    svg.push(name)
  }
  return { svg, sourceName: 'source.abc' }
}

/** ABC → MIDI：这一步最容易缺工具，单独成函数，失败时前面的 SVG 已经落盘 */
async function renderAbcMidi(block, blockWorkDirectory, toolchain) {
  const sourcePath = join(blockWorkDirectory, 'source.abc')
  const midiPath = join(blockWorkDirectory, 'score.mid')
  // abc2midi 会把「小节时值≠拍号」「P: 段落标记非法」这类可恢复问题当错误报，
  // 但 MIDI 往往已经写全了。所以这里以「产物是否可用」为准，退出码只做提示。
  const result = await runCommand(toolchain.abc2midi, [sourcePath, '-o', midiPath], {
    cwd: blockWorkDirectory,
    allowNonZeroExit: true
  })
  const info = await stat(midiPath).catch(() => null)
  if (!info || !info.isFile() || info.size === 0) {
    const toolOutput = tailOf(result.stderr || result.stdout, 8)
    throw new Error(
      [
        `${block.id}: ABC→MIDI 没有生成可用的 MIDI 文件（${toolchain.abc2midi.label} 退出码 ${result.code}）。`,
        toolOutput ? `转换器输出：\n${toolOutput}` : '',
        ...ABC_MIDI_HINTS
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  if (result.code !== 0) {
    const toolOutput = tailOf(result.stderr || result.stdout, 4)
    log(
      `  注意：abc2midi 退出码 ${result.code}，但 MIDI 已写出（${info.size} 字节），继续。` +
        (toolOutput ? `\n    ${toolOutput.replaceAll('\n', '\n    ')}` : '')
    )
  }
  return midiPath
}

// ---------------------------------------------------------------------------
// 渲染：LilyPond（排版与音频拆成两步）
// ---------------------------------------------------------------------------

async function filesWithExtension(directory, extension) {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => entry.name)
    .sort(compareNames)
}

async function renderLilyPondSvg(block, blockWorkDirectory, outputDirectory, toolchain, versions) {
  const layoutDirectory = join(blockWorkDirectory, 'layout')
  await mkdir(layoutDirectory, { recursive: true })
  await writeFile(
    join(layoutDirectory, 'score.ly'),
    withLayoutOutput(block.code, lilypondTargetVersion(versions)),
    'utf8'
  )
  await runCommand(
    toolchain.lilypond,
    ['-dcrop', '-dbackend=svg', '-dno-point-and-click', '-o', 'page', 'score.ly'],
    { cwd: layoutDirectory }
  )

  const svgFiles = await filesWithExtension(layoutDirectory, '.svg')
  if (svgFiles.length === 0) {
    throw new Error(`${block.id}: LilyPond 没有输出 SVG`)
  }
  // -dcrop 会把未裁剪的整页 SVG 也写出来，按尺寸过滤掉
  const croppedSvgFiles = []
  for (const name of svgFiles) {
    const head = (await readFile(join(layoutDirectory, name), 'utf8')).slice(0, 512)
    if (!FULL_PAGE_SIZE.test(head)) croppedSvgFiles.push(name)
  }
  if (croppedSvgFiles.length === 0) {
    throw new Error(`${block.id}: LilyPond 只输出未裁剪的整页 SVG（检查 -dcrop 是否生效）`)
  }
  const svg = []
  for (const [index, name] of croppedSvgFiles.entries()) {
    const targetName = `page-${index + 1}.svg`
    await copyFile(join(layoutDirectory, name), join(outputDirectory, targetName))
    svg.push(targetName)
  }
  return { svg, sourceName: 'source.ly' }
}

async function renderLilyPondMidi(block, blockWorkDirectory, toolchain, versions) {
  const audioDirectory = join(blockWorkDirectory, 'audio')
  await mkdir(audioDirectory, { recursive: true })
  await writeFile(
    join(audioDirectory, 'score.ly'),
    withMidiOutput(block.code, lilypondTargetVersion(versions)),
    'utf8'
  )
  await runCommand(
    toolchain.lilypond,
    ['-dno-point-and-click', '-o', 'score', 'score.ly'],
    { cwd: audioDirectory }
  )
  const midiFiles = [
    ...(await filesWithExtension(audioDirectory, '.mid')),
    ...(await filesWithExtension(audioDirectory, '.midi'))
  ]
  if (midiFiles.length === 0) {
    throw new Error(`${block.id}: LilyPond 没有生成 MIDI 文件`)
  }
  if (midiFiles.length > 1) {
    throw new Error(
      [
        `${block.id}: 这一块生成了 ${midiFiles.length} 个 MIDI 文件（${midiFiles.join('、')}），`,
        '本项目只允许单谱例单 \\score（一个谱例 = 一段音频）。',
        '请把多余的 \\score 拆成单独的谱例围栏，脚本不会拼接多段 MIDI。'
      ].join('\n')
    )
  }
  return join(audioDirectory, midiFiles[0])
}

// ---------------------------------------------------------------------------
// 渲染：音频（两种语言共用）
// ---------------------------------------------------------------------------

async function probeDuration(path, toolchain) {
  const result = await runCommand(
    toolchain.ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path
    ],
    { cwd: workRoot }
  )
  const duration = Number(result.stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ffprobe 无法读出 ${path} 的时长`)
  }
  return duration
}

async function assertAudible(path, toolchain) {
  const result = await runCommand(
    toolchain.ffmpeg,
    ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'],
    { cwd: workRoot }
  )
  const output = `${result.stdout}\n${result.stderr}`
  const match = output.match(/max_volume:\s+(-?[\d.]+|-inf)\s+dB/i)
  if (!match) throw new Error(`${path}: 无法用 volumedetect 判断音量`)
  if (match[1].toLowerCase() === '-inf' || Number(match[1]) <= -50) {
    throw new Error(
      `${path}: 渲染出来的音频是静音（max_volume = ${match[1]} dB），请检查谱例是否有音符`
    )
  }
  return Number(match[1])
}

async function renderAudio(block, midiPath, workDirectory, outputDirectory, toolchain) {
  const wavPath = join(workDirectory, 'audio.wav')
  const mp3Path = join(outputDirectory, 'audio.mp3')

  await runCommand(
    toolchain.fluidsynth,
    [
      '-ni',
      '-g',
      '0.85',
      '-r',
      '44100',
      '-o',
      'synth.reverb.active=0',
      '-o',
      'synth.chorus.active=0',
      '-F',
      wavPath,
      toolchain.soundfont,
      midiPath
    ],
    { cwd: workDirectory }
  )
  if (!existsSync(wavPath)) {
    throw new Error(`${block.id}: FluidSynth 没有生成 wav`)
  }
  await runCommand(
    toolchain.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      wavPath,
      '-af',
      'areverse,silenceremove=start_periods=1:start_duration=0.15:start_threshold=-50dB,areverse',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '128k',
      mp3Path
    ],
    { cwd: workDirectory }
  )
  await rm(wavPath, { force: true })

  const mp3Stat = await stat(mp3Path).catch(() => null)
  if (!mp3Stat || mp3Stat.size === 0) {
    throw new Error(`${block.id}: ffmpeg 生成的 MP3 是空文件`)
  }
  const duration = await probeDuration(mp3Path, toolchain)
  if (duration <= 0.5) {
    throw new Error(`${block.id}: 渲染出的音频只有 ${duration}s，短于 0.5s`)
  }
  const maxVolume = await assertAudible(mp3Path, toolchain)
  return {
    duration: Math.round(duration * 1000) / 1000,
    bytes: mp3Stat.size,
    maxVolumeDb: maxVolume
  }
}

// ---------------------------------------------------------------------------
// instrument（只做记录，音频由谱例自身的 %%MIDI / \midiInstrument 决定）
// ---------------------------------------------------------------------------

function detectInstrument(block) {
  if (block.language === 'abc') {
    const programs = [...block.code.matchAll(/^%%MIDI\s+program\s+(\d{1,3})/gim)]
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 127)
    if (programs.length > 0) {
      return { label: `GM program ${programs.join('/')}`, program: programs[0], source: 'score' }
    }
    const named = /^%%MIDI\s+(?:program|voice)\b.*instrument=([^\s%]+)/im.exec(block.code)
    if (named) return { label: named[1], program: null, source: 'score' }
    return { label: 'acoustic grand piano', program: 0, source: 'default' }
  }
  // 两种常见写法：\midiInstrument "violin" 与 \set Staff.midiInstrument = "violin"
  const named = [
    ...block.code.matchAll(
      /(?:\\|\.)midiInstrument\b\s*(?:=\s*)?"([^"]+)"/g
    )
  ].map((match) => match[1])
  if (named.length > 0) {
    const unique = [...new Set(named)]
    return {
      label: unique.length > 1 ? named.join('/') : named[0],
      program: null,
      source: 'score'
    }
  }
  return { label: 'acoustic grand piano', program: 0, source: 'default' }
}

// ---------------------------------------------------------------------------
// 缓存键与产物校验
// ---------------------------------------------------------------------------

function cacheKeyFor(block, probe) {
  return sha256(
    JSON.stringify({
      generator: MANIFEST_GENERATOR,
      generatorVersion: GENERATOR_VERSION,
      language: block.language,
      sourceHash: block.hash,
      versions: probe.versions,
      soundfont: probe.soundfontSha256,
      audio: !options.skipAudio
    })
  )
}

async function readExistingMetadata(outputDirectory) {
  const metadataPath = join(outputDirectory, 'metadata.json')
  if (!existsSync(metadataPath)) return null
  try {
    return JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch {
    return null
  }
}

/** 缓存命中判定：缓存键一致，且所有产物都还在、非空 */
async function reuseArtifacts(block, cacheKey, outputDirectory) {
  if (options.force) return null
  const metadata = await readExistingMetadata(outputDirectory)
  if (!metadata) return null
  if (metadata.cacheKey !== cacheKey) return null
  if (metadata.id !== block.id || metadata.sourceHash !== block.hash) return null
  const names = [...(metadata.svg || []), metadata.audio, metadata.source]
  if (names.some((name) => !name)) return null
  for (const name of names) {
    const path = join(outputDirectory, name)
    if (!existsSync(path)) return null
    const info = await stat(path).catch(() => null)
    if (!info || !info.isFile() || info.size === 0) return null
  }
  return metadata
}

// ---------------------------------------------------------------------------
// 单个谱例块的渲染
// ---------------------------------------------------------------------------

async function renderBlock(block, probe, toolchain) {
  const outputDirectory = join(notationDirectory, block.id)
  const cacheKey = cacheKeyFor(block, probe)
  let metadata = await reuseArtifacts(block, cacheKey, outputDirectory)

  if (metadata) {
    log(`reuse ${block.id}`)
  } else {
    // 重新渲染前清空该目录，避免残留旧的分页 SVG
    await rm(outputDirectory, { recursive: true, force: true })
    await mkdir(outputDirectory, { recursive: true })
    const workDirectory = join(workRoot, 'blocks', block.id)
    await mkdir(workDirectory, { recursive: true })
    log(`compile ${block.id} (${block.language}) ← ${block.sourcePath}:${block.line}`)

    // 1) 排版：先落 SVG，后面的音频失败也不会白跑
    const rendered =
      block.language === 'lilypond'
        ? await renderLilyPondSvg(block, workDirectory, outputDirectory, toolchain, probe.versions)
        : await renderAbcSvg(block, workDirectory, outputDirectory, toolchain)
    log(`  SVG ${rendered.svg.length} 页`)

    metadata = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      generator: MANIFEST_GENERATOR,
      generatorVersion: GENERATOR_VERSION,
      cacheKey,
      id: block.id,
      title: block.title,
      location: block.location,
      status: block.status,
      language: block.language,
      sourceHash: block.hash,
      sourcePath: block.sourcePath,
      line: block.line,
      svg: rendered.svg,
      audio: null,
      source: rendered.sourceName,
      instrument: detectInstrument(block),
      tools: probe.versions
    }

    // 2) 音频：MIDI → wav → mp3
    if (!options.skipAudio) {
      const midiPath =
        block.language === 'lilypond'
          ? await renderLilyPondMidi(block, workDirectory, toolchain, probe.versions)
          : await renderAbcMidi(block, workDirectory, toolchain)
      const audio = await renderAudio(
        block,
        midiPath,
        workDirectory,
        outputDirectory,
        toolchain
      )
      metadata.audio = 'audio.mp3'
      metadata.audioDuration = audio.duration
      metadata.audioBytes = audio.bytes
      metadata.audioMaxVolumeDb = audio.maxVolumeDb
      log(`  音频 ${audio.duration.toFixed(2)}s / ${audio.bytes} 字节`)
    } else {
      log('  跳过音频（--skip-audio）')
    }

    await writeFile(join(outputDirectory, rendered.sourceName), block.code, 'utf8')
  }

  // 标题/位置/id 是围栏属性，不进源码 hash；每次都要用文档里的最新值覆盖
  metadata.title = block.title
  metadata.location = block.location
  metadata.status = block.status
  metadata.sourcePath = block.sourcePath
  metadata.line = block.line
  await writeFile(
    join(outputDirectory, 'metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8'
  )
  return metadata
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function manifestEntry(block, metadata) {
  const url = (name) => `/notation/${block.id}/${name}`
  return {
    hash: block.hash,
    id: block.id,
    language: block.language,
    status: block.status,
    title: block.title,
    location: block.location,
    svg: metadata.svg.map(url),
    audio: metadata.audio ? url(metadata.audio) : null,
    source: url(metadata.source),
    sourcePath: block.sourcePath,
    line: block.line
  }
}

async function writeManifest(entries) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: MANIFEST_GENERATOR,
    blocks: entries
  }
  await writeFile(
    join(notationDirectory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8'
  )
  return manifest
}

/** 删除文档里已经不存在、但磁盘上还留着的旧产物目录 */
async function removeStaleDirectories(activeIds) {
  for (const entry of await readdir(notationDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (activeIds.has(entry.name)) continue
    const stale = resolve(notationDirectory, entry.name)
    if (!stale.startsWith(`${notationDirectory}${sep}`)) {
      throw new Error(`拒绝删除谱例目录之外的路径：${stale}`)
    }
    log(`清理过期产物：${entry.name}`)
    await rm(stale, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// --check 校验
// ---------------------------------------------------------------------------

function notationUrlParts(url, expectedId) {
  const parts = String(url || '').split('/').filter(Boolean)
  if (parts.length !== 3 || parts[0] !== 'notation') {
    throw new Error(`产物路径必须形如 /notation/<id>/<file>，实际是：${url}`)
  }
  if (parts[1] !== expectedId) {
    throw new Error(`产物路径的 id 与谱例 id 不一致：${url}`)
  }
  return parts[2]
}

async function assertArtifact(path, label) {
  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile()) throw new Error(`${label} 不存在：${path}`)
  if (info.size === 0) throw new Error(`${label} 是空文件：${path}`)
  return info.size
}

async function validateManifest(blocks) {
  const manifestPath = join(notationDirectory, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到 manifest：${manifestPath}（先运行一次渲染）`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `manifest schemaVersion 是 ${manifest.schemaVersion}，脚本期望 ${MANIFEST_SCHEMA_VERSION}`
    )
  }
  if (!Array.isArray(manifest.blocks)) {
    throw new Error('manifest 缺少 blocks 数组')
  }
  if (manifest.blocks.length !== blocks.length) {
    throw new Error(
      `manifest 里有 ${manifest.blocks.length} 个谱例，文档里现在是 ${blocks.length} 个`
    )
  }

  const expectedByHash = new Map(blocks.map((block) => [block.hash, block]))
  const seen = new Set()
  let audioMissing = 0
  for (const entry of manifest.blocks) {
    const block = expectedByHash.get(entry.hash)
    if (!block) {
      throw new Error(
        `manifest 里的谱例在文档中找不到：${entry.id}（hash ${String(entry.hash).slice(0, 12)}…）`
      )
    }
    if (seen.has(entry.hash)) {
      throw new Error(`manifest 里出现重复的谱例：${entry.id}`)
    }
    seen.add(entry.hash)

    const mismatches = []
    if (entry.id !== block.id) mismatches.push(`id（manifest=${entry.id}，文档=${block.id}）`)
    if (entry.language !== block.language) mismatches.push('language')
    if (entry.title !== block.title) mismatches.push(`title（${entry.title} ≠ ${block.title}）`)
    if (entry.location !== block.location) mismatches.push('location')
    if (entry.sourcePath !== block.sourcePath) mismatches.push('sourcePath')
    if (entry.line !== block.line) mismatches.push(`line（${entry.line} ≠ ${block.line}）`)
    if (entry.status !== block.status) mismatches.push('status')
    if (mismatches.length > 0) {
      throw new Error(
        `${block.sourcePath}:${block.line} 的 manifest 元数据不一致：${mismatches.join('、')}`
      )
    }

    if (!Array.isArray(entry.svg) || entry.svg.length === 0) {
      throw new Error(`${entry.id}: manifest 里没有 svg 列表`)
    }
    const outputDirectory = join(notationDirectory, entry.id)
    for (const url of [...entry.svg, entry.source]) {
      const name = notationUrlParts(url, entry.id)
      await assertArtifact(join(outputDirectory, name), `${entry.id}/${name}`)
    }
    if (entry.audio === null || entry.audio === undefined) {
      audioMissing += 1
    } else {
      const name = notationUrlParts(entry.audio, entry.id)
      await assertArtifact(join(outputDirectory, name), `${entry.id}/${name}`)
    }
    const metadata = await readExistingMetadata(outputDirectory)
    if (!metadata) throw new Error(`${entry.id}: 缺少 metadata.json`)
    if (metadata.sourceHash !== entry.hash) {
      throw new Error(`${entry.id}: metadata.json 的 sourceHash 与 manifest 不一致`)
    }
    if (metadata.id !== entry.id) {
      throw new Error(`${entry.id}: metadata.json 的 id 与 manifest 不一致`)
    }
  }

  // 反向检查：文档里的每个谱例都必须在 manifest 里
  for (const block of blocks) {
    if (!seen.has(block.hash)) {
      throw new Error(`文档里的谱例没有进 manifest：${block.sourcePath}:${block.line}（${block.id}）`)
    }
  }

  if (audioMissing > 0) {
    log(
      `注意：有 ${audioMissing} 个块没有 audio（--skip-audio 预览产物），提交前请正常渲染一次。`
    )
  }
  console.log(`manifest validated: ${blocks.length} blocks`)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (options.help) {
    printHelp()
    return
  }
  log(
    [
      `${options.check ? '校验' : '渲染'}谱例`,
      `  文档目录：${docsDirectory}`,
      `  产物目录：${notationDirectory}`,
      ...(options.skipAudio ? ['  模式：--skip-audio（只出 SVG，不生成 MP3）'] : [])
    ].join('\n')
  )

  workRoot = await mkdtemp(join(tmpdir(), 'render-notation-'))
  logDirectory = join(workRoot, 'logs')
  await mkdir(logDirectory, { recursive: true })
  await mkdir(join(workRoot, 'blocks'), { recursive: true })

  try {
    const blocks = await collectBlocks()
    log(`发现 ${blocks.length} 个谱例`)

    if (options.check) {
      await validateManifest(blocks)
      return
    }

    const toolchain = resolveToolchain()
    const probe = await probeToolchain(toolchain, { audio: !options.skipAudio })

    await mkdir(notationDirectory, { recursive: true })
    const entries = []
    for (const block of blocks) {
      const metadata = await renderBlock(block, probe, toolchain)
      entries.push(manifestEntry(block, metadata))
    }
    await removeStaleDirectories(new Set(blocks.map((block) => block.id)))
    await writeManifest(entries)
    log(
      `完成：${entries.length} 个谱例，manifest 写入 ` +
        toPosix(relative(process.cwd(), join(notationDirectory, 'manifest.json')))
    )
    if (options.skipAudio) {
      log('提醒：--skip-audio 产出的 manifest 里 audio 为 null，只适合本地预览，不要提交。')
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(`\n渲染失败：${error.message}`)
  process.exitCode = 1
})
