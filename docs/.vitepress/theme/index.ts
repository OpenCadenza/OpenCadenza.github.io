import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import ScoreExample from './ScoreExample.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ScoreExample', ScoreExample)
  }
} satisfies Theme
