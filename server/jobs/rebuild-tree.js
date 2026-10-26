const _ = require('lodash')

/* global WIKI */

module.exports = async (pageId) => {
  WIKI.logger.info(`Rebuilding page tree...`)

  try {
    WIKI.models = require('../core/db').init()
    await WIKI.configSvc.loadFromDb()
    await WIKI.configSvc.applyFlags()

    const pages = await WIKI.models.pages.query().select('id', 'path', 'localeCode', 'title', 'isPrivate', 'privateNS').orderBy(['localeCode', 'path'])
    let tree = []
    let pik = 0

    for (const page of pages) {
      const pagePaths = page.path.split('/')
      let currentPath = ''
      let depth = 0
      let parentId = null
      let ancestors = []
      for (const part of pagePaths) {
        depth++
        const isFolder = (depth < pagePaths.length)
        currentPath = currentPath ? `${currentPath}/${part}` : part
        const found = _.find(tree, {
          localeCode: page.localeCode,
          path: currentPath
        })
        if (!found) {
          pik++
          tree.push({
            id: pik,
            localeCode: page.localeCode,
            path: currentPath,
            depth: depth,
            title: isFolder ? part : page.title,
            isFolder: isFolder,
            isPrivate: !isFolder && page.isPrivate,
            privateNS: !isFolder ? page.privateNS : null,
            parent: parentId,
            pageId: isFolder ? null : page.id,
            ancestors: JSON.stringify(ancestors)
          })
          parentId = pik
        } else if (isFolder && !found.isFolder) {
          found.isFolder = true
          parentId = found.id
        } else {
          parentId = found.id
        }
        ancestors.push(parentId)
      }
    }

    // Tofu (2026-10-26): modified by Tofu for its app gallery: on PostgreSQL the tree is replaced in one transaction that
    // first takes the page tree's advisory lock (server/db/tofu-data-api.js). Every start runs this job, so several
    // servers starting at once (as Tofu's hosting does) replaced it at the same moment, and all but one failed on rows
    // another had just inserted (pageTree_pkey). Upstream ran the same statements on WIKI.models.knex, one at a time.
    const replaceTree = async (knex) => {
      await knex.table('pageTree').truncate()
      if (tree.length > 0) {
        // -> Save in chunks, because of per query max parameters (35k Postgres, 2k MSSQL, 1k for SQLite)
        if ((WIKI.config.db.type !== 'sqlite')) {
          for (const chunk of _.chunk(tree, 100)) {
            await knex.table('pageTree').insert(chunk)
          }
        } else {
          for (const chunk of _.chunk(tree, 60)) {
            await knex.table('pageTree').insert(chunk)
          }
        }
      }
    }
    if (WIKI.config.db.type === 'postgres') {
      await WIKI.models.knex.transaction(async trx => {
        await require('../db/tofu-data-api').lockPageTree(trx)
        await replaceTree(trx)
      })
    } else {
      await replaceTree(WIKI.models.knex)
    }

    await WIKI.models.knex.destroy()

    WIKI.logger.info(`Rebuilding page tree: [ COMPLETED ]`)
  } catch (err) {
    WIKI.logger.error(`Rebuilding page tree: [ FAILED ]`)
    WIKI.logger.error(err.message)
    // exit process with error code
    throw err
  }
}
