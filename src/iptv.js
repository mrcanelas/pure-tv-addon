const axios = require('axios')
const { parseM3U } = require('@iptv/playlist')
const epgParser = require('epg-parser')
const { decode } = require('html-entities')

function stableId(input) {
	let h = 2166136261
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return (h >>> 0).toString(36)
}

function pickFirstText(node) {
	if (!node) return null
	if (typeof node === 'string') return decode(node.trim()) || null
	if (Array.isArray(node)) return pickFirstText(node[0])

	if (typeof node === 'object') {
		if (node instanceof Date) return node.toISOString()
		if (typeof node.value === 'string') return decode(node.value.trim()) || null
		if (typeof node._ === 'string') return decode(node._.trim()) || null
	}

	return null
}

function parseXmltvDate(dateStr) {
	if (!dateStr) return null
	if (dateStr instanceof Date) return dateStr
	if (typeof dateStr === 'number') return new Date(dateStr)
	if (typeof dateStr !== 'string') return null
	const s = dateStr.trim()

	// epg-parser normalmente retorna ISO (ex: 2026-03-18T22:12:00.000Z)
	// então tentamos um parse padrão antes do formato XMLTV clássico.
	const iso = Date.parse(s)
	if (!Number.isNaN(iso)) return new Date(iso)

	const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/)
	if (!m) return null

	const [, Y, Mo, D, H, Mi, Se, sign, tzh, tzm] = m
	const utc = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +Se)
	let offsetMin = 0
	if (sign && tzh && tzm) {
		offsetMin = (+tzh) * 60 + (+tzm)
		if (sign === '+') offsetMin = -offsetMin
	}
	return new Date(utc + offsetMin * 60 * 1000)
}

async function fetchText(url) {
	const resp = await axios.get(url, { responseType: 'text', transformResponse: r => r })
	return resp.data
}

async function loadPlaylist({ m3uUrl, m3uText }) {
	const text = m3uText || (m3uUrl ? await fetchText(m3uUrl) : null)
	if (!text) throw new Error('M3U vazio')
	return parseM3U(text)
}

async function loadXmltv({ xmltvUrl, xmltvText }) {
	const text = xmltvText || (xmltvUrl ? await fetchText(xmltvUrl) : null)
	if (!text) throw new Error('XMLTV vazio')
	return epgParser.parse(text)
}

function buildLinks({ genres = [], cast = [] }) {
	const links = []
	for (const g of genres) {
		links.push({
			category: 'Genres',
			name: g,
			url: `stremio:///search?search=${encodeURIComponent(g)}`,
		})
	}
	for (const c of cast) {
		links.push({
			category: 'Cast',
			name: c,
			url: `stremio:///search?search=${encodeURIComponent(c)}`,
		})
	}
	return links
}

function normalizePoster(url) {
	if (!url) return null
	if (typeof url !== 'string') return null
	return url.trim() || null
}

function normKey(s) {
	if (!s || typeof s !== 'string') return ''
	return s
		.trim()
		.toLowerCase()
		.replace(/&amp;/gi, '&')
		.replace(/\s+/g, ' ')
		.trim()
}

function m3uChannelsToMetas(prefix, channels) {
	return channels.map((ch) => {
		const key = `${ch.tvgId || ''}|${ch.tvgName || ''}|${ch.name || ''}|${ch.url || ''}`
		const id = `${prefix}${stableId(key)}`
		const name = ch.tvgName || ch.name || ch.tvgId || 'Canal'
		const poster = normalizePoster(ch.tvgLogo || (ch.extras && (ch.extras['tvg-logo'] || ch.extras['logo'])) || null)
		return {
			id,
			type: 'tv',
			name,
			poster: poster && `https://da5f663b4690-proxyimage.baby-beamup.club/proxy-image/?url=${poster}`,
			posterShape: 'landscape',
		}
	})
}

function buildChannelIndex(prefix, playlist) {
	const idToChannel = new Map()
	const tvgKeyToId = new Map()

	for (const ch of playlist.channels || []) {
		const key = `${ch.tvgId || ''}|${ch.tvgName || ''}|${ch.name || ''}|${ch.url || ''}`
		const id = `${prefix}${stableId(key)}`
		idToChannel.set(id, ch)

		const tvgId = (ch.tvgId || '').trim()
		const tvgName = (ch.tvgName || '').trim()
		const name = (ch.name || '').trim()

		if (tvgId) tvgKeyToId.set(tvgId, id)
		if (tvgName) tvgKeyToId.set(tvgName, id)
		if (name) tvgKeyToId.set(name, id)
	}

	return { idToChannel, tvgKeyToId }
}

