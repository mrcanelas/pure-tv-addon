const { addonBuilder } = require("stremio-addon-sdk")
const manifest = require("./src/manifest")

const { decodeConfig, isEncodedConfig } = require('./src/configCodec')
const {
	loadPlaylist,
	loadXmltv,
	m3uChannelsToMetas,
	buildChannelIndex,
	buildProgramIndex,
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
	// channel -> programs, resolved once so the catalog handler can serve
	// a whole page of channels without rescanning the XMLTV per channel
	const programs = buildProgramIndex(xmltv, index)

	const state = { cfgData, playlist, xmltv, index, programs }
	cache.set(cfg, { at: now, state })
	return state
}

const builder = new addonBuilder(manifest)

const CATALOG_PAGE_SIZE = 50

// [dayStartMs, dayEndMs) of the requested UTC day, defaulting to today
function utcDayWindow(dateStr) {
	const day = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')
		? dateStr
		: new Date().toISOString().slice(0, 10)
	const startMs = Date.parse(`${day}T00:00:00.000Z`)
	return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 }
}

// programs overlapping the day window (midnight-spanning shows included)
function videosForDay(videos, { startMs, endMs }) {
	return videos.filter((v) =>
		Date.parse(v.startTime) < endMs && Date.parse(v.endTime) > startMs)
}

builder.defineCatalogHandler(({type, id, extra}) => {
	return (async () => {
		if (!id.startsWith(ADDON_PREFIX)) return { metas: [] }
		const cfg = extra && extra.__cfg
		if (!cfg) return { metas: [] }

		const skip = Math.max(0, parseInt(extra && extra.skip, 10) || 0)

		const { playlist, programs } = await getState(cfg)
		const allMetas = m3uChannelsToMetas(ADDON_PREFIX, playlist.channels || [])
		const metas = allMetas.slice(skip, skip + CATALOG_PAGE_SIZE)
		const cacheHeaders = {
			// cache curto para o EPG/plalist mudar sem travar o usuário
			cacheMaxAge: 300, // 5 min
			staleRevalidate: 1800, // 30 min
			staleError: 604800, // 7 dias
		}

		// EPG guide requests: stremio-core always sends the `date` extra to
		// epgProvider addons and expects the channels with the day's
		// programs under `metasDetailed`; requests without `date` keep the
		// legacy format so older clients are unaffected
		if (extra && typeof extra.date !== 'undefined') {
			const day = utcDayWindow(extra.date)
			return {
				metasDetailed: metas.map((meta) => ({
					...meta,
					behaviorHints: { hasScheduledVideos: true },
					videos: videosForDay(programs.get(meta.id) || [], day),
				})),
				...cacheHeaders,
			}
		}

		return { metas, ...cacheHeaders }
	})()
})

builder.defineMetaHandler(({type, id, extra}) => {
	return (async () => {
		if (!id.startsWith(ADDON_PREFIX)) return { meta: null }
		const cfg = extra && extra.__cfg
		if (!cfg) return { meta: null }

		const { index, programs } = await getState(cfg)
		const ch = index.idToChannel.get(id)
		if (!ch) return { meta: null }

		const displayName = ch.tvgName || ch.name || ch.tvgId || 'Canal'
		const poster = `https://da5f663b4690-proxyimage.baby-beamup.club/proxy-image/?url=${ch.tvgLogo || (ch.extras && (ch.extras['tvg-logo'] || ch.extras['logo'])) || undefined}`

		return {
			meta: {
				id,
				type: 'tv',
				name: displayName,
				logo: poster,
				poster,
				posterShape: 'landscape',
				behaviorHints: { hasScheduledVideos: true },
				// the full multi-day program - the guide grid uses the
				// catalog with the `date` extra instead
				videos: programs.get(id) || [],
			},
			cacheMaxAge: 900, // 15 min
			staleRevalidate: 3600, // 1h
			staleError: 604800, // 7 dias
		}
	})()
})

builder.defineStreamHandler(({type, id, extra}) => {
	return (async () => {
		if (!id.startsWith(ADDON_PREFIX)) return { streams: [] }
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
					// IPTV sources are usually not CORS/HLS-safe for the web
					// player - let clients route to an external player
					behaviorHints: { notWebReady: true },
				},
			],
			cacheMaxAge: 3600, // 1h
			staleRevalidate: 7200, // 2h
			staleError: 604800, // 7 dias
		}
	})()
})

module.exports = builder.getInterface()