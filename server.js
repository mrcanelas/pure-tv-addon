#!/usr/bin/env node

const express = require('express')

const { encodeConfig } = require('./src/configCodec')
const serverless = require('./src/serverless')

const PORT = process.env.PORT || 63033

const app = express()
app.use(express.json({ limit: '25mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static('static', { maxAge: '1y' }))

function absoluteUrl(req, pathname) {
	const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim()
	const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
	return `${proto}://${host}${pathname}`
}

app.post('/api/config', async (req, res) => {
	try {
		const { m3uUrl, xmltvUrl, m3uText, xmltvText } = req.body || {}

		if (m3uText || xmltvText) {
			res.status(400).json({ error: 'Somente URLs são suportadas.' })
			return
		}
		if (!m3uUrl || typeof m3uUrl !== 'string' || !m3uUrl.trim()) {
			res.status(400).json({ error: 'Informe a URL do M3U.' })
			return
		}
		if (!xmltvUrl || typeof xmltvUrl !== 'string' || !xmltvUrl.trim()) {
			res.status(400).json({ error: 'Informe a URL do XMLTV.' })
			return
		}

		const plainConfig = { m3uUrl: m3uUrl.trim(), xmltvUrl: xmltvUrl.trim(), m3uText: null, xmltvText: null }
		const jsonSize = Buffer.byteLength(JSON.stringify(plainConfig), 'utf8')

		const MAX_INLINE_BYTES = 6000

		if (jsonSize > MAX_INLINE_BYTES) {
			res.status(400).json({
				error: 'Configuração muito grande para embutir no link. Use URLs (M3U/XMLTV) ao invés de upload de arquivo.',
			})
			return
		}

		const cfg = encodeConfig(plainConfig)

		const manifestUrl = absoluteUrl(req, `/${cfg}/manifest.json`)
		const installUrl = `stremio://${manifestUrl.replace(/^https?:\/\//i, '')}`
		res.json({ cfg, manifestUrl, installUrl, mode: 'inline' })
	} catch (err) {
		console.error(err)
		res.status(500).json({ error: 'Erro interno ao salvar configuração.' })
	}
})

app.use((req, res, next) => serverless(req, res, next))

const server = app.listen(PORT, () => {
	console.log('PureTV rodando em:', `http://127.0.0.1:${PORT}/configure`)
})

server.on('error', (err) => {
	console.error('Falha ao iniciar servidor (verifique a porta/ambiente). Erro:', err)
})
