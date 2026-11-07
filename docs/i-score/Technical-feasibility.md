---
title: 为什么让大语言模型写乐谱？
description: 用真实谱例认识 ABC 与 LilyPond，理解 LLM 符号音乐创作的优势、局限和研究方向。
---

# 为什么让大语言模型写乐谱？

如今的 AI 已经能够直接生成音乐音频。那么，为什么 I-score 还要探索让大语言模型（LLM）“写乐谱”？

答案在于：**我们不仅想听到一段音乐，也希望能够读懂它、修改它，并与 AI 讨论它是怎样写成的。**

## 乐谱也可以是一段文字

我们熟悉的五线谱看起来是图形，但音符、节奏、拍号和乐器等信息，其实也可以用文字表示。

### ABC：像写字母一样记录旋律

[ABC notation](https://abcnotation.com/) 是一种轻量的文本记谱方式。下面这段文字是肖邦《夜曲》Op.9 No.2 的开头：先读源码，再看它渲染出来的乐谱与声音。

```abc title="肖邦 夜曲 Op.9 No.2" location="开头 4 小节（含弱起）" id="chopin-op9-no2-opening"
X: 1
T: Nocturne No. 2, Op. 9
C: Fryderyk Chopin
M: 12/8
L: 1/8
Q: "Andante" 3/8=138
%%staves {1 2}
%%linebreak <none>
%%pagewidth 680px
V: 1 clef=treble
V: 2 clef=bass
K: Eb
[V:1] B |
[V:2] z |
[V:1] g2>-g2fg2<f2e2B |
[V:2] .E,,[EG,][GEB,] .E,[DA,][AD_C] .E,,[EG,][GEB,] .D,,[EG,][GEB,] |
[V:1] g2cc'2g2<b2a2g |
[V:2] C,,[=EG,][GEB,] C,[EG,][BEC] F,,[_DF,][EDB,] F,,[CF,][FCA,] |
[V:1] f3g2d2<e2c3 |
[V:2] B,,[DF,][ADB,] =B,,[FG,][GFD] C,[EG,][GEC] =A,,[E_G,][_GEC] |
[V:1] Bd'c' b/a/g/a/c/d/e3z2B |
[V:2] B,,[EF,][AEB,] B,,,[DF,][AB,] E,,[E=G,][=GEB,] E,[EG,][GEB,] |
```

不必学会全部语法，也能看出其中的规律：`K: Eb` 说明这是降 E 大调，`M: 12/8` 是拍号，`g2` 里的字母是音高、数字是时值，竖线表示小节的分隔，`[V:2]` 开始的是左手伴奏声部。这几行纯文本经过工具处理，就变成了上面那份可以播放的五线谱。

ABC 的表示方式紧凑，特别适合描述旋律和相对简单的乐谱。

### LilyPond：用文字描述更复杂的乐谱

[LilyPond](https://lilypond.org/) 同样采用文本输入，但更强调专业乐谱排版，能够表达多声部、多乐器以及丰富的音乐记号。

下面这段是贝多芬《弦乐四重奏》Op.18 No.4 第一乐章的开头。四件乐器各占一条谱表，力度、装饰音、弱起小节也都写在文本里：

```lilypond title="贝多芬 弦乐四重奏 Op.18 No.4 第一乐章" location="开头 4 小节（含弱起）" id="beethoven-op18-no4-i-opening"
\version "2.26.0"
\language "english"

\score {
  \new StaffGroup <<
    \new Staff = "v1" {
      \set Staff.midiInstrument = "violin"
      % GM 40
      \clef treble \key c \minor \time 4/4 \tempo 4 = 138 \partial 4
  % m.0
  g4 \p
  % m.1
  c'2 ~ c'8 [ \grace { d'16 [ ( c' b ] ) } c'8 ( ef' d' ) ] |
  % m.2
  d'2 \sf ( c'4 \staccato ) c'4 |
  % m.3
  f'2 ~ f'8 [ \grace { g'16 [ ( f' e' ] ) } f'8 ( af' g' ) ] |
  % m.4
  g'2 \sf ( f'4 \staccato ) f'4 \bar "|."
    }
    \new Staff = "v2" {
      \set Staff.midiInstrument = "violin"
      % GM 40
      \clef treble \key c \minor \time 4/4 \partial 4
  % m.0
  r4
  % m.1
  g2. \p ( b4 ) |
  % m.2
  b2 \sf ( g4 \staccato ) r |
  % m.3
  c'2. ( e'4 ) |
  % m.4
  e'2 \sf ( c'4 \staccato ) r \bar "|."
    }
    \new Staff = "va" {
      \set Staff.midiInstrument = "viola"
      % GM 41
      \clef alto \key c \minor \time 4/4 \partial 4
  % m.0
  r4
  % m.1
  ef2. \p ( f4 ) |
  % m.2
  af4. \sf ( f8 ) ef4 \staccato r |
  % m.3
  af2. ( bf4 ) |
  % m.4
  df'4. \sf ( bf8 ) af4 \staccato r4 \bar "|."
    }
    \new Staff = "vc" {
      \set Staff.midiInstrument = "cello"
      % GM 42
      \clef bass \key c \minor \time 4/4 \partial 4
  % m.0
  r4
  % m.1
  c,8 \p c c c c c c c |
  % m.2
  c8 \sf c c c c c c c |
  % m.3
  c,8 c c c c c c c |
  % m.4
  c8 \sf c c c c c c c \bar "|."
    }
  >>
  \layout { }
  \midi { }
}
```

在这里，字母仍表示音符，数字描述时值；`\new Staff` 为一件乐器新开一条谱表，`\clef` 是谱号，`\p` 与 `\sf` 是力度，`\grace` 是装饰音，`\partial 4` 表示开头只有一拍的弱起。经过处理后，文本就能转化为排版整齐的乐谱。

两种语言的写法不同，却有一个重要的共同点：**音乐被表示为结构清晰、可以直接编辑的文本。** 

## 为什么这条路线适合 LLM？

大语言模型的核心能力之一，就是理解并生成有规则的文本。它们不仅能写自然语言，也可以编写程序代码、修改已有文件、根据要求调整结构。

ABC 和 LilyPond 为音乐提供了类似的入口：

- **可以描述具体要求**：例如“改成三拍子”“让小提琴演奏旋律”“在结尾重现开头主题”。
- **可以局部修改**：不必每次从头生成整部作品，而是针对某个段落或声部调整。
- **可以检查明确的规则**：乐谱是否能正常处理、节拍是否一致、乐器与音域是否符合要求等，都有机会借助工具验证。
- **方便观察结构**：创作者可以直接查看音符、乐章和声部，而不只是凭听觉判断结果。

这不意味着 LLM 天然“懂音乐”，而是说：**文本乐谱让 LLM 的语言与代码处理能力，有机会进入真正可编辑的音乐创作过程。**

## 能写出乐谱，不等于会作曲

目前这条路线仍有明显的挑战。

**首先，语法正确不代表音乐好听。** 一份乐谱即使能够顺利显示和播放，也可能缺少有感染力的旋律、自然的和声或合理的声部进行。

**其次，长篇音乐更难。** 写出几小节动听的旋律，与完成一部主题发展连贯、各乐章相互呼应的奏鸣曲，是两种不同的难度。

**再者，音乐风格不只是表面模仿。** 想写出具有古典、浪漫或印象派特点的作品，不能只依赖几种常见和弦；还需要理解曲式、织体、节奏、动机发展和审美表达。

对位、配器与演奏可行性，也都可能给 AI 带来困难。自动检查能发现某些明确错误，却不能代替音乐家的艺术判断。

## 我们希望研究的三个方向

针对这些问题，I-score 希望逐步探索三个互相补充的方向。

### 1. 音乐知识库：让 AI 有专业资料可查

人类作曲家会学习和声、曲式、对位、配器，也会研究大量作品。OpenCadenza 正在持续构建面向人和 AI 的[音乐知识库](./Music-wiki.md)，让创作助手在需要时能够参考相关概念、规则与谱例，而不是只依赖模型原有的知识。

### 2. 创作 Agent：让 AI 学会规划、检查与修改

一次回答往往难以完成复杂作品。我们希望研究如何让 AI 创作助手先理解目标、构思音乐结构，再逐步完成乐谱，并结合检查和修改不断完善作品。

这里的研究重点不仅是“写出音符”，更是让 Agent 更善于安排创作步骤、使用音乐工具，以及与人持续协作。

### 3. 音乐领域的自回归模型训练与优化

通用大语言模型面对专业音乐任务时仍有局限。更长远地，我们希望探索面向符号音乐的模型训练与能力优化，使模型更好地理解记谱语言、音乐结构和创作指令。

这是我们长期的研究方向，持续探索模型能否在复杂曲式、复调写作与艺术表现上真正进步。

## 音乐与技术，需要彼此交流

AI 能够帮助我们更快地尝试音乐想法；但要判断一部作品是否成熟，仍离不开音乐知识、审美经验和真实的聆听。

如果你擅长乐理、演奏、作曲，或对 LLM 与 Agent 技术感兴趣，欢迎加入 OpenCadenza，一起讨论和建设。

## 谱例来源

本页两段谱例只截取作品开头数小节，用于说明文本记谱的表达方式。

- ABC 谱例取自肖邦初版数字版（NIFC，[`humdrum-chopin-first-editions`](https://github.com/pl-wnifc/humdrum-chopin-first-editions)），许可 CC BY 4.0；作品本身已进入公有领域。
- LilyPond 谱例取自 [Mutopia Project](https://www.mutopiaproject.org/ftp/BeethovenLv/O18/QuartetOpus18_No4_1/) 的贝多芬 Op.18 No.4 排版（Breitkopf & Härtel 1862–1865 年版，排版 Stelios Samelis），公有领域；本页只把原始编码迁移到 LilyPond 2.26.0 并截取开头小节。

了解更多：[项目总览](./index.md) · [创作与分享平台](./introducing-i-score.md) · [音乐知识库](./Music-wiki.md)
