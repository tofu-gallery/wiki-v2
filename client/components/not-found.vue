<template lang='pug'>
  v-app
    .notfound
      .notfound-content
        img.animated.fadeIn(src='/_assets/svg/icon-delete-file.svg', alt='Not Found')
        .headline {{$t('notfound.title')}}
        .subheading.mt-3 {{$t('notfound.subtitle')}}
        v-btn.mt-5(color='red lighten-4', href='/', large, outlined)
          v-icon(left) mdi-home
          span {{$t('notfound.gohome')}}
        //- Tofu (2026-10-25): modified by Tofu for its app gallery: this copy's own source (AGPL).
        .caption.mt-8
          tofu-source-link
</template>

<script>
import TofuSourceLink from './common/tofu-source-link.vue'

export default {
  components: {
    TofuSourceLink
  },
  data() {
    return { }
  }
}
</script>

<style lang='scss'>

</style>