function programToVideo(channelId, p) {
	const start = parseXmltvDate(p.start)
	const stop = parseXmltvDate(p.stop)
	if (!start || isNaN(start) || !stop || isNaN(stop)) return null

	const title = pickFirstText(p.title) || 'Program'
	const subtitle = pickFirstText(p['sub-title']) || pickFirstText(p.subTitle) || undefined
	const overview = pickFirstText(p.desc) || undefined
	const icon = p.icon && (Array.isArray(p.icon) ? p.icon[0] : p.icon)
	const thumbnail = (icon && icon.src) ? icon.src : undefined
	const durationMinutes = Math.round((stop.getTime() - start.getTime()) / (60 * 1000))
	// the original air date is optional in XMLTV and only feeds releaseInfo;
	// `released` must mirror startTime - stremio features key on it
	const airDate = p.date ? parseXmltvDate(p.date) : null
	const releaseInfo = airDate && !isNaN(airDate) ? String(airDate.getUTCFullYear()) : undefined

	const categories = []
	if (p.category) {
		const arr = Array.isArray(p.category) ? p.category : [p.category]
		for (const c of arr) {
			const v = pickFirstText(c)
			if (v) categories.push(v)
		}
	}

	const cast = []
	const directors = []
	const credits = p.credits
	if (credits) {
		const actors = credits.actor ? (Array.isArray(credits.actor) ? credits.actor : [credits.actor]) : []
		for (const a of actors) {
			const v = pickFirstText(a)
			if (v) cast.push(v)
		}
		const dirs = credits.director ? (Array.isArray(credits.director) ? credits.director : [credits.director]) : []
		for (const d of dirs) {
			const v = pickFirstText(d)
			if (v) directors.push(v)
		}
	}

	return {
		id: `${channelId}:${stableId(title + start.toISOString())}`,
		title,
		subtitle: subtitle,
		released: start.toISOString(),
		releaseInfo,
		runtime: durationMinutes > 0 ? `${durationMinutes} min` : undefined,
		overview: overview,
		thumbnail: thumbnail,
		startTime: start.toISOString(),
		endTime: stop.toISOString(),
		genres: categories.length ? categories : undefined,
		cast: cast.length ? cast : undefined,
		directors: directors.length ? directors : undefined,
		links: buildLinks({ genres: categories, cast }),
	}
}

// Resolves every channel's XMLTV id candidates and buckets all programs
// into a Map<channelId, videos sorted by startTime> in a single pass.
// Built once per getState() cache entry so the catalog handler can serve
// programs for a whole page of channels without rescanning the XMLTV.
function buildProgramIndex(xmltv, index) {
	const progs =
		(xmltv && Array.isArray(xmltv.programs) && xmltv.programs) ||
		(xmltv && Array.isArray(xmltv.programmes) && xmltv.programmes) ||
		[]

	const displayNameToXmltvId = new Map()
	if (Array.isArray(xmltv.channels)) {
		for (const c of xmltv.channels) {
			if (!c || !c.id) continue
			const dns = c['display-name']
			const arr = !dns ? [] : (Array.isArray(dns) ? dns : [dns])
			for (const dn of arr) {
				const name = ((dn && (dn.value || dn._)) || '').trim()
				if (name) displayNameToXmltvId.set(normKey(name), String(c.id).trim())
			}
		}
	}

	const keyToChannelId = new Map()
	const buckets = new Map()
	for (const [id, ch] of index.idToChannel) {
		buckets.set(id, [])
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
		for (const candidate of Array.from(candidates)) {
			const xmltvId = displayNameToXmltvId.get(normKey(candidate))
			if (xmltvId) candidates.add(xmltvId)
		}
		for (const candidate of candidates) {
			const key = normKey(candidate)
			if (key && !keyToChannelId.has(key)) keyToChannelId.set(key, id)
		}
	}

	for (const p of progs) {
		const id = keyToChannelId.get(normKey(p.channel || ''))
		if (!id) continue
		const video = programToVideo(id, p)
		if (video) buckets.get(id).push(video)
	}

	// fuzzy fallback, only for channels the exact pass left empty
	for (const [id, videos] of buckets) {
		if (videos.length) continue
		const wanted = []
		for (const [key, channelId] of keyToChannelId) {
			if (channelId === id && key.length >= 5) wanted.push(key)
		}
		if (!wanted.length) continue
		for (const p of progs) {
			const pc = normKey(p.channel || '')
			if (!pc) continue
			if (wanted.some((w) => pc.includes(w) || w.includes(pc))) {
				const video = programToVideo(id, p)
				if (video) videos.push(video)
			}
		}
	}

	for (const videos of buckets.values()) {
		videos.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
	}

	return buckets
}

module.exports = {
	stableId,
	loadPlaylist,
	loadXmltv,
	m3uChannelsToMetas,
	buildChannelIndex,
	buildProgramIndex,
}

