const path = require('path')
const { v4: uuid } = require('uuid')
const bodyParser = require('body-parser')
const compression = require('compression')
const express = require('express')
const favicon = require('serve-favicon')
const http = require('http')
const fs = require('fs-extra')
const _ = require('lodash')
const crypto = require('crypto')
const pem2jwk = require('pem-jwk').pem2jwk
const semver = require('semver')

const randomBytesAsync = require('util').promisify(crypto.randomBytes)

// Tofu (2026-10-25): modified by Tofu for its app gallery: the setup only finishes with its owner's ADMIN_PASSWORD,
// telemetry stays off, and the page links this copy's own source.

/* global WIKI */

module.exports = () => {
  WIKI.config.site = {
    path: '',
    title: 'Wiki.js'
  }

  WIKI.system = require('./core/system')

  // ----------------------------------------
  // Tofu (2026-10-25): the setup only finishes for the wiki's owner
  // ----------------------------------------
  // On Tofu a new copy is online before its owner first opens it, and upstream's setup makes whoever finishes it first
  // the administrator. Here it only finishes with the password the owner saved as the hidden value ADMIN_PASSWORD,
  // which becomes the administrator's password. Without one, or with one shorter than 8 characters, the page only says
  // what the owner has to do. Ten wrong passwords in a row close the setup for 15 minutes.

  const ownerPassword = process.env.ADMIN_PASSWORD || ''
  const setupLock = ownerPassword.length === 0 ? 'missing' : (ownerPassword.length < 8 ? 'short' : '')
  const sourceUrl = process.env.SOURCE_URL || 'https://github.com/tofu-gallery/wiki-v2/tree/tofu'
  const guard = { failures: 0, closedUntil: 0 }
  const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest()

  async function ownerRefusal (body) {
    if (setupLock === 'missing') {
      return 'This wiki is waiting for its owner. To finish setting it up, its owner saves a password as ADMIN_PASSWORD on the app’s Keys & settings page in Tofu, with Hide this value after saving on, and deploys the app again.'
    }
    if (setupLock === 'short') {
      return 'ADMIN_PASSWORD has to be at least 8 characters long. The owner saves a longer one on the app’s Keys & settings page in Tofu and deploys the app again.'
    }
    if (Date.now() < guard.closedUntil) {
      return 'Too many wrong passwords. Try again in 15 minutes.'
    }
    const given = _.get(body, 'adminPassword')
    if (_.isString(given) && crypto.timingSafeEqual(sha256(given), sha256(ownerPassword))) {
      guard.failures = 0
      return null
    }
    guard.failures++
    if (guard.failures >= 10) {
      guard.failures = 0
      guard.closedUntil = Date.now() + 15 * 60 * 1000
    }
    WIKI.logger.warn('Setup refused: the password given is not this wiki’s ADMIN_PASSWORD.')
    await new Promise(resolve => setTimeout(resolve, 1000))
    return 'That is not the password saved as ADMIN_PASSWORD for this wiki. Use the one its owner saved on the app’s Keys & settings page in Tofu.'
  }

  if (setupLock) {
    WIKI.logger.warn('Setup waits for ADMIN_PASSWORD: the owner saves it as a hidden value of at least 8 characters, then deploys again.')
  }

  // ----------------------------------------
  // Tofu (2026-10-26): more than one server
  // ----------------------------------------
  // Tofu's hosting can run several servers of the same wiki, which know nothing of each other: each starts in setup
  // mode on a new database, and only the one that finishes the setup leaves it. Another one would show the setup page
  // again (the setup page sends the owner on to /login), and a second setup there would overwrite the wiki's settings,
  // fail (on PostgreSQL the users the first one made keep `locales` from being emptied), and then empty `settings`, so
  // every server would start in setup mode, where every setup fails the same way. So a setup runs
  // under Wiki.js's schema lock (server/db/tofu-data-api.js) and only on a wiki that has no settings yet, and a server
  // in setup mode that finds the settings another server saved starts as the wiki itself, as the server that finished
  // the setup does (below, at "Finalize").

  const tofuDataApi = require('./db/tofu-data-api')
  // finishing: this server's own setup is writing the wiki; started: this server is leaving setup mode for another's.
  const tofuSwitch = { checkedAt: 0, finishing: false, started: false }

  async function settingsSaved () {
    try {
      return Boolean(await WIKI.models.settings.getConfig())
    } catch (err) {
      return false
    }
  }

  // At most every 2 seconds, and under the lock, so that a setup another server is still writing is waited for and
  // its half-written wiki is never started here.
  async function setupDoneElsewhere () {
    if (tofuSwitch.finishing || tofuSwitch.started) {
      return true
    }
    if (Date.now() - tofuSwitch.checkedAt < 2000) {
      return false
    }
    tofuSwitch.checkedAt = Date.now()
    let trx = null
    try {
      trx = await WIKI.models.knex.transaction()
      await tofuDataApi.lockSchema(trx)
      return await settingsSaved()
    } catch (err) {
      return false
    } finally {
      if (trx) {
        try {
          await trx.commit()
        } catch (err) {}
      }
    }
  }

  function startAsWiki () {
    if (tofuSwitch.finishing || tofuSwitch.started) {
      return
    }
    tofuSwitch.started = true
    WIKI.logger.info('Another server of this wiki finished its setup. Stopping Setup...')
    WIKI.server.destroy(() => {
      _.delay(async () => {
        try {
          await WIKI.configSvc.loadFromDb()
          WIKI.config.setup = false
          WIKI.logger.info('Setup stopped. Starting Wiki.js...')
          WIKI.kernel.bootMaster()
        } catch (err) {
          WIKI.logger.error(`Could not start Wiki.js after another server's setup: ${err.message}`)
          process.exit(1)
        }
      }, 1000)
    })
  }

  function sendStarting (res, status, json) {
    res.set('Retry-After', '5')
    if (json) {
      res.status(status).json({ ok: false, error: 'This wiki has just been set up. Reload the page in a few seconds and sign in with the administrator’s email address and password.' })
    } else {
      res.status(status).send('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Wiki.js</title></head><body style="font-family:sans-serif;padding:2em">This wiki has just been set up. It opens in a few seconds.</body></html>')
    }
    res.on('finish', startAsWiki)
  }

  // ----------------------------------------
  // Define Express App
  // ----------------------------------------

  let app = express()
  app.use(compression())

  // ----------------------------------------
  // Public Assets
  // ----------------------------------------

  app.use(favicon(path.join(WIKI.ROOTPATH, 'assets', 'favicon.ico')))
  app.use('/_assets', express.static(path.join(WIKI.ROOTPATH, 'assets')))

  // ----------------------------------------
  // View Engine Setup
  // ----------------------------------------

  app.set('views', path.join(WIKI.SERVERPATH, 'views'))
  app.set('view engine', 'pug')

  app.use(bodyParser.json())
  app.use(bodyParser.urlencoded({ extended: false }))

  app.locals.config = WIKI.config
  app.locals.data = WIKI.data
  app.locals._ = require('lodash')
  app.locals.devMode = WIKI.devMode

  // ----------------------------------------
  // HMR (Dev Mode Only)
  // ----------------------------------------

  if (global.DEV) {
    app.use(global.WP_DEV.devMiddleware)
    app.use(global.WP_DEV.hotMiddleware)
  }

  // ----------------------------------------
  // Controllers
  // ----------------------------------------

  app.get('*', async (req, res) => {
    // Tofu (2026-10-26): another server finished the setup (above).
    if (await setupDoneElsewhere()) {
      return sendStarting(res, 503, false)
    }
    let packageObj = await fs.readJson(path.join(WIKI.ROOTPATH, 'package.json'))
    // Tofu (2026-10-25): whether the setup waits for ADMIN_PASSWORD, and this copy's source (above).
    res.render('setup', { packageObj, setupLock, sourceUrl })
  })

  /**
   * Finalize
   */
  app.post('/finalize', async (req, res) => {
    // Tofu (2026-10-25): only with the owner's ADMIN_PASSWORD (above).
    const refusal = await ownerRefusal(req.body)
    if (refusal) {
      return res.status(403).json({ ok: false, error: refusal })
    }
    // Tofu (2026-10-26): one setup at a time, under Wiki.js's schema lock, and none on a wiki that has its settings
    // (above). The lock is held by a transaction of its own until the setup has written everything; the setup's own
    // statements run on Wiki.js's other connections, as upstream's do.
    let setupLockTrx = null
    const releaseSetupLock = async () => {
      if (setupLockTrx) {
        const trx = setupLockTrx
        setupLockTrx = null
        try {
          await trx.commit()
        } catch (err) {}
      }
    }
    try {
      setupLockTrx = await WIKI.models.knex.transaction()
      await tofuDataApi.lockSchema(setupLockTrx)
    } catch (err) {
      await releaseSetupLock()
      return res.status(503).json({ ok: false, error: `The setup could not start: ${err.message}. Try again in a minute.` })
    }
    if (tofuSwitch.finishing || tofuSwitch.started || await settingsSaved()) {
      await releaseSetupLock()
      return sendStarting(res, 409, true)
    }
    tofuSwitch.finishing = true
    try {
      // Set config
      _.set(WIKI.config, 'auth', {
        audience: 'urn:wiki.js',
        tokenExpiration: '30m',
        tokenRenewal: '14d'
      })
      _.set(WIKI.config, 'company', '')
      _.set(WIKI.config, 'features', {
        featurePageRatings: true,
        featurePageComments: true,
        featurePersonalWikis: true
      })
      _.set(WIKI.config, 'graphEndpoint', 'https://graph.requarks.io')
      _.set(WIKI.config, 'host', req.body.siteUrl)
      _.set(WIKI.config, 'lang', {
        code: 'en',
        autoUpdate: true,
        namespacing: false,
        namespaces: []
      })
      _.set(WIKI.config, 'logo', {
        hasLogo: false,
        logoIsSquare: false
      })
      _.set(WIKI.config, 'mail', {
        senderName: '',
        senderEmail: '',
        host: '',
        port: 465,
        name: '',
        secure: true,
        verifySSL: true,
        user: '',
        pass: '',
        useDKIM: false,
        dkimDomainName: '',
        dkimKeySelector: '',
        dkimPrivateKey: ''
      })
      _.set(WIKI.config, 'seo', {
        description: '',
        robots: ['index', 'follow'],
        analyticsService: '',
        analyticsId: ''
      })
      _.set(WIKI.config, 'sessionSecret', (await randomBytesAsync(32)).toString('hex'))
      // Tofu (2026-10-25): telemetry stays off; the setup page no longer asks.
      _.set(WIKI.config, 'telemetry', {
        isEnabled: false,
        clientId: uuid()
      })
      _.set(WIKI.config, 'theming', {
        theme: 'default',
        darkMode: false,
        iconset: 'mdi',
        injectCSS: '',
        injectHead: '',
        injectBody: ''
      })
      _.set(WIKI.config, 'title', 'Wiki.js')

      // Init Telemetry
      WIKI.kernel.initTelemetry()
      // WIKI.telemetry.sendEvent('setup', 'install-start')

      // Basic checks
      if (!semver.satisfies(process.version, '>=10.12')) {
        throw new Error('Node.js 10.12.x or later required!')
      }

      // Create directory structure
      WIKI.logger.info('Creating data directories...')
      await fs.ensureDir(path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath))
      await fs.emptyDir(path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'cache'))
      await fs.ensureDir(path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'uploads'))

      // Generate certificates
      WIKI.logger.info('Generating certificates...')
      const certs = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
          type: 'pkcs1',
          format: 'pem'
        },
        privateKeyEncoding: {
          type: 'pkcs1',
          format: 'pem',
          cipher: 'aes-256-cbc',
          passphrase: WIKI.config.sessionSecret
        }
      })

      _.set(WIKI.config, 'certs', {
        jwk: pem2jwk(certs.publicKey),
        public: certs.publicKey,
        private: certs.privateKey
      })

      // Save config to DB
      WIKI.logger.info('Persisting config to DB...')
      await WIKI.configSvc.saveToDb([
        'auth',
        'certs',
        'company',
        'features',
        'graphEndpoint',
        'host',
        'lang',
        'logo',
        'mail',
        'seo',
        'sessionSecret',
        'telemetry',
        'theming',
        'uploads',
        'title'
      ], false)

      // Truncate tables (reset from previous failed install)
      await WIKI.models.locales.query().where('code', '!=', 'x').del()
      await WIKI.models.navigation.query().truncate()
      switch (WIKI.config.db.type) {
        case 'postgres':
          await WIKI.models.knex.raw('TRUNCATE groups, users CASCADE')
          break
        case 'mysql':
        case 'mariadb':
          await WIKI.models.groups.query().where('id', '>', 0).del()
          await WIKI.models.users.query().where('id', '>', 0).del()
          await WIKI.models.knex.raw('ALTER TABLE `groups` AUTO_INCREMENT = 1')
          await WIKI.models.knex.raw('ALTER TABLE `users` AUTO_INCREMENT = 1')
          break
        case 'mssql':
          await WIKI.models.groups.query().del()
          await WIKI.models.users.query().del()
          await WIKI.models.knex.raw(`
            IF EXISTS (SELECT * FROM sys.identity_columns WHERE OBJECT_NAME(OBJECT_ID) = 'groups' AND last_value IS NOT NULL)
              DBCC CHECKIDENT ([groups], RESEED, 0)
          `)
          await WIKI.models.knex.raw(`
            IF EXISTS (SELECT * FROM sys.identity_columns WHERE OBJECT_NAME(OBJECT_ID) = 'users' AND last_value IS NOT NULL)
              DBCC CHECKIDENT ([users], RESEED, 0)
          `)
          break
        case 'sqlite':
          await WIKI.models.groups.query().truncate()
          await WIKI.models.users.query().truncate()
          break
      }

      // Create default locale
      WIKI.logger.info('Installing default locale...')
      await WIKI.models.locales.query().insert({
        code: 'en',
        strings: {},
        isRTL: false,
        name: 'English',
        nativeName: 'English'
      })

      // Create default groups

      WIKI.logger.info('Creating default groups...')
      const adminGroup = await WIKI.models.groups.query().insert({
        name: 'Administrators',
        permissions: JSON.stringify(['manage:system']),
        pageRules: JSON.stringify([]),
        isSystem: true
      })
      const guestGroup = await WIKI.models.groups.query().insert({
        name: 'Guests',
        permissions: JSON.stringify(['read:pages', 'read:assets', 'read:comments']),
        pageRules: JSON.stringify([
          { id: 'guest', roles: ['read:pages', 'read:assets', 'read:comments'], match: 'START', deny: false, path: '', locales: [] }
        ]),
        isSystem: true
      })
      if (adminGroup.id !== 1 || guestGroup.id !== 2) {
        throw new Error('Incorrect groups auto-increment configuration! Should start at 0 and increment by 1. Contact your database administrator.')
      }

      // Load local authentication strategy
      await WIKI.models.authentication.query().insert({
        key: 'local',
        config: {},
        selfRegistration: false,
        isEnabled: true,
        domainWhitelist: {v: []},
        autoEnrollGroups: {v: []},
        order: 0,
        strategyKey: 'local',
        displayName: 'Local'
      })

      // Load editors + enable default
      await WIKI.models.editors.refreshEditorsFromDisk()
      await WIKI.models.editors.query().patch({ isEnabled: true }).where('key', 'markdown')

      // Load loggers
      await WIKI.models.loggers.refreshLoggersFromDisk()

      // Load renderers
      await WIKI.models.renderers.refreshRenderersFromDisk()

      // Load search engines + enable default
      await WIKI.models.searchEngines.refreshSearchEnginesFromDisk()
      await WIKI.models.searchEngines.query().patch({ isEnabled: true }).where('key', 'db')

      // WIKI.telemetry.sendEvent('setup', 'install-loadedmodules')

      // Load storage targets
      await WIKI.models.storage.refreshTargetsFromDisk()

      // Create root administrator
      WIKI.logger.info('Creating root administrator...')
      const adminUser = await WIKI.models.users.query().insert({
        email: req.body.adminEmail.toLowerCase(),
        provider: 'local',
        password: req.body.adminPassword,
        name: 'Administrator',
        locale: 'en',
        defaultEditor: 'markdown',
        tfaIsActive: false,
        isActive: true,
        isVerified: true
      })
      await adminUser.$relatedQuery('groups').relate(adminGroup.id)

      // Create Guest account
      WIKI.logger.info('Creating guest account...')
      const guestUser = await WIKI.models.users.query().insert({
        provider: 'local',
        email: 'guest@example.com',
        name: 'Guest',
        password: '',
        locale: 'en',
        defaultEditor: 'markdown',
        tfaIsActive: false,
        isSystem: true,
        isActive: true,
        isVerified: true
      })
      await guestUser.$relatedQuery('groups').relate(guestGroup.id)
      if (adminUser.id !== 1 || guestUser.id !== 2) {
        throw new Error('Incorrect users auto-increment configuration! Should start at 0 and increment by 1. Contact your database administrator.')
      }

      // Create site nav

      WIKI.logger.info('Creating default site navigation')
      await WIKI.models.navigation.query().insert({
        key: 'site',
        config: [
          {
            locale: 'en',
            items: [
              {
                id: uuid(),
                icon: 'mdi-home',
                kind: 'link',
                label: 'Home',
                target: '/',
                targetType: 'home',
                visibilityMode: 'all',
                visibilityGroups: null
              }
            ]
          }
        ]
      })

      WIKI.logger.info('Setup is complete!')
      // Tofu (2026-10-26): everything is written: another setup may look now, and it finds the settings (above).
      await releaseSetupLock()
      // WIKI.telemetry.sendEvent('setup', 'install-completed')
      res.json({
        ok: true,
        redirectPath: '/',
        redirectPort: WIKI.config.port
      }).end()

      if (WIKI.config.telemetry.isEnabled) {
        await WIKI.telemetry.sendInstanceEvent('INSTALL')
      }

      WIKI.config.setup = false

      WIKI.logger.info('Stopping Setup...')
      WIKI.server.destroy(() => {
        WIKI.logger.info('Setup stopped. Starting Wiki.js...')
        _.delay(() => {
          WIKI.kernel.bootMaster()
        }, 1000)
      })
    } catch (err) {
      try {
        await WIKI.models.knex('settings').truncate()
      } catch (err) {}
      // Tofu (2026-10-26): the failed setup is undone (above); the next one may start.
      tofuSwitch.finishing = false
      await releaseSetupLock()
      WIKI.telemetry.sendError(err)
      res.json({ ok: false, error: err.message })
    }
  })

  // ----------------------------------------
  // Error handling
  // ----------------------------------------

  app.use(function (req, res, next) {
    const err = new Error('Not Found')
    err.status = 404
    next(err)
  })

  app.use(function (err, req, res, next) {
    res.status(err.status || 500)
    res.send({
      message: err.message,
      error: WIKI.IS_DEBUG ? err : {}
    })
    WIKI.logger.error(err.message)
    WIKI.telemetry.sendError(err)
  })

  // ----------------------------------------
  // Start HTTP server
  // ----------------------------------------

  WIKI.logger.info(`Starting HTTP server on port ${WIKI.config.port}...`)

  app.set('port', WIKI.config.port)

  WIKI.logger.info(`HTTP Server on port: [ ${WIKI.config.port} ]`)
  WIKI.server = http.createServer(app)
  WIKI.server.listen(WIKI.config.port, WIKI.config.bindIP)

  var openConnections = []

  WIKI.server.on('connection', (conn) => {
    let key = conn.remoteAddress + ':' + conn.remotePort
    openConnections[key] = conn
    conn.on('close', () => {
      openConnections.splice(key, 1)
    })
  })

  WIKI.server.destroy = (cb) => {
    WIKI.server.close(cb)
    for (let key in openConnections) {
      openConnections[key].destroy()
    }
  }

  WIKI.server.on('error', (error) => {
    if (error.syscall !== 'listen') {
      throw error
    }

    switch (error.code) {
      case 'EACCES':
        WIKI.logger.error('Listening on port ' + WIKI.config.port + ' requires elevated privileges!')
        return process.exit(1)
      case 'EADDRINUSE':
        WIKI.logger.error('Port ' + WIKI.config.port + ' is already in use!')
        return process.exit(1)
      default:
        throw error
    }
  })

  WIKI.server.on('listening', () => {
    WIKI.logger.info('HTTP Server: [ RUNNING ]')
    WIKI.logger.info('🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻')
    WIKI.logger.info('')
    WIKI.logger.info(`Browse to http://YOUR-SERVER-IP:${WIKI.config.port}/ to complete setup!`)
    WIKI.logger.info('')
    WIKI.logger.info('🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺')
  })
}
