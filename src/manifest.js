const ADDON_PREFIX = "pure:"

const manifest = {
    id: "pure-tv-addon",
    version: "0.0.1",
    name: "PureTV",
    description: "The first native EPG (Electronic Program Guide) solution for Stremio. This addon introduces a high-performance, interactive TV grid that transforms your Live TV experience.",
    catalogs: [
        {
            type: 'tv', id: `${ADDON_PREFIX}catalog`, name: 'PureTV', extra: [{
                name: 'date'
            }, {
                name: 'skip'
            }]
        }
    ],
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: [ADDON_PREFIX],
    behaviorHints: {
        configurable: true,
        epgProvider: true,
    },
}

module.exports = manifest