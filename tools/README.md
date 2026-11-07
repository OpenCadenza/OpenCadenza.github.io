# 谱例预渲染（本地工具）

文档里的 ABC / LilyPond 代码块会在页面上配一个播放器：乐谱（SVG）与试听（MP3）。
这些产物**不在 CI 里生成**，而是在本地用本目录的脚本预渲染后随仓库提交，
所以 GitHub Actions 只需要 `npm ci && npm run docs:build`，不必安装 LilyPond 等重型工具链。

## 工作方式

1. 在 Markdown 里写一个带属性的围栏代码块：

   ````markdown
   ```abc title="肖邦 夜曲 Op.9 No.2" location="开头 5 小节" id="chopin-op9-no2-opening"
   X: 1
   ...
   ```
   ````

   - `title`、`location` 会显示在播放器标题栏；`id` 决定产物目录名（不写则按路径自动生成）。
   - 围栏正文的 `sha256` 是这块谱例的唯一键，产物与它绑定。

2. 本地跑一次渲染脚本：

   ```powershell
   node tools/render-notation.mjs
   ```

   产物写到 `docs/public/notation/<id>/`（`page-N.svg`、`audio.mp3`、`source.abc` / `source.ly`、`metadata.json`），
   并在 `docs/public/notation/manifest.json` 登记。

3. 提交 `docs/public/notation/` 一起入库。站点构建时，`docs/.vitepress/config.mts` 的围栏插件
   会按正文哈希查 manifest，把代码块渲染出来并在其后挂上 `ScoreExample` 播放器。

**改过谱例就必须重跑渲染**：围栏正文一改，哈希就变；构建时会直接报错提示
「谱例尚未渲染」，这是故意的，避免页面出现与源码不一致的乐谱。

校验已提交产物与文档是否仍然对得上：

```powershell
node tools/render-notation.mjs --check
```

## 本地依赖

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 20+ | 脚本零 npm 依赖；ABC 排版需要 `abc2svg` 包 |
| LilyPond | 2.26.0 | 排版与 MIDI 都靠它，版本写在 `\version` 里 |
| abc2svg | 1.22.x | ABC → SVG。可 `npm i -D abc2svg@1.22.1`，或设 `ABC2SVG_PATH` |
| abc2midi | abcMIDI 5.07+ | ABC → MIDI。**Windows 上必须是原生构建**，Cosmopolitan/APE 版本在 Windows 无法执行 |
| FluidSynth | 2.6.x | MIDI → wav，需配 FluidR3_GM.sf2 声库 |
| ffmpeg / ffprobe | 8.x | wav → mp3，并做时长与响度校验 |

所有工具路径都可以用环境变量覆盖，脚本默认按 `PATH` 与仓库内 `.tools/` 查找：

| 变量 | 用途 |
| --- | --- |
| `LILYPOND_PATH` | `lilypond` 可执行文件 |
| `ABC2MIDI_PATH` | `abc2midi` 可执行文件 |
| `ABC2SVG_PATH` | `abc2svg` 脚本（默认 `<repo>/node_modules/abc2svg/abc2svg`） |
| `FLUIDSYNTH_PATH` | `fluidsynth` 可执行文件 |
| `SOUNDFONT_PATH` | `.sf2` 声库（FluidR3 GM） |
| `FFMPEG_PATH` / `FFPROBE_PATH` | ffmpeg / ffprobe |

## 关于来源与许可

谱例产物（`docs/public/notation/` 下的文件）是排版与音频渲染结果，来源、版本与许可登记在
`docs/i-score/Technical-feasibility.md` 的「谱例来源」一节；新增谱例时请一并补充。

## 常见问题

- **`abc2midi` 报 `File open failed` 但不缺文件**：个别受限环境里它能读输入、却写不了系统临时目录。
  把 `TEMP` / `TMP` 指向仓库内的一个目录再跑即可，例如
  `$env:TEMP = "$PWD\.notation-work"`（该目录不需要提交）。
- **`abc2midi` 退出码是 1 但生成了 MIDI**：这是它把「小节时值与拍号不符」之类的问题当错误报，
  产物是完整的。脚本以「MIDI 是否可用」为准，只把退出码写进日志。
- **Windows 上现成的 abc2midi 跑不起来**：部分分发包是 Cosmopolitan/APE 格式，在 Windows 上会静默失败或挂起。
  用源码自建（`gcc -DANSILIBS -O2 -DHAVE_CONFIG_H -I. -o abc2midi.exe parseabc.c store.c genmidi.c midifile.c queues.c parser2.c stresspat.c music_utils.c -lm`）
  或用官方 Windows 构建。
- **只想先看排版**：`node tools/render-notation.mjs --skip-audio` 只出 SVG（manifest 里 `audio` 为 `null`，别提交）。

