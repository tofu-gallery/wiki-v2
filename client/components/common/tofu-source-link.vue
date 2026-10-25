<template lang="pug">
  //- Tofu (2026-10-25): this file is Tofu's addition; it is not part of upstream Wiki.js.
  //- This copy's own source, which the AGPL offers to everyone who uses it: the address in SOURCE_URL, which Tofu's
  //- gallery sets to the pinned commit a copy was made from, else Tofu's fork (server/master.js, server/setup.js).
  a.tofu-source-link(:href='url', rel='noopener') Source code
</template>

<script>
/* global siteConfig */

const FORK = 'https://github.com/tofu-gallery/wiki-v2/tree/tofu'

export default {
  props: {
    hrefOverride: {
      type: String,
      default: ''
    }
  },
  computed: {
    url () {
      const configured = (typeof siteConfig !== 'undefined' && siteConfig) ? siteConfig.sourceUrl : ''
      return this.hrefOverride || configured || FORK
    }
  }
}
</script>

<style lang="scss">
a.tofu-source-link {
  color: inherit !important;
  text-decoration: underline !important;
}
</style>
