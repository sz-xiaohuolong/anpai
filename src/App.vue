<script setup lang="ts">
import { useRoute } from './app/router.ts'
import HomeView from './views/HomeView.vue'
import RoomView from './views/RoomView.vue'
import PlayView from './views/PlayView.vue'

const route = useRoute()
</script>

<template>
  <HomeView v-if="route.name === 'home'" />
  <RoomView v-else-if="route.name === 'room'" :key="route.code" :code="route.code" />
  <PlayView v-else-if="route.name === 'play'" :key="`play-${route.code}`" :code="route.code" />
</template>
