// 应用入口：挂载 Vue 根组件，引入全局样式
import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

createApp(App).mount('#app')
