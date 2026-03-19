const Router = require('router')
const cors = require('cors')
const qs = require('querystring')

const addonInterface = require('../addon')
const landingTemplate = require('./landingTemplate')
const { isEncodedConfig } = require('./configCodec')

const router = new Router()

router.use(cors())

router.get('/', (_, res) => {
	res.redirect(302, '/configure')
})

router.get('/configure', (_, res) => {
	res.setHeader('content-type', 'text/html; charset=utf-8')
	res.end(landingTemplate())
})

router.get('/:cfg/configure', (_, res) => {
	res.setHeader('content-type', 'text/html; charset=utf-8')
	res.end(landingTemplate())
})

router.get('{/:cfg}/manifest.json', async (req, res) => {
	try {
		const cfg = req.params.cfg || ''
		if (cfg && !isEncodedConfig(cfg)) throw new Error('cfg must be inline')
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		// Manifest é estático (independente da config), então pode ficar em cache.
		// max-age=12h, stale-while-revalidate=7d, stale-if-error=30d
		res.setHeader(
			'Cache-Control',
			'public, max-age=43200, stale-while-revalidate=604800, stale-if-error=2592000'
		)
		res.end(JSON.stringify(addonInterface.manifest))
	} catch {
		res.statusCode = 404
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.setHeader('Cache-Control', 'no-store')
		res.end(JSON.stringify({ error: 'Config não encontrada. Gere um link em /configure.' }))
	}
})

router.get('{/:cfg}/:resource/:type/:id{/:extra}.json', async (req, res, next) => {
	try {
		const { cfg = '', resource, type, id } = req.params

		if (cfg && !isEncodedConfig(cfg)) throw new Error('cfg must be inline')

		// mesmo truque do Brazuca: parsear extra do "último segmento" (skip=..&search=..)
		const extra =
			req.params.extra
				? qs.parse(req.url.split('/').pop().slice(0, -5))
				: {}

		const resp = await addonInterface.get(resource, type, id, { ...extra, __cfg: cfg })
		const { cacheMaxAge, staleRevalidate, staleError, ...payload } = resp || {}

		// Headers de cache (útil para proxies/CDNs que suportam stale-while-revalidate/stale-if-error)
		const cacheParts = []
		if (Number.isInteger(cacheMaxAge)) cacheParts.push(`max-age=${cacheMaxAge}`)
		if (Number.isInteger(staleRevalidate)) cacheParts.push(`stale-while-revalidate=${staleRevalidate}`)
		if (Number.isInteger(staleError)) cacheParts.push(`stale-if-error=${staleError}`)
		if (cacheParts.length) res.setHeader('Cache-Control', `public, ${cacheParts.join(', ')}`)
		else res.setHeader('Cache-Control', 'no-store')

		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.end(JSON.stringify(payload))
	} catch (err) {
		if (err && err.noHandler) {
			if (next) next()
			else {
				res.statusCode = 404
				res.end(JSON.stringify({ err: 'not found' }))
			}
			return
		}
		console.error(err)
		res.statusCode = 500
		res.end(JSON.stringify({ err: 'handler error' }))
	}
})

module.exports = function serverless(req, res, next) {
	router(req, res, function () {
		if (next) next()
		else {
			res.statusCode = 404
			res.end()
		}
	})
}

