import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "OpenCadenza",
  description: "Docs for OpenCadenza",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Opusloom', link: '/opusloom/introducing-to-opusloom' }
    ],

    sidebar: [
      {
        text: 'Opusloom 智能乐谱交流平台',
        items: [
          { text: 'Opusloom 简介', link: '/opusloom/introducing-to-opusloom' }
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
