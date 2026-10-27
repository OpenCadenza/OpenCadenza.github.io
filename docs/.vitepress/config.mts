import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "OpenCadenza",
  description: "Docs for OpenCadenza",
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
      },
      {
        text: '（旧）Opus-No0 Hackathon',
        items: [
          { text: '分工', link: '/opus-no0-notes/v1-0123' }
        ]
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/OpenCadenza' }
    ]
  }
})
