---
layout: home
title: HAPI Documentation
---

<script setup>
import { onMounted } from 'vue'
import { useRouter } from 'vitepress'

onMounted(() => {
  const router = useRouter()
  router.go('/guide/quick-start')
})
</script>
