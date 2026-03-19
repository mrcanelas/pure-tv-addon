const { addonBuilder } = require("stremio-addon-sdk")
const manifest = require("./src/manifest")

const { decodeConfig, isEncodedConfig } = require('./src/configCodec')
const {
	loadPlaylist,
	loadXmltv,
	m3uChannelsToMetas,
	buildChannelIndex,
	xmltvToVideosForChannel,
} = require('./src/iptv')

const ADDON_PREFIX = 'pure:'

const cache = new Map()
const CACHE_MS = 2 * 60 * 1000

async function getState(cfg) {
	const now = Date.now()
	const hit = cache.get(cfg)
	if (hit && now - hit.at < CACHE_MS) return hit.state

	if (!isEncodedConfig(cfg)) throw new Error('Config inválida (esperado formato inline c_...)')
	const cfgData = decodeConfig(cfg)
	const playlist = await loadPlaylist(cfgData)
	const xmltv = await loadXmltv(cfgData)
	const index = buildChannelIndex(ADDON_PREFIX, playlist)

	const state = { cfgData, playlist, xmltv, index }
	cache.set(cfg, { at: now, state })
	return state
}

const builder = new addonBuilder(manifest)

const CATALOG_PAGE_SIZE = 20

builder.defineCatalogHandler(({type, id, extra}) => {
	return (async () => {
		if (type !== 'tv' || id !== 'epg') return { metas: [] }
		const cfg = extra && extra.__cfg
		if (!cfg) return { metas: [] }

		const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0)

		const { playlist } = await getState(cfg)
		const allMetas = m3uChannelsToMetas(ADDON_PREFIX, playlist.channels || [])
		const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE)
		return {
			metas,
			// cache curto para o EPG/plalist mudar sem travar o usuário
			cacheMaxAge: 300, // 5 min
			staleRevalidate: 1800, // 30 min
			staleError: 604800, // 7 dias
		}
	})()
})

builder.defineMetaHandler(({type, id, extra}) => {
	return (async () => {
		if (id.startsWith(ADDON_PREFIX)) return { meta: null }
		const cfg = extra && extra.__cfg
		if (!cfg) return { meta: null }

		const { xmltv, index } = await getState(cfg)
		const ch = index.idToChannel.get(id)
		if (!ch) return { meta: null }

		const displayName = ch.tvgName || ch.name || ch.tvgId || 'Canal'
		const poster = `https://da5f663b4690-proxyimage.baby-beamup.club/proxy-image/?url=${ch.tvgLogo || (ch.extras && (ch.extras['tvg-logo'] || ch.extras['logo'])) || undefined}`

		const candidates = new Set()
		for (const v of [
			ch.tvgId,
			ch.tvgName,
			ch.name,
			ch.extras && ch.extras['tvg-id'],
			ch.extras && ch.extras['tvg-name'],
		]) {
			if (typeof v === 'string' && v.trim()) candidates.add(v.trim())
		}

		if (Array.isArray(xmltv.channels) && candidates.size) {
			for (const c of xmltv.channels) {
				const dns = c['display-name']
				const arr = !dns ? [] : (Array.isArray(dns) ? dns : [dns])
				const names = arr.map((dn) => ((dn && (dn.value || dn._)) || '').trim()).filter(Boolean)
				if (!names.length) continue
				const hit = names.some((n) => candidates.has(n))
				if (hit && c.id) candidates.add(String(c.id).trim())
			}
		}

		const videos = xmltvToVideosForChannel(xmltv, id, Array.from(candidates))

		return {
			meta: {
				id,
				type: 'tv',
				name: displayName,
				logo: poster,
				poster,
				posterShape: 'square',
				videos,
			},
			cacheMaxAge: 900, // 15 min
			staleRevalidate: 3600, // 1h
			staleError: 604800, // 7 dias
		}
	})()
})

builder.defineStreamHandler(({type, id, extra}) => {
	return (async () => {
		if (id.startsWith(ADDON_PREFIX)) return { streams: [] }
		const cfg = extra && extra.__cfg
		if (!cfg) return { streams: [] }

		const { index } = await getState(cfg)
		const ch = index.idToChannel.get(`${ADDON_PREFIX}${id.split(':')[1]}`)
		if (!ch || !ch.url) return { streams: [] }

		const name = ch.tvgName || ch.name || 'Live'
		return {
			streams: [
				{
					name: 'PureTV',
					title: name,
					url: ch.url,
				},
			],
			cacheMaxAge: 3600, // 1h
			staleRevalidate: 7200, // 2h
			staleError: 604800, // 7 dias
		}
	})()
})

module.exports = builder.getInterface()