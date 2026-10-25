<template lang='pug'>
  v-app
    .onboarding
      .onboarding-content
        img.animated.fadeIn(src='/_assets/svg/logo-wikijs.svg', alt='Wiki.js')
        .headline.animated.fadeInUp {{ $t('welcome.title') }}
        .subtitle-1.mt-3.animated.fadeInUp.wait-p1s {{ $t('welcome.subtitle') }}
        div
          v-btn.mt-5.mx-3.animated.fadeInUp.wait-p2s(color='primary', :href='`/e/` + locale + `/home`', x-large)
            v-icon(left) mdi-plus
            span {{ $t('welcome.createhome') }}
          v-btn.mt-5.mx-3.animated.fadeInUp.wait-p3s(color='primary', href='/a', x-large)
            v-icon(left) mdi-view-dashboard
            span {{ $t('welcome.goadmin') }}
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
  props: {
    locale: {
      type: String,
      default: 'en'
    }
  },
  data() {
    return { }
  }
}
</script>

<style lang='scss'>

</style>
