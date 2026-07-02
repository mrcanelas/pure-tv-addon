// Smoke test for the EPG core-alignment changes. Not part of the addon -
// run with `node smoke-test.js` and delete afterwards.
const assert = require('node:assert')
const { encodeConfig } = require('./src/configCodec')
const addonInterface = require('./addon')

const m3uText = `#EXTM3U
#EXTINF:-1 tvg-id="axn.br" tvg-name="AXN" tvg-logo="http://logo/axn.png",AXN
http://cdn.example.com/axn/master.m3u8
#EXTINF:-1 tvg-id="amc.br" tvg-name="AMC" tvg-logo="http://logo/amc.png",AMC
http://cdn.example.com/amc/master.m3u8
`

const xmltvText = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="axn.br"><display-name>AXN</display-name></channel>
  <channel id="amc.br"><display-name>AMC</display-name></channel>
  <programme start="20260702103000 +0000" stop="20260702115500 +0000" channel="axn.br">
    <title>S.W.A.T.</title>
    <desc>Lorem ipsum dolor sit amet.</desc>
    <date>20180101</date>
    <category>Acao</category>
    <credits><actor>Shemar Moore</actor><director>Justin Lin</director></credits>
  </programme>
  <programme start="20260702115500 +0000" stop="20260702122300 +0000" channel="axn.br">
    <title>Spy x Family</title>
  </programme>
  <programme start="20260701110000 +0000" stop="20260701120000 +0000" channel="axn.br">
    <title>Old Show From Yesterday</title>
  </programme>
  <programme start="20260702112500 +0000" stop="20260702133500 +0000" channel="amc.br">
    <title>Tomb Raider</title>
  </programme>
</tv>
`

async function main() {
	const cfg = encodeConfig({ m3uText, xmltvText })

	// 1. guide request (date extra) -> metasDetailed with the day's programs
	const guide = await addonInterface.get('catalog', 'tv', 'pure:catalog', {
		__cfg: cfg,
		date: '2026-07-02',
	})
	assert(Array.isArray(guide.metasDetailed), 'guide response must use metasDetailed')
	assert(!guide.metas, 'guide response must not carry metas alongside metasDetailed')
	assert.strictEqual(guide.metasDetailed.length, 2, 'both channels expected')

	const axn = guide.metasDetailed.find((m) => m.name === 'AXN')
	assert(axn, 'AXN channel expected')
	assert.strictEqual(axn.type, 'tv')
	assert.strictEqual(axn.behaviorHints.hasScheduledVideos, true)
	assert.strictEqual(
		axn.videos.length,
		2,
		"only the requested day's programs expected (yesterday's show filtered out)"
	)
	assert.deepStrictEqual(
		axn.videos.map((v) => v.title),
		['S.W.A.T.', 'Spy x Family'],
		'programs must be sorted by start time'
	)

	const swat = axn.videos[0]
	assert.strictEqual(swat.startTime, '2026-07-02T10:30:00.000Z')
	assert.strictEqual(swat.endTime, '2026-07-02T11:55:00.000Z')
	assert.strictEqual(swat.released, swat.startTime, 'released must mirror startTime')
	assert.strictEqual(swat.releaseInfo, '2018', 'releaseInfo keeps the original air year')
	assert.strictEqual(swat.runtime, '85 min')
	assert.deepStrictEqual(swat.genres, ['Acao'])
	assert.deepStrictEqual(swat.cast, ['Shemar Moore'])
	assert.deepStrictEqual(swat.directors, ['Justin Lin'])

	// program without an XMLTV <date> must not crash and has no releaseInfo
	const spy = axn.videos[1]
	assert.strictEqual(spy.releaseInfo, undefined)
	assert.strictEqual(spy.released, spy.startTime)

	// midnight-independent day filtering for the other channel
	const amc = guide.metasDetailed.find((m) => m.name === 'AMC')
	assert.strictEqual(amc.videos.length, 1)

	// 2. request without a date -> legacy metas (older clients unaffected)
	const legacy = await addonInterface.get('catalog', 'tv', 'pure:catalog', { __cfg: cfg })
	assert(Array.isArray(legacy.metas), 'legacy response must keep metas')
	assert(!legacy.metasDetailed, 'legacy response must not switch format')
	assert.strictEqual(legacy.metas.length, 2)

	// 3. per-channel meta -> full multi-day program + hasScheduledVideos
	const meta = await addonInterface.get('meta', 'tv', axn.id, { __cfg: cfg })
	assert.strictEqual(meta.meta.behaviorHints.hasScheduledVideos, true)
	assert.strictEqual(meta.meta.videos.length, 3, 'meta keeps the full multi-day program')

	// 4. stream for a show id resolves to the channel stream, notWebReady
	const showStream = await addonInterface.get('stream', 'tv', swat.id, { __cfg: cfg })
	assert.strictEqual(showStream.streams.length, 1)
	assert.strictEqual(showStream.streams[0].url, 'http://cdn.example.com/axn/master.m3u8')
	assert.strictEqual(showStream.streams[0].behaviorHints.notWebReady, true)

	console.log('smoke test passed')
	console.log('\n--- sample guide response (first channel) ---')
	console.log(JSON.stringify(axn, null, 2))
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
