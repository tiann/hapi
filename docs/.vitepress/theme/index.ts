import DefaultTheme from 'vitepress/theme'
import Steps from './components/Steps.vue'
import type { Theme } from 'vitepress'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Steps', Steps)
  }
} satisfies Theme
