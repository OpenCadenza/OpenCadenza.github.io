<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

// 与 music-wiki 的播放器保持一致：图标沿用 Lucide 的路径数据，
// 内联成组件以免为这个页面引入额外的运行时依赖。
const ICON_PATHS: Record<string, string[]> = {
  play: ['M6 3l14 9-14 9V3z'],
  pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
  restart: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  volume: [
    'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z',
    'M16 9a5 5 0 0 1 0 6',
    'M19.4 18.4a9 9 0 0 0 0-12.8'
  ],
  mute: [
    'M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z',
    'm22 9-6 6',
    'm16 9 6 6'
  ],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6']
}

const Icon = (props: { name: string; size?: number }) =>
  h(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width: props.size ?? 18,
      height: props.size ?? 18,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true'
    },
    (ICON_PATHS[props.name] || []).map((d) => h('path', { d }))
  )

const props = defineProps<{
  id: string
  title: string
  location: string
  language: 'abc' | 'lilypond'
  status: 'published' | 'draft'
  svg: string
  audio: string
  source: string
}>()

const audioElement = ref<HTMLAudioElement>()
const playing = ref(false)
const muted = ref(false)
const duration = ref(0)
const currentTime = ref(0)
const loadError = ref(false)
const playbackEventName = 'music-wiki:exclusive-playback'
const playerToken = Symbol(props.id)

const svgUrls = computed(() =>
  props.svg
    .split('|')
    .filter(Boolean)
    .map((path) => withBase(path))
)
const audioUrl = computed(() => withBase(props.audio))
const sourceUrl = computed(() => withBase(props.source))
const progress = computed(() =>
  duration.value > 0 ? (currentTime.value / duration.value) * 100 : 0
)
const fullTitle = computed(() =>
  props.location ? `${props.title}，${props.location}` : props.title
)

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function pauseOtherPlayers() {
  window.dispatchEvent(
    new CustomEvent(playbackEventName, { detail: { owner: playerToken } })
  )
}

function handleExclusivePlayback(event: Event) {
  const owner = (event as CustomEvent<{ owner: symbol }>).detail?.owner
  if (owner !== playerToken) audioElement.value?.pause()
}

async function startPlayback(rewind = false) {
  const audio = audioElement.value
  if (!audio) return
  if (rewind) audio.currentTime = 0
  pauseOtherPlayers()
  try {
    await audio.play()
  } catch {
    loadError.value = true
  }
}

async function togglePlayback() {
  const audio = audioElement.value
  if (!audio) return
  if (audio.paused) await startPlayback()
  else audio.pause()
}

function seek(event: Event) {
  const audio = audioElement.value
  if (!audio || duration.value <= 0) return
  const value = Number((event.target as HTMLInputElement).value)
  audio.currentTime = (value / 100) * duration.value
}

function restart() {
  void startPlayback(true)
}

function toggleMute() {
  const audio = audioElement.value
  if (!audio) return
  audio.muted = !audio.muted
  muted.value = audio.muted
}

function syncAudioMetadata() {
  const audio = audioElement.value
  if (!audio) return
  if (Number.isFinite(audio.duration)) duration.value = audio.duration
  currentTime.value = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
  loadError.value = false
}

onMounted(() => {
  const audio = audioElement.value
  if (!audio) return
  window.addEventListener(playbackEventName, handleExclusivePlayback)
  audio.addEventListener('durationchange', syncAudioMetadata)
  audio.addEventListener('loadeddata', syncAudioMetadata)
  syncAudioMetadata()
})

onBeforeUnmount(() => {
  window.removeEventListener(playbackEventName, handleExclusivePlayback)
  audioElement.value?.pause()
})
</script>

<template>
  <figure class="score-example" :data-score-id="id">
    <figcaption>
      <span class="score-title">
        <span>{{ title }}</span>
        <span v-if="location" class="score-location">{{ location }}</span>
      </span>
      <span class="score-meta">
        <span v-if="status === 'draft'" class="score-status">草稿</span>
        <span class="score-format">{{ language === 'abc' ? 'ABC' : 'LilyPond 2.26.0' }}</span>
      </span>
    </figcaption>

    <div class="score-sheet">
      <a
        v-for="(svgUrl, pageIndex) in svgUrls"
        :key="svgUrl"
        class="score-page"
        :href="svgUrl"
        target="_blank"
        rel="noreferrer"
      >
        <img :src="svgUrl" :alt="`${fullTitle} 乐谱第 ${pageIndex + 1} 页`" loading="lazy" />
        <span class="score-open" aria-hidden="true"><Icon name="external" :size="16" /></span>
      </a>
    </div>

    <div class="score-controls" aria-label="音频播放">
      <button class="control-button primary" type="button" :aria-label="playing ? '暂停' : '播放'" @click="togglePlayback">
        <Icon v-if="playing" name="pause" />
        <Icon v-else name="play" />
      </button>
      <button class="control-button" type="button" aria-label="从头播放" @click="restart">
        <Icon name="restart" :size="17" />
      </button>
      <span class="score-time">{{ formatTime(currentTime) }}</span>
      <input
        class="score-progress"
        type="range"
        min="0"
        max="100"
        step="0.1"
        :value="progress"
        aria-label="播放进度"
        @input="seek"
      />
      <span class="score-time">{{ formatTime(duration) }}</span>
      <button class="control-button" type="button" :aria-label="muted ? '取消静音' : '静音'" @click="toggleMute">
        <Icon v-if="muted" name="mute" :size="17" />
        <Icon v-else name="volume" :size="17" />
      </button>
      <a class="control-button" :href="audioUrl" download aria-label="下载音频">
        <Icon name="download" :size="17" />
      </a>
      <a class="score-source" :href="sourceUrl" target="_blank" rel="noreferrer">源码</a>
    </div>

    <p v-if="loadError" class="score-error">音频未能载入。</p>

    <audio
      ref="audioElement"
      class="score-audio-element"
      :src="audioUrl"
      preload="metadata"
      @durationchange="syncAudioMetadata"
      @play="pauseOtherPlayers(); playing = true"
      @pause="playing = false"
      @ended="playing = false"
      @loadedmetadata="syncAudioMetadata"
      @loadeddata="syncAudioMetadata"
      @timeupdate="currentTime = $event.currentTarget.currentTime"
      @error="loadError = true"
    />
  </figure>
</template>
